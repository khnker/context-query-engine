# ContextForge

Retrieval + gestión de contexto para agentes LLM. Interpreta queries, optimiza el plan de búsqueda y fusiona resultados de múltiples herramientas dentro de un presupuesto de tokens.

## ¿Qué es?

ContextForge es un sistema de retrieval que recibe queries de contexto de un agente LLM, las interpreta y entrega contexto optimizado dentro de un presupuesto de tokens. La analogía es un optimizador de consultas de base de datos:

| Agente LLM | → | Context Query | → | Query Interpreter | → | Logical Plan | → | Cost-Based Optimizer | → | Physical Plan | → | rg / AST / LSP / Probe | → | Result Fusion | → | LLM |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

En vez de que el agente haga `grep`/`cat` a ciegas, ContextForge decide *qué* buscar, *dónde*, *con qué herramienta* y *cuánto contexto devolver*, basándose en el costo estimado (tokens, latencia, llamadas) y en estadísticas aprendidas de ejecuciones previas.

## Componentes

- **Skill de agente** — `agent-context-engineering/`: `SKILL.md` + 10 references de política de retrieval: `retrieval-policy` (query-type → herramienta), `tool-selection`, `context-budget` (niveles 2000/8000/20000/30000 tokens), `context-deduplication`, `semantic-retrieval`, `filesystem-context`, `evaluation`, `retrieval-metrics`, `result-schema`, `toolchain-install`. Actúa como adaptador: le da al agente las reglas de retrieval sin lógica de negocio.
- **Engine (Node, stdlib-only)** — `engine/`:
  - `cql.js` — parser del lenguaje de consultas (CQL): `FIND <type> OF <target> [AND FOLLOW <relations>] [AND INCLUDE <inclusions>] [LIMIT|BUDGET N]`.
  - `interpreter.js` — clasifica queries de lenguaje natural → `query_type` + `confidence` (familias regex; 2+ hits → 0.95, ambiguo → 0.5, default `implementation` 0.3).
  - `optimizer.js` — genera planes candidatos A/B/C por tipo de query, cost = `w1·tokens + w2·latency + w3·tool_calls − w4·relevance` (pesos vía `CF_W1..W4`), selecciona el de menor costo, registra telemetría y aprende mappings (≥3 registros sobreescriben la política estática).
  - `engine.js` — pipeline completo: parse → optimizar → ejecución ordenada con *early termination* → fusión → cache intra-sesión (TTL 5 min, persistido).
  - `mcp-server.js` — servidor MCP (stdio, JSON-RPC, sin dependencias): expone `context_query`, `search_files` y `read_file`.
- **Scripts CLI** — `scripts/`: `project-map` (shape del repo), `search-code` (wrapper rg con exclusiones), `search-structure` (ast-grep), `search-semantic` (Probe), `extract-context` (unidad semántica: rango de líneas, evita `cat` completo), `inspect-json`, `retrieval-metrics` (telemetría), `assemble-context` (normalize → filter → dedup → rank → budget → order, tiers T1–T4), `check-tools`.
- **Evals** — `evals/`: benchmark de 10 tareas (`retrieval.json` + `run-benchmark`) contra baseline naive (find/grep/cat), con 4 targets de aceptación (`analyze`): tokens ≤70%, tool_calls ≤80%, duplicados ≤80%, success ≥ baseline.

## Tecnologías

