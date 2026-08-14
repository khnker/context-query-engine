# optimizer-advanced

## Contexto

El optimizer de ContextForge era un router heurístico cost-ranked: planes A/B/C hardcodeados por query_type, costos constantes por tool, sin cardinalidad, y `FOLLOW`/`INCLUDE` del CQL parseados pero nunca ejecutados. Este change lo convierte en un Cost-Based Optimizer real con 5 piezas: statistics store, cardinality estimator, operator pipeline, plan rewriting y cost/quality split.

## Alcance

- `engine/optimizer.js` — reescrito: stats store (D12), cardinality estimator (D13), rewriter (D15), Cost/Quality split (D16).
- `engine/engine.js` — pipeline `SEARCH → FILTER → FOLLOW → JOIN → RANK → LIMIT` (D14), arregla bug de FOLLOW/INCLUDE.
- `engine/telemetry.ndjson` — misma ruta, agregado como statistics store.
- Sin cambios: `cql.js`, `interpreter.js`, `mcp-server.js`, gramática CQL, budgets, evals.
