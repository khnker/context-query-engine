# Backlog Audit v1.7 (B15) — inventario y archivo de superseded

> Veredicto: gobernanza - 28 archivados

Auditoría de los cambios OpenSpec abiertos. Resultado: **28 archivados** (superseded o satisfechos), **2 activos** restantes (sin contar este cambio de gobernanza).

| Categoría | Cambios archivados | Rationale |
|---|---|---|
| TinyBERT cluster | tinybert-cost-model, tinybert-local, tinybert-query-classifier, tinybert-reranker | ridge elegido como operador de aprendizaje; TinyBERT = implementación candidata, no pieza arquitectónica |
| Learned optimizer | learned-optimizer, adaptive-optimizer, contextual-bandits, cost-based-plan-selection, plan-space-search, oracle-optimizer-benchmark, learned-cost-model-v2, uncertainty-aware-cost, model-choice-ablation | cubierto por adaptive-plan-selection, learned-plan-steering (B12), operator-cost-model, optimizer-advanced |
| Cardinality / IR / física | cardinality-estimation, adaptive-query-processing, context-query-ir, introduce-context-query-ir, formalize-physical-operators, value-of-information | cubierto por repo-calibrated-cardinality (B11), adaptive-query-execution (B8), context-compilation-ir (B6), information-acquisition-voi (B7) |
| Contexto / harness | context-quality-optimization, reproducible-evaluation | cubierto por context-selection, adaptive-context-budget, harness-bounded-reproducible |
| Satisfechos | local-model-interface, repository-statistics, rename-cql-to-cqp, roadmap-orchestrator, establish-evaluation-framework, external-agent-benchmarks | trabajo ejecutado y documentado en este README (B1-B14) |
| Abandonado | test-register-check | sin spec, sin tasks |

Activos restantes: `cqe-thesis` (B16), `soundex-fallback` (backlog futuro, no superseded).
