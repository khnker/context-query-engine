## 1. Evaluación de validación (antes/después)

- [x] 1.1 Probe est-vs-actual por operador: `evals/scripts/eval-cardinality-error.js` (MAPE candidates/tokens + reopt opportunities) → evals/reports/cardinality-error.json
- [x] 1.2 Baseline T1 completo (32 tasks, 42 records): MAPE candidates follow/references 100%, include 70%, rg-files 58%, search-code ~50%; reopt>2× = 0 → umbral efectivo 0.5
- [x] 1.3 Ablation AQP v1 (CF_REOPT=1, T1 completo): correctness 0.969 vs 1.0 baseline (**REJECT**), tokens neutro (55.9 vs 56.0), latency −25ms. Falló git-01: under-return-skip mató git-log (fuente del GT de queries git). Reporte: evals/reports/aqp-v1-20260815.json
- [ ] 1.4 Ablation AQP v2 (hipótesis refinada: skip solo léxico-redundante, nunca git-log/follow/include) → correctness ≥ 1.0 y tokens ≤ baseline en T1

## 2. Implementación

- [x] 2.1 Hook post-ejecución en engine.js runPlan (CF_REOPT=1, off por defecto; CF_REOPT_THRESHOLD=0.5): over-return-skip (follow/include pendientes + relevant>0) y under-return-skip (est>0, actual 0, pendientes search-semantic/git-log/follow)
- [ ] 2.2 AQP v2: restringir under-return-skip a ops léxicas redundantes (nunca git-log/follow/include; nunca en la primera op del plan)
- [x] 2.3 Tests: test/adaptive.test.js (off por defecto, under-return determinista, guards filename) — suite 40/40
