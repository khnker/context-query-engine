# ContextForge

**Motor de retrieval y gestión de contexto para agentes LLM.** Convierte la búsqueda de contexto en una consulta optimizable: interpreta lo que el agente necesita, planifica cómo obtenerlo y devuelve solo el contexto útil dentro de un presupuesto de tokens.

## Tabla de contenidos

- [¿Qué es?](#qué-es)
- [Estado actual](#estado-actual)
- [Arquitectura](#arquitectura)
- [Componentes](#componentes)
- [Cómo funciona](#cómo-funciona)
- [Instalación](#instalación)
- [Uso](#uso)
- [Benchmark: ahorro de contexto](#benchmark-ahorro-de-contexto)
- [Roadmap](#roadmap)
- [Estructura del repo](#estructura-del-repo)
- [Licencia](#licencia)

> Read this in [English](README.md)

---

## ¿Qué es?

Un agente LLM que trabaja sobre un codebase gasta la mayor parte de su ventana de contexto en retrieval ineficiente: `grep` globales, `cat` de archivos completos, resultados duplicados, búsquedas redundantes. El resultado es baja **información útil por token**:

```text
Information Density = useful_context_tokens / total_context_tokens
```

ContextForge resuelve esto aplicando la analogía de un optimizador de consultas de base de datos al retrieval de código:

| Base de datos | ContextForge |
|---|---|
| SQL | Context Query (CQP) |
| Query parser | `interpreter.js` + `cqp.js` |
| Logical plan | Plan con target, relations, inclusions, budget |
| Query optimizer | `optimizer.js` (cost model + planes candidatos) |
| Table scan / index | rg / fd / ast-grep / Probe |
| Result set | Context fusionado y acotado por presupuesto |
| Statistics | Telemetría de ejecución (`telemetry.ndjson`) |

El agente dice **qué** necesita, no **cómo** buscarlo. ContextForge decide qué herramienta usar, con qué scope, cuánto contexto devolver y cuándo detenerse.

---

## Estado actual

> Honestidad primero: hoy ContextForge es un **router de herramientas con modelo de costo lineal**, en camino a ser un query optimizer completo. Lo implementado y lo pendiente:

**Implementado**

- CQP (lenguaje de consultas declarativo) + parser
- Interpreter heurístico de intención (sin ML)
- Planes físicos candidatos A/B/C por tipo de query
- Statistics store por `(operador, clase de predicado)`: avg candidates, p95 tokens, latencia, success rate (≥3 registros)
- Estimación de cardinalidad por clase de predicado, refinada con los valores reales post-ejecución
- Separación Cost/Quality: `utility = quality / cost` (CostModel `CF_COST_*`, QualityModel `CF_QUALITY_*`)
- Reescritura de planes: operadores baratos/de alta selectividad primero (respetando dependencias)
- Operadores `FOLLOW` (references/definitions/usages) e `INCLUDE` (tests) ejecutados
- Ejecución ordenada con **early termination** informada
- Fusión: dedup cross-tool, ranking multi-factor, presupuesto de tokens, orden por tiers
- Cache intra-sesión (TTL 5 min, persistido entre procesos)
- MCP server (stdio, sin dependencias)

---

## Arquitectura

```text
                    AGENTE LLM
                        │
                        ▼
              context_query() ── MCP o CLI
                        │
                        ▼
               ┌──────────────────────┐
               │   cqp.js / interpreter │  parse + clasificar intención
               └──────────┬───────────┘
                          ▼
               ┌──────────────────────┐
               │   Logical Plan       │  target, relations, inclusions, limit, budget
               └──────────┬───────────┘
                          ▼
               ┌──────────────────────┐
               │   optimizer.js       │  planes A/B/C → cost model → selección
               └──────────┬───────────┘     + learned mappings (telemetría)
                          ▼
               ┌──────────────────────┐
               │   Physical Plan      │  secuencia ordenada de ops
               └──────────┬───────────┘
                          ▼
        ┌─────────┬────────┼─────────┬─────────┐
        ▼         ▼        ▼         ▼         ▼
   search-code search-structure search-semantic project-map extract-context
        └─────────┴────────┼─────────┴─────────┘
                           ▼
               ┌──────────────────────┐
               │   assemble-context   │  normalize → filter → dedup → rank → budget → order
               └──────────┬───────────┘
                          ▼
                    CONTEXTO FINAL (bajo presupuesto)
                          ▼
                        LLM
```

### Fases

1. **Interpretación** — el agente emite una query CQP (`FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000`) o texto natural (`--intent '¿dónde se define parseConfig?'`). `cqp.js` la convierte en un logical plan; `interpreter.js` clasifica la intención en `query_type` + `confidence`.
2. **Optimización** — `optimizer.js` genera planes físicos candidatos por tipo de query y selecciona el de menor costo estimado. La telemetría acumulada permite *learned mappings*: si `search-structure` tiene mejor historial que `search-code` para `definitions`, el plan se reordena.
3. **Ejecución** — las ops del plan se ejecutan en orden con **early termination**: si la primera op satisface la query, no se ejecutan las demás. Cada op produce líneas NDJSON del schema normalizado.
4. **Fusión** — `assemble-context` aplica el pipeline sobre los resultados: excluye paths de bajo valor, deduplica por `path:line_start:line_end` (colapsa matches cross-tool), rankea multi-factor, recorta al presupuesto y ordena por tiers de confianza (T1 constraints → T4 baja confianza).

---

## Componentes

| Módulo | Descripción |
|---|---|
| `agent-context-engineering/` | **Skill de agente** — `SKILL.md` + 10 references de política (retrieval-policy, tool-selection, context-budget con niveles 2000/8000/20000/30000, dedup, semántica, filesystem, evaluación, métricas, schema de resultados, toolchain). Enseña al agente las reglas; no contiene lógica del motor. |
| `engine/` | **Motor Node (ESM, stdlib-only, sin dependencias)** — parser CQP, interpreter, optimizer, pipeline, cache y MCP server. |
| `scripts/` | **CLIs** — 9 wrappers de las herramientas de retrieval. |
| `evals/` | **Benchmark** — 10 tareas, runner skill-vs-baseline y analizador de 4 targets. |
| `openspec/` | **Especificación spec-driven** (governance, solo-local, git-ignored). |

---

## Cómo funciona

Ejemplo real — query CQP:

```bash
node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'
```

```text
1. cqp.js        → { query_type: "implementation",
                     target: {kind:"concept", name:"provider fallback"},
                     relations: ["references"], inclusions: ["tests"],
                     limit: 8000, budget: 8000 }
2. optimizer.js  → 3 planes candidatos (A: search-code; B: search-code + search-structure;
                     C: search-semantic + search-code) → selecciona el de menor costo
3. engine.js     → ejecuta ops en orden, early termination si una satisface,
                     fusiona con assemble-context
4. Resultado     → contexto acotado al presupuesto, deduplicado y rankeado
```

Presupuestos: `BUDGET` mapea a los niveles 2000 / 8000 / 20000 / 30000 (valores intermedios hacia abajo: `5000 → 2000`).

---

## Instalación

**Requisitos** (Fedora):

```bash
sudo dnf install ripgrep fd-find jq yq fzf tokei
```

- `rg` (búsqueda de texto), `fd` (nombres), `ast-grep`/`sg` (estructural), `jq` (JSON), `tokei` (métricas LOC, opcional)
- **Probe** (opcional, retrieval semántico): `npm install -g @probelabs/probe`
- **Node.js ≥ 18** (el engine no usa dependencias npm)

**Clonar e instalar la skill** en tu agente (OpenCode, Claude, etc.):

```bash
git clone https://github.com/khnker/contextforge.git
cd contextforge

# Instalar la skill de retrieval (symlink al directorio de skills de tu agente):
ln -s "$PWD/agent-context-engineering" ~/.config/opencode/skills/
```

**Verificar el toolchain**:

```bash
scripts/check-tools   # exit 0 si rg/fd/jq están presentes; las opcionales no bloquean
```

Detalles de instalación por distro y fallbacks sin sudo en `agent-context-engineering/references/toolchain-install.md`.

---

## Uso

**Búsqueda rápida (CLI directa):**

```bash
scripts/project-map                                          # shape del repo (dirs, lenguajes, LOC)
scripts/search-code -d src "provider"                        # rg scoped con exclusiones default
scripts/search-code -i -l "retry"                            # solo archivos, case-insensitive
scripts/search-structure -d src 'class $A'                   # patrón AST (ast-grep)
scripts/extract-context src/router.ts 40 60                  # unidad semántica (rango de líneas)
```

**Motor completo:**

```bash
# Query CQP
node engine/engine.js 'FIND definitions OF symbol parseConfig'

# Query de lenguaje natural
node engine/engine.js --intent '¿dónde se define parseConfig?'

# Misma query 2 veces → 2ª corrida con cache hit
node engine/engine.js 'FIND implementation OF concept "provider fallback"'  # cache_hits: 0
node engine/engine.js 'FIND implementation OF concept "provider fallback"'  # cache_hits: 1
```

**MCP (para agentes):**

```bash
engine/mcp-test.sh    # initialize → tools/list → context_query
```

Superficie MCP mínima a propósito:

- `context_query({intent, constraints})` — abstracción principal
- `search_files` / `read_file` — escape de bajo nivel

---

## Benchmark: ahorro de contexto

Medición real sobre `/home/nicolas/dev/polar` (2,129 archivos, 50k+ LOC), **skill vs baseline naive** (`grep` / `cat` / `find` — lo que hace un agente sin política):

| Tarea | Skill tokens | Baseline tokens | % ahorro | correct S/B |
|-------|-------------|-----------------|----------|-------------|
| identifier | 344 | 2,740 | 87.4% | ✅ / ✅ |
| filename | 305 | 2,792 | 89.1% | ✅ / ✅ |
| pattern | 256 | 2,691 | 90.5% | ✅ / ✅ |
| symbol | 305 | 2,792 | 89.1% | ✅ / ✅ |
| concept | 1,057 | 4,000 | 73.6% | ✅ / ✅ |
| repo_map | 199 | 4,698,530 | 99.996% | ✅ / ✅ |
| **Σ** | **2,466** | **4,711,545** | **99.95%** | **6/6** |

Lectura:

- **~82–90%** de ahorro en queries de código; **~99.9%** en mapeo de repo (el baseline `find` plano devuelve el árbol completo de archivos).
- Excluyendo repo_map: **82.6%** de ahorro global de tokens.
- Llamadas a herramientas: **13 vs 12** (empate) → la ganancia es de **contexto**, no de número de comandos.
- Correctitud: **6/6** en ambas vías — el ahorro no degrada el resultado.
- Comportamiento del engine: `cache_hits: 1` en segunda corrida, `early_terminated: true` cuando la primera op del plan satisface.

El benchmark es reproducible: `evals/run-benchmark` + `evals/analyze` (10 tareas, 4 targets de aceptación).

---

## Roadmap

Para pasar de router heurístico a query optimizer completo (en orden de valor):

1. **Statistics store** — agregar `telemetry.ndjson` por `(operador, clase de predicado)`: `avg_candidates`, `p95_tokens`, `latency_ms`, `success_rate`.
2. **Cardinality estimation** — estimar candidatos **antes** de ejecutar cada op y refinar con el conteo real post-ejecución (analogía `autoanalyze` de PostgreSQL). Hoy los costos son constantes por herramienta.
3. **Operadores `FOLLOW` / `INCLUDE`** — ejecutar `relations` y `inclusions` que CQP ya parsea (referencias, tests).
4. **Plan rewriting** — conmutar/reordenar ops cuando el estimado lo justifique.
5. **Cost / Quality separados** — `utility = Quality(plan) / Cost(plan)`, con relevance/coverage/confidence fuera de la fórmula de costo.

No está en el roadmap: clasificador ML de intención (el interpreter heurístico + estadísticas son suficientes) y un MCP gigante (la superficie se mantiene pequeña).

---

## Estructura del repo

```text
contextforge/
├── agent-context-engineering/     # skill de agente
│   ├── SKILL.md                   # activación, árbol de decisión, escalación, budgets, anti-patterns
│   ├── references/                # 10 docs de política de retrieval
│   ├── config/exclusions.json     # exclusiones default (node_modules, dist, ...)
│   └── scripts/check-tools
├── engine/                        # motor (Node, stdlib-only)
│   ├── cqp.js                     # parser CQP → logical plan
│   ├── interpreter.js             # clasificador de intención (heurístico)
│   ├── optimizer.js               # planes candidatos + cost model + telemetría + learned mappings
│   ├── engine.js                  # pipeline: parse → optimize → ejecutar → fusionar (+ cache)
│   ├── mcp-server.js              # MCP stdio: context_query / search_files / read_file
│   └── README.md
├── scripts/                       # 9 CLIs (project-map, search-code, search-structure, ...)
├── evals/                         # benchmark + analizador de targets
└── openspec/                      # especificación spec-driven (local, git-ignored)
```

---

## Licencia

[MIT](LICENSE)

## Naming: CQ / CIR / CQP

El lenguaje de consultas de ContextForge se llama **CQP (Context Query Plan)** — deliberadamente no "CQL", que colisiona con estándares de terceros (ARROW/Europeana, MDPI "Context Definition and Query Language", USENIX).

```text
Context Query (CQ)          → texto de la consulta del agente
Context Intermediate Rep.   → representación parseada (concepto; plegada en CQP hoy)
Context Query Plan (CQP)    → plan lógico producido por parseCQP
Physical Retrieval Plan     → salida del optimizer (ops ordenadas)
```

`CIR` queda documentado como concepto, no como capa de código separada (YAGNI: el parser emite el plan lógico directamente).
