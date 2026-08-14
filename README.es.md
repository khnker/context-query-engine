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
| SQL | Context Query (CQL) |
| Query parser | `interpreter.js` + `cql.js` |
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

- CQL (lenguaje de consultas declarativo) + parser
- Interpreter heurístico de intención (sin ML)
- Planes físicos candidatos A/B/C por tipo de query
- Función de costo: `cost = w1·tokens + w2·latency + w3·tool_calls − w4·relevance` (pesos vía env `CF_W1..W4`)
- Ejecución ordenada con **early termination**
- Fusión: dedup cross-tool, ranking multi-factor, presupuesto de tokens, orden por tiers
- Cache intra-sesión (TTL 5 min, persistido entre procesos)
- Telemetría de ejecuciones + *learned mappings* (≥3 registros sobreescriben la política estática)
- MCP server (stdio, sin dependencias)

**Pendiente (roadmap)**

- Statistics store agregado por operador/predicado (hoy es log NDJSON)
- Estimación de cardinalidad / selectivity pre-ejecución (hoy los costos son constantes por herramienta)
- Operadores `FOLLOW` y `INCLUDE` (se parsean en CQL pero aún no se ejecutan)
- Reordenamiento de operadores (plan rewriting)
- Separación Cost model / Quality model

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
               │   cql.js / interpreter │  parse + clasificar intención
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

1. **Interpretación** — el agente emite una query CQL (`FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000`) o texto natural (`--intent '¿dónde se define parseConfig?'`). `cql.js` la convierte en un logical plan; `interpreter.js` clasifica la intención en `query_type` + `confidence`.
2. **Optimización** — `optimizer.js` genera planes físicos candidatos por tipo de query y selecciona el de menor costo estimado. La telemetría acumulada permite *learned mappings*: si `search-structure` tiene mejor historial que `search-code` para `definitions`, el plan se reordena.
3. **Ejecución** — las ops del plan se ejecutan en orden con **early termination**: si la primera op satisface la query, no se ejecutan las demás. Cada op produce líneas NDJSON del schema normalizado.
4. **Fusión** — `assemble-context` aplica el pipeline sobre los resultados: excluye paths de bajo valor, deduplica por `path:line_start:line_end` (colapsa matches cross-tool), rankea multi-factor, recorta al presupuesto y ordena por tiers de confianza (T1 constraints → T4 baja confianza).

---

## Componentes

| Módulo | Descripción |
|---|---|
| `agent-context-engineering/` | **Skill de agente** — `SKILL.md` + 10 references de política (retrieval-policy, tool-selection, context-budget con niveles 2000/8000/20000/30000, dedup, semántica, filesystem, evaluación, métricas, schema de resultados, toolchain). Enseña al agente las reglas; no contiene lógica del motor. |
| `engine/` | **Motor Node (ESM, stdlib-only, sin dependencias)** — parser CQL, interpreter, optimizer, pipeline, cache y MCP server. |
| `scripts/` | **CLIs** — 9 wrappers de las herramientas de retrieval. |
| `evals/` | **Benchmark** — 10 tareas, runner skill-vs-baseline y analizador de 4 targets. |
| `openspec/` | **Especificación spec-driven** del proyecto (governance). |

---

## Cómo funciona

Ejemplo real — query CQL:

```bash
node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'
```

```text
1. cql.js        → { query_type: "implementation",
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
# Query CQL
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
3. **Operadores `FOLLOW` / `INCLUDE`** — ejecutar `relations` y `inclusions` que CQL ya parsea (referencias, tests).
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
│   ├── cql.js                     # parser CQL → logical plan
│   ├── interpreter.js             # clasificador de intención (heurístico)
│   ├── optimizer.js               # planes candidatos + cost model + telemetría + learned mappings
│   ├── engine.js                  # pipeline: parse → optimize → ejecutar → fusionar (+ cache)
│   ├── mcp-server.js              # MCP stdio: context_query / search_files / read_file
│   └── README.md
├── scripts/                       # 9 CLIs (project-map, search-code, search-structure, ...)
├── evals/                         # benchmark + analizador de targets
└── openspec/                      # especificación spec-driven
```

---

## Licencia

[MIT](LICENSE)
