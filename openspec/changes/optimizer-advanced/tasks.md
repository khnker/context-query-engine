# Tasks — optimizer-advanced

## 1. Statistics Store

- [x] 1.1 Reemplazar `learnedMapping` en `engine/optimizer.js` por `statsStore()`: agrega telemetría por clave `(operator, predicate_class)` → `{ avg_candidates, p95_tokens, avg_latency_ms, success_rate, records }`
- [x] 1.2 Extraer `predicateClass(queryType, target)` → clase de predicado (identifier/filename/pattern/concept/symbol/repo_map)
- [x] 1.3 `recordExecution` escribe `predicate_class` en cada línea de `engine/telemetry.ndjson` (backward-compatible: si falta, clase = query_type)
- [x] 1.4 Umbral de evidencia: stats solo influyen con ≥3 registros en la clave

## 2. Cardinality Estimator

- [x] 2.1 `estimateCandidates(predicateClass)` → default por clase (sin stats): identifier 5, filename 3, pattern 20, concept 100, symbol 15, repo_map 1
- [x] 2.2 Estimación refinada: si stats existen, `avg_candidates` de la clave sobreescribe el default
- [x] 2.3 Costo de op usa `estimateCandidates` (en vez de constante por tool): `op.cost = base + k · estimación`
- [x] 2.4 Refinamiento post-ejecución: `recordExecution` actualiza `avg_candidates` con `results.length` real (autoanalyze)

## 3. Operator Pipeline (FOLLOW/INCLUDE)

- [x] 3.1 `engine/engine.js`: ejecutar `SEARCH → FILTER → FOLLOW → JOIN → RANK → LIMIT`
- [x] 3.2 Operador `FOLLOW(relations)`: por cada candidato (path), buscar `references`/`definitions`/`usages` con search-code/ast-grep scoped al archivo; fusionar resultados con source `follow`
- [x] 3.3 Operador `INCLUDE(inclusions)`: buscar `tests`/`config`/etc. en paths de candidatos; fusionar con tier T4
- [x] 3.4 Early termination informada: parar tras op que satisface SI el plan no tiene ops FOLLOW/INCLUDE pendientes
- [x] 3.5 Arreglar bug: `relations`/`inclusions` del logical plan ya NO se descartan (probar `FIND implementation OF concept X AND FOLLOW references AND INCLUDE tests LIMIT 8000`)

## 4. Plan Rewriting / Reordering

- [x] 4.1 `rewritePlans(logicalPlan)`: generar ≥2 candidatos (orden original + orden reescrito barato/selectivo primero)
- [x] 4.2 Restricción topológica: `FOLLOW`/`INCLUDE` nunca antes de su `SEARCH`; `FILTER`/`RANK` tras primer `SEARCH`
- [x] 4.3 Selección = min utility entre candidatos (integra D16)
- [x] 4.4 Mensaje de selección: `plan <id>: utility <u> (quality <q> / cost <c>)`

## 5. Cost/Quality Split

- [x] 5.1 `CostModel(tokens, latency_ms, tool_calls)` con pesos `CF_COST_*` (defaults 0.01/0.001/1)
- [x] 5.2 `QualityModel(relevance, coverage, confidence)` con pesos `CF_QUALITY_*` (defaults 10/5/1)
- [x] 5.3 `utility = quality / cost`; selección max utility
- [x] 5.4 COST_TABLE se conserva como `base_relevance` + `base_cost` por tool (coverage default 1, confidence del logical plan)

## 6. Validación

- [x] 6.1 `node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'` → results contienen FOLLOW + INCLUDE (tests tier T4)
- [x] 6.2 Query con stats previas: selección usa `avg_candidates` (costo por estimación, no constante)
- [x] 6.3 2ª corrida → `cache_hits ≥ 1` (cache intacto)
- [x] 6.4 `evals/run-benchmark` → 10/10 pares; `evals/analyze` → 4/4 targets PASS
- [x] 6.5 `bash -n` en todos los archivos modificados
- [x] 6.6 `openspec validate --changes` → 1 passed / 0 failed
