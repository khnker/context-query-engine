# Context Compilation / IR (B6) — SÍ SIRVE (representación)

> Veredicto: SIRVE

Pipeline IR explícito (estilo SQL): CQP lógico → lowering → plan físico de operadores IR → ejecución → contexto. `engine/ir.js` mapea 11 operadores (SCAN, SYMBOL_LOOKUP, LEXICAL_LOOKUP, DEPENDENCY_EXPAND, CALLER_EXPAND, SEMANTIC_SEARCH, HISTORY_LOOKUP, TEST_LOOKUP, READ_SPAN, MERGE, DEDUP) a implementaciones físicas con costo y access_path (index si hay catálogo `.cqe`, disk si no). `CF_IR=1` adjunta `plan.ir` + `plan.ir_stats` al resultado sin cambiar la ejecución.

| métrica | valor |
|---------|-------|
| parity correctness (T1, 32) | 1.000 |
| parity tokens (stats frescas) | true |
| has_ir | 32/32 |
| access_path index | 32/32 |
| operadores IR vistos | 8/11 |

Veredicto: **PASS (representación)** — el valor está en permitir selección de implementación cost-based sobre el plan físico (los index ops ya existen; pairwise/EU operan sobre planes). Límite conocido: est_cost estático por query_type no correlaciona con tokens reales (spearman ~-0.5 informacional); la cardinalidad per-query es la señal que discrimina (mismo techo de Operator Cost Model REJECT).
