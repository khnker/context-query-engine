# context-query-engine

**Motor de retrieval y gestión de contexto para agentes LLM.** Convierte la búsqueda de contexto en una consulta optimizable: interpreta lo que el agente necesita, planifica cómo obtenerlo y devuelve solo el contexto útil dentro de un presupuesto de tokens.



## ¿Qué es?

Un agente LLM que trabaja sobre un codebase gasta la mayor parte de su ventana de contexto en retrieval ineficiente: `grep` globales, `cat` de archivos completos, resultados duplicados, búsquedas redundantes. El resultado es baja **información útil por token**:

```text
Information Density = useful_context_tokens / total_context_tokens
```

context-query-engine resuelve esto aplicando la analogía de un optimizador de consultas de base de datos al retrieval de código:

| Base de datos | context-query-engine |
|---|---|
| SQL | Context Query (CQP) |
| Query parser | `interpreter.js` + `cqp.js` |
| Logical plan | Plan con target, relations, inclusions, budget |
| Query optimizer | `optimizer.js` (cost model + planes candidatos) |
| Table scan / index | rg / fd / ast-grep / Probe |
| Result set | Context fusionado y acotado por presupuesto |
| Statistics | Telemetría de ejecución (`telemetry.ndjson`) |

El agente dice **qué** necesita, no **cómo** buscarlo. context-query-engine decide qué herramienta usar, con qué scope, cuánto contexto devolver y cuándo detenerse.

---


## Estado actual

> Honestidad primero: hoy context-query-engine es un **router de herramientas con modelo de costo lineal**, en camino a ser un query optimizer completo. Lo implementado y lo pendiente:

**Implementado**

- CQP (lenguaje de consultas declarativo) + parser
- Interpreter heurístico de intención **+ clasificador local opcional (ML)** (gate confianza ≥ 0.6, fallback regex intacto)
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
- Snapshot de estadísticas del repo (`repo-stats.js`): files, bytes, tokens estimados, extensiones, recencia git
- Adaptive: decay exponencial (τ=7d) en el statistics store — el cost model se adapta a la evolución del repo
- Cardinalidad por operador: `estimateCandidates(operator|queryClass → queryClass → default)` cableado en el optimizer
- Interfaz de modelo local (`local-model.js`): `available()/run()/rerank()/rerankSync()`, `CF_MODEL_CMD`, timeout 2s, fallo → null
- Reranker opcional (hook en engine.js antes de fuse; null → ranking heurístico) + harness `recall@k`
- **Pipeline ML (TinyBERT-style)**: dataset 1,000 queries etiquetadas (10 clases, EN+ES) + split 70/15/15, entrenador numpy out-of-band (`evals/ml/train-classifier.py`), inferencia node (`evals/ml/classify.mjs`, ~6 ms), artifact swappable
- Gate ML (11.8): clasificación de intención — regex 0.347 → **ML efectivo 0.94** (fired 135/150, acc 1.0, fallback 15)

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


## Pipeline: ejemplo ejecutado

