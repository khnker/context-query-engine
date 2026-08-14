# design.md — optimizer-advanced

## Context

Architecture review vs PostgreSQL query optimizer (verificado en código, sesión previa):

- `engine/optimizer.js` — planes A/B/C hardcodeados por query_type (switch:56-80), COST_TABLE constante por tool (:25-31), `planCost` lineal (:85-90), selección min-costo (:129-144), `learnedMapping` ad-hoc con ≥3 records (:101-127).
- `engine/engine.js` — ejecución lineal ordenada con early termination (:185-199); `relations`/`inclusions` del logical plan NUNCA ejecutados (bug CQL).
- `engine/cql.js` — parser emite logical plan con `target`, `relations`, `inclusions`, `limit`, `budget`, `confidence`.

Veredicto: "cost-based optimizer" de nombre; en práctica router heurístico. Este change lo convierte en CBO real con 5 piezas.

## Goals

- Statistics store agregado por (operator, predicate_class) → enabler de cardinalidad.
- Estimación de cardinalidad pre-ejecución + refinamiento post-ejecución (autoanalyze).
- Ejecutar FOLLOW/INCLUDE del CQL (arregla bug de clauses parseadas y descartadas).
- Reescritura de planes: reordenar ops baratas/selectivas primero, respetando dependencias.
- CostModel y QualityModel separados; selección por `utility = quality / cost`.
- Evals existentes siguen pasando (targets 4/4: tokens_ratio≤0.70, tool_calls_ratio≤0.80, dupes_ratio≤0.80, success≥baseline).

## Non-Goals

- No TinyBERT / clasificador ML (YAGNI).
- No cambio de superficie MCP.
- No cambio de gramática CQL ni de budgets (2000/8000/20000/30000).
- No persistencia nueva: stats viven en `engine/telemetry.ndjson` (append-only, agregado al leer).

## Decisions

### D12 — Statistics store: agregación sobre telemetry.ndjson, sin DB

Stats = agregación en memoria al optimizar, sobre el archivo append-only existente. Clave `(operator, predicate_class)`. Métricas: `avg_candidates`, `p95_tokens`, `avg_latency_ms`, `success_rate`. Umbral evidencia ≥3 registros (igual que learnedMapping hoy). Reemplaza `learnedMapping` por completo (misma data, agregación generalizada).

### D13 — Cardinalidad estimada por clase de predicado, no por tool

La estimación depende de la CLASE de predicado (identifier/filename/pattern/concept/symbol/repo_map), no del tool: un `search-code` para `identifier` tiene cardinalidad distinta que para `concept`. Defaults por clase cuando no hay stats; post-ejecución se refina con `results.length` real. El costo de op = f(cardinalidad estimada) vía tabla por clase (no constante por tool).

### D14 — Operator pipeline SEARCH → FILTER → FOLLOW → JOIN → RANK → LIMIT

`SEARCH` = ejecutar tool del plan (search-code/search-structure/search-semantic/rg-files). `FILTER`/`RANK`/`LIMIT` = reusar `assemble-context` (normalize/filter/dedup/rank/budget/tiers T1-T4). `FOLLOW` (nuevo) = resolver `relations` sobre candidatos: usa search-code/ast-grep por archivo candidato para `references`/`definitions`/`usages`. `INCLUDE` (nuevo) = buscar `inclusions` (ej. tests) en paths de candidatos y fusionar con tier T4. Early termination: parar cuando op satisface (éxito = hit relevante) y el plan no exige más.

### D15 — Rewriter: orden barato/selectivo primero, dependencias respetadas

Regla de reescritura simple: ordenar ops por (costo unitario estimado / selectividad estimada) asc, con restricción topológica: `FOLLOW`/`INCLUDE` nunca antes de su `SEARCH` fuente; `FILTER`/`RANK` siempre después del primer `SEARCH`. Genera ≥2 candidatos (orden original + orden reescrito) y selecciona min-utility.

### D16 — Cost/Quality split con utility = quality / cost

`CostModel(tokens, latency_ms, tool_calls)` = w1·tokens + w2·latency + w3·calls (pesos `CF_COST_*`, defaults 0.01/0.001/1). `QualityModel(relevance, coverage, confidence)` = q1·relevance + q2·coverage + q3·confidence (pesos `CF_QUALITY_*`, defaults 10/5/1). `utility = quality / cost`; selección = max utility. Ops sin datos de calidad usan relevancia estática de COST_TABLE (conservada como `base_relevance`).

## Open Questions

- ¿Refinar cardinalidad con decay temporal (recentes pesan más)? v1: promedio simple (YAGNI).
- ¿P95 sobre cuántos registros mínimos? v1: mismo umbral 3.