| Capa | Herramientas |
|---|---|
| Shell | bash + coreutils (Fedora) |
| Búsqueda de texto | [ripgrep](https://github.com/BurntSushi/ripgrep) (rg) |
| Búsqueda por nombre | [fd](https://github.com/sharkdp/fd) |
| Búsqueda estructural | [ast-grep](https://ast-grep.github.io/) (sg) |
| JSON | [jq](https://jqlang.github.io/jq/) |
| Métricas de código | [tokei](https://github.com/XAMPPRocky/tokei) (opcional, fallback fd+jq) |
| Retrieval semántico | [Probe](https://github.com/zeroentropy-ai/probe) (opcional) |
| Engine | Node.js (ESM, sin dependencias npm) |
| Integración con agentes | MCP (JSON-RPC over stdio) |

## Arquitectura

Pipeline de una query:

```
Query (CQL o lenguaje natural)
  → Query Interpreter      (query_type + confidence)
  → Logical Plan           (target, relations, inclusions, limit, budget)
  → Cost-Based Optimizer   (planes A/B/C, cost = w1·tokens + w2·latency + w3·calls − w4·relevance)
  → Physical Plan          (ops ordenadas por costo, con early termination)
  → Ejecución              (search-code / search-structure / search-semantic)
  → Result Fusion          (normalize → filter → dedup cross-tool → rank → budget → order por tiers)
  → Contexto final         (dentro del presupuesto de tokens)
```

Principios:

- **Presupuesto de tokens**: niveles 2000/8000/20000/30000; `BUDGET 5000` mapea hacia abajo a 2000.
- **Deduplicación cross-tool**: misma `path:line_start:line_end` de dos herramientas colapsa a una entrada con `sources[]` acumulada.
- **Aprendizaje**: la telemetría de ejecuciones (tokens, latencia, éxito por herramienta) sobreescribe la política estática cuando hay ≥3 registros.
- **Early termination**: si una operación del plan produce resultados suficientes, el plan corta antes de ejecutar las siguientes.
- **Cache**: resultados por query, TTL 5 minutos, persistidos entre procesos.

## Instalación

Requisitos (Fedora):

```bash
sudo dnf install ripgrep fd-find jq yq fzf tokei
```

Clonar e instalar la skill en tu agente:

```bash
git clone https://github.com/khnker/contextforge.git
cd contextforge
npm install            # opcional: solo scripts/check-tools
ln -s "$PWD/agent-context-engineering" ~/.config/opencode/skills/
```

Verificar el toolchain:

```bash
scripts/check-tools    # exit 0 = core (rg fd jq) presente
```

Opcional — retrieval semántico con Probe:

```bash
# ver toolchain-install.md en agent-context-engineering/references/
```

## Uso

Búsqueda de código:

```bash
scripts/project-map
scripts/search-code -d src "provider"
scripts/search-structure -p 'class HeadroomStore' -d src
```

Motor con CQL:

```bash
node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'
```

Query de lenguaje natural:

```bash
node engine/engine.js --intent '¿dónde se define parseConfig?'
```

MCP:

```bash
engine/mcp-test.sh    # initialize → tools/list → context_query
```

## Benchmark: ahorro de contexto

Medición real sobre `/home/nicolas/dev/polar` (2,129 archivos, 50k+ LOC), skill vs baseline naive (`grep`/`cat`/`find`):

| Tarea | Skill tokens | Baseline tokens | % ahorro | correct S/B |
|-------|-------------|-----------------|----------|-------------|
| identifier | 344 | 2,740 | 87.4% | ✅/✅ |
| filename | 305 | 2,792 | 89.1% | ✅/✅ |
| pattern | 256 | 2,691 | 90.5% | ✅/✅ |
| symbol | 305 | 2,792 | 89.1% | ✅/✅ |
| concept | 1,057 | 4,000 | 73.6% | ✅/✅ |
| repo_map | 199 | 4,698,530 | 99.996% | ✅/✅ |
| **Σ** | **2,466** | **4,711,545** | **99.95%** | **6/6** |

- ~82–90% de ahorro en queries de código; ~99.9% en mapeo de repo (el baseline `find` plano devuelve el árbol completo de archivos).
- Excluyendo repo_map: **82.6%** de ahorro global de tokens.
- Llamadas a herramientas: 13 vs 12 (empate) → la ganancia es de *contexto*, no de número de comandos.
- Correctitud: 6/6 en ambas vías.
- Comportamiento del engine: `cache_hits: 1` en la segunda corrida de la misma query, `early_terminated: true` cuando la primera operación del plan ya produce resultados.

## Estructura del repo

```
contextforge/
├── agent-context-engineering/   # skill de agente (SKILL.md + references)
│   ├── references/              # 10 docs de política de retrieval
│   ├── config/exclusions.json   # exclusiones por defecto (node_modules, dist, ...)
│   └── scripts/check-tools
├── engine/                      # motor Node (stdlib-only)
│   ├── cql.js                   # parser CQL
│   ├── interpreter.js           # clasificador de intents
│   ├── optimizer.js             # cost-based optimizer + telemetría
│   ├── engine.js                # pipeline completo + cache
│   ├── mcp-server.js            # servidor MCP
│   └── README.md
├── scripts/                     # CLI (9 scripts)
├── evals/                       # benchmark + análisis de targets
└── openspec/                    # especificación spec-driven (governance)
```

## Desarrollo

Proyecto gobernado por [OpenSpec](https://github.com/Fission-AI/OpenSpec) (spec-driven): cada cambio vive en `openspec/changes/<feature>/` con proposal, spec, design y tasks, y se valida con `openspec validate --all --strict` antes de archivar.

## Licencia

MIT