La query de abajo es la que se muestra en [Cómo funciona](#cómo-funciona), trazada por cada etapa con sus salidas reales:

```bash
node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'
```

1. **Texto de la query (CQP)** — declarativa: target `concept "provider fallback"`, relación `implementation`, `FOLLOW references`, `INCLUDE tests`, acotada por `LIMIT 8000` tokens.
2. **Interpreter + parser** (`cqp.js` + `interpreter.js`) — convierten en el AST interno y clasifican la intención en `query_type: "implementation"` con `confidence` heurística. Salida: `{ query_type: "implementation", target: { kind: "concept", name: "provider fallback" }, relations: ["references"], inclusions: ["tests"], limit: 8000, budget: 8000 }`.
3. **Logical plan** — independiente de herramientas: qué recuperar (target, relations, inclusions), no cómo. El presupuesto se ajusta al nivel de contexto más cercano (`8000 → 8000`).
4. **Optimizador** (`optimizer.js`) — genera los **planes físicos candidatos A/B/C** por tipo de query: A = `search-code`; B = `search-code` + `search-structure`; C = `search-semantic` + `search-code`. Cada uno se puntúa con el cost model (`cost = w1·tokens + w2·latency + w3·tool_calls`, `utility = quality / cost`); la cardinalidad parte de `CARD_DEFAULTS` (p. ej. `concept: 100`) y se refina con los valores reales post-ejecución.
5. **Physical plan** — la secuencia ordenada de operadores seleccionada:
   `search-code(definitions) → search-code(implementation) → search-structure(implementation) → follow(references) → include(tests)`
6. **Ejecución** — los operadores corren en orden; cada uno emite una línea NDJSON con **estimated vs actual** (`engine/statistics.ndjson`). Línea real de esta query:

```json
{"ts":"2026-08-14T20:37:35.784Z","operator":"search-code","queryClass":"definitions","estimated":{"candidates":15,"tokens":200,"latencyMs":15},"actual":{"candidates":15,"tokens":599,"latencyMs":26}}
```

| Operador / clase de predicado | Estimado (cand · tok · ms) | Actual (cand · tok · ms) |
|---|---|---|
| `search-code` / definitions | 15 · 200 · 15 | 15 · 599 · 26 |
| `search-code` / implementation | 15 · 200 · 15 | 15 · 551 · 25 |
| `search-structure` / implementation | 15 · 300 · 20 | 0 · 1 · 15 |
| `follow` / implementation | 15 · 300 · 25 | 0 · 1 · 19 |
| `include` / implementation | 15 · 200 · 20 | 4 · 1 · 27 |

   Las etapas `search-structure` y `follow` devolvieron **0 candidates** — los valores reales enseñan al optimizador que esta clase de predicado es barata y de bajo rendimiento, mejorando las estimaciones futuras (learned mappings).
7. **Fusión** (`assemble-context`) — normaliza resultados, filtra paths de bajo valor, deduplica por `path:line_start:line_end` entre herramientas, rankea multi-factor, recorta al presupuesto de 8000 tokens y ordena por tiers de confianza.
8. **Stats + contexto** — los valores reales se agregan a `engine/statistics.ndjson`; con ≥3 registros por `(operador, clase de predicado)` las estimaciones mejoran. El contexto final queda acotado al presupuesto, deduplicado y rankeado — listo para el LLM.

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
git clone https://github.com/khnker/context-query-engine.git
cd context-query-engine

# Instalar la skill de retrieval (symlink al directorio de skills de tu agente):
ln -s "$PWD/agent-context-engineering" ~/.config/opencode/skills/
```

**Verificar el toolchain**:

```bash
scripts/check-tools   # exit 0 si rg/fd/jq están presentes; las opcionales no bloquean
```

Detalles de instalación por distro y fallbacks sin sudo en `agent-context-engineering/references/toolchain-install.md`.

---


## Instalación ampliada

### Prerrequisitos por distro

Node.js **≥ 18** más herramientas core (`rg`, `fd`, `jq`):

| Distribución | Comando |
|---|---|
| Fedora | `sudo dnf install ripgrep fd-find jq` |
| Ubuntu / Debian | `sudo apt install ripgrep fd-find jq` |
| macOS | `brew install ripgrep fd jq` |

En Debian/Ubuntu el paquete es `fd-find` y el binario es `fdfind`; crear un symlink para que `fd` resuelva:

```bash
mkdir -p "$HOME/.local/bin" && ln -s "$(command -v fdfind)" "$HOME/.local/bin/fd"
```

### Herramientas opcionales

| Herramienta | Propósito | Instalación sin sudo |
|---|---|---|
| `probe` | Búsqueda semántica (`scripts/search-semantic`) | binario estático → `~/.local/bin` |
| `tokei` | Stats de LOC (cardinalidad repo_map) | binario estático → `~/.local/bin` |
| `semgrep` | Reglas AST para búsquedas de patrones avanzadas | pip o binario estático → `~/.local/bin` |

`sg` (semantic grep) está deprecado — usar `ast-grep` en su lugar.

### Variables de entorno

| Variable | Default | Efecto |
|---|---|---|
| `CF_COST_1` | `0.01` | Peso de costo w1 — tokens |
| `CF_COST_2` | `0.001` | Peso de costo w2 — latencia |
| `CF_COST_3` | `1` | Peso de costo w3 — tool calls |
| `CF_QUALITY_1` | `10` | Peso de calidad q1 — relevancia |
| `CF_QUALITY_2` | `5` | Peso de calidad q2 — cobertura |
| `CF_QUALITY_3` | `1` | Peso de calidad q3 — confidence |
| `CF_STATS_FILE` | `engine/statistics.ndjson` | Ruta del statistics store (default: archivo del repo) |

`utility = quality / cost` guía la selección del plan físico — ajustar los pesos según la carga de trabajo.

### Configuración de exclusiones

`agent-context-engineering/config/exclusions.json`:

- `defaults` — paths excluidos en todos lados: `node_modules`, `.git`, `dist`, `build`, `coverage`, `vendor`, `target`, `__pycache__`, `.next`.
- `project_overrides` — adiciones por proyecto (vacío por default).

### Verificación

```bash
npm run check-tools
```

Verifica herramientas core (`rg`, `fd`, `jq`) y opcionales (`yq`, `sg`, `tokei`, `probe`). **Exit 0** si todas las core están presentes; **exit 1** si falta alguna core. Las opcionales faltantes se reportan como `MISSING` pero no bloquean la operación básica.

### Troubleshooting

| Síntoma | Solución |
|---|---|
| La búsqueda semántica no devuelve nada | Falta el índice de Probe → ejecutar `probe index` |
| `sg` reportado como MISSING / deprecado | Usar `ast-grep` en su lugar |
| `fd: command not found` (Debian/Ubuntu) | Instalar `fd-find` y crear symlink `fdfind → fd` (ver arriba) |
| No se encuentran herramientas en `~/.local/bin` | Agregar `export PATH="$HOME/.local/bin:$PATH"` al perfil del shell (`check-tools` lo hace solo) |
| El analyzer sale con código 2 (datos insuficientes) | Statistics requiere ≥3 registros por `(operador, clase de predicado)` — ejecutar la query al menos 3 veces |

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

Métricas duras de tokens y latencia medidas sobre ejecuciones reales (no estimadas). Todo reproducible.

### Test de regresión de métricas (hard)

`npm run bench` mide tiempo y tokens reales de contextforge (C) vs baseline raw-fs (A) sobre el repo sintético, con guardas: la suite **falla** si C gasta más tokens que A o supera los umbrales.

| Query | A tokens | C tokens | A lat | C lat |
|-------|----------|----------|-------|-------|
| lex-01 | 655 | 239 | 43 ms | 144 ms |
| dep-01 | 655 | 239 | 67 ms | 295 ms |
| sem-01 | 655 | 239 | 57 ms | 216 ms |
| tst-01 | 504 | 239 | 47 ms | 251 ms |
| **Σ** | **2,469** | **956** | — | — |

→ **61.3% menos tokens**, wall 1.4 s, 4/4 queries correctas en ambas vías.

### Harness T1 — 32 tasks sintéticas, 4 modos

| Modo | Correctitud | Tokens | Latencia | Compresión vs A |
|------|-------------|--------|----------|-----------------|
| A — baseline raw (`grep`/`cat`) | 100% | 139,199 | 978 ms | 1.0× |
| B — `rg`/`fd` | 92.5% | 95 | 108 ms | 637× |
| **C — contextforge** | **100%** | **764** | **199 ms** | **104×** |
| D — oracle | 87.5% | 611 | 1,506 ms | 129× |

### Repo real T2 — `polar` (2,129 archivos, 50k+ LOC)

| Modo | Correctitud | Tokens | Latencia | Densidad |
|------|-------------|--------|----------|----------|
| A — baseline | 8/8 | 694,581 | 12,098 ms | 0.1856 |
| B — `rg`/`fd` | 8/8 | 409 | 283 ms | 0.1679 |
| **C — contextforge** | **8/8** | **3,403** | **232 ms** | **0.1875** |
| D — oracle | 8/8 | 2,512 | 7,867 ms | 0.1668 |

C corta **204× vs baseline** en el repo real con 98% menos latencia, manteniendo correctitud y la mayor densidad (información útil por token).

Reproducible: `npm run eval` (harness completo) y `npm run bench` (métricas duras con guardas).

---
## Testing

Ejecutar la suite completa:

```bash
npm test   # 34 unit tests + smoke + e2e
```

Cobertura (alineada con el change OpenSpec `test-suite`):

- **Unit** — `node --test` sobre `engine/` (parser, optimizer, statistics).
- **Smoke** — scripts bash: `npm run check-tools` más una ejecución end-to-end de la query del ejemplo.
- **End-to-end** — `node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'`, verificando que cada etapa del pipeline emite el NDJSON esperado.

Hasta que el change `test-suite` esté implementado, ejecutar la suite unitaria directamente:

```bash
node --test engine/
```

---


```bash
npm test    # 34 unit tests + smoke + e2e
npm run bench  # métricas duras: tokens y latencia reales (C vs A) con guardas de regresión
```

## Estructura del repo

```text
context-query-engine/
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


## Glosario

> Glosario (Glossary) de términos del engine, explicados en español.

| Término | Significado |
|---|---|
| **CQ** | Context Query — lo que el agente necesita, como lenguaje natural o texto de intención (p. ej. `--intent '¿dónde se define parseConfig?'`). |
| **CQP** | Context Query Plan — el lenguaje de consultas declarativo que ejecuta el motor (`FIND ... AND ... LIMIT ...`), parseado por `cqp.js`. |
| **AST** | Abstract Syntax Tree — la representación estructurada interna que produce el parser; frontera entre el texto de la query y el planner. |
| **Logical plan** | Descripción independiente de herramientas de qué recuperar: target, relations, inclusions, limit/budget. |
| **Physical retrieval plan** | La secuencia concreta y ordenada de operadores que se ejecutará (`search-code`, `search-structure`, `search-semantic`, `project-map`, `extract-context`). Candidatos A/B/C por tipo de query. |
| **Cost model** | `cost = w1·tokens + w2·latency + w3·tool_calls` con pesos `CF_COST_1..3`; la selección de plan usa `utility = quality / cost`. |
| **Confidence** | Qué tan seguro está el interpreter heurístico de la clasificación `query_type` de una query. |
| **Statistics** | Agregados por `(operador, clase de predicado)` — avg candidates, p95 tokens, latencia, success rate — calculados con ≥3 registros, almacenados en `engine/statistics.ndjson`. |
| **Information density** | `useful_context_tokens / total_context_tokens` — la métrica que optimiza el motor. |
| **Wrong-context** | Contexto recuperado que no coincide con lo que el agente realmente necesita; el modo de fallo que la fusión (dedup, ranking, presupuesto) minimiza. |

---


## Naming: CQ / CIR / CQP

El lenguaje de consultas de context-query-engine se llama **CQP (Context Query Plan)** — deliberadamente no "CQL", que colisiona con estándares de terceros (ARROW/Europeana, MDPI "Context Definition and Query Language", USENIX).

```text
Context Query (CQ)          → texto de la consulta del agente
Context Intermediate Rep.   → representación parseada (concepto; plegada en CQP hoy)
Context Query Plan (CQP)    → plan lógico producido por parseCQP
Physical Retrieval Plan     → salida del optimizer (ops ordenadas)
```

`CIR` queda documentado como concepto, no como capa de código separada (YAGNI: el parser emite el plan lógico directamente).


## Licencia

[MIT](LICENSE)

