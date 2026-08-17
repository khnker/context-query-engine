# Distribution shift (OOD) — FAIL

> Veredicto: FAIL - OOD/train 9.18x

El cost model ML (cardinality, ridge) se evalúa fuera de su distribución de entrenamiento: train en t1-basic (TypeScript) → val t1-modular (Python) → test dev (workspace real). Se entrena ridge en node (mismo pipeline que classify.mjs) y se compara MAPE ML vs baseline heurístico por op|queryClass.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-distribution-shift.js   # → evals/reports/distribution-shift-<TS>.json
```

| split | MAPE ML |
|-------|---------|
| train (t1-basic, n=25) | 25.9% |
| val (t1-modular, n=17) | 92% (3.6×, shift TS→Python) |
| test (dev, n=6) | 237.3% |

Veredicto: **FAIL** — ratio OOD/train 9.18× (umbral 2×). El baseline heurístico generaliza mejor fuera de distribución (test 28% vs ML 237%). **El fallback heurístico queda como default**; el modelo solo se confía en distribución. Tarea derivada: retrain por repo o regularización/feature engineering antes de usar el cost model OOD. Artefacto: evals/reports/ood-cardinality-model.json.
