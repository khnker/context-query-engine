# optimizer-advanced

## Why

Architecture review vs PostgreSQL CBO (evidencia file:line, sesión previa): el optimizer actual es un **router heurístico cost-ranked**, no un CBO real.

- Planes A/B/C **hardcodeados** por query_type (`engine/optimizer.js:56-80`), 4 query_types colapsan al default.
- Costos **constantes por tool** (`optimizer.js:25-31` COST_TABLE), sin cardinalidad ni selectividad por input.
- `FOLLOW`/`INCLUDE` son **parseados por CQL pero nunca ejecutados** (bug real: `relations`/`inclusions` del logical plan se descartan).
- `telemetry.ndjson` es log post-hoc plano, no statistics store.
- `learnedMapping` ad-hoc (≥3 records, reordena op[0]) reemplaza a una stats store real.
- Cost y Quality mezclados en una fórmula lineal (`cost = w1·tokens + w2·latency + w3·calls − w4·relevance`).

## What Changes

5 componentes del CBO:

1. **Statistics Store** — agregar telemetría por `(operator, predicate_class)`: `avg_candidates`, `p95_tokens`, `avg_latency_ms`, `success_rate`. Reemplaza `learnedMapping`.
2. **Cardinality Estimator** — estimar nº de candidatos por operador ANTES de ejecutar (por clase de predicado); refinar con actuales post-ejecución (analogía `autoanalyze`).
3. **Operator Pipeline** — ejecutar los operadores del logical plan: `SEARCH → FILTER → FOLLOW → JOIN → RANK → LIMIT`. Saca `relations`/`inclusions` del plan y los ejecuta (arregla el bug de CQL).
4. **Plan Rewriting / Reordering** — regla de reescritura: ops baratas y de alta selectividad primero; enumerar candidatos reordenados.
5. **Cost/Quality Split** — `CostModel(tokens, latency, tool_calls)` + `QualityModel(relevance, coverage, confidence)`; selección maximiza `utility = quality / cost`.

## Capabilities

### Modified: context-engineering

- Statistics Store
- Cardinality Estimation
- Operator Pipeline (SEARCH/FILTER/FOLLOW/JOIN/RANK/LIMIT)
- Plan Rewriting / Reordering
- Cost/Quality Separation

## Impact

- `engine/optimizer.js` — reescrito: stats store, estimator, reorder, cost/quality split.
- `engine/engine.js` — ejecuta FOLLOW/INCLUDE del plan; usa stats para early termination informada.
- `engine/telemetry.ndjson` — mismo archivo, ahora consumido como statistics store agregado.
- `engine/cql.js`, `engine/interpreter.js` — sin cambios (contracto de entrada estable).
- MCP (`mcp-server.js`) — sin cambios; `context_query` hereda el nuevo optimizer.
- Evals (`evals/run-benchmark`, `analyze`) — sin cambios; targets 4/4 deben seguir pasando.
