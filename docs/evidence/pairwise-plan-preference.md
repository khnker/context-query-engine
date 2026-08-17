# Pairwise plan preference (Lero) — paso 08, SÍ SIRVE

> Veredicto: SIRVE - gt +19.5%

Primera vía de aprendizaje que mejora la selección de plan. Modelo logístico pairwise (numpy, sin deps): aprende P(A≻B | features del par + query_type) del OUTCOME real (gt_hits), no de costos estimados — la diferencia clave vs los 4 REJECTs previos (EU/plan-variant/cost-model/quality-aware).

```bash
python3 evals/ml/train-pairwise.py                      # 74 tasks, 222 pares → pairwise-model.json
TMPDIR=$PWD/.tmp node evals/scripts/eval-pairwise.js    # → evals/reports/pairwise-<TS>.json
```

| selector | plan_acc | gt_hits (media) | tokens | correctness |
|----------|----------|-----------------|--------|-------------|
| cost_only (default) | 0.608 | 2.770 | 1393 | 0.851 |
| pairwise | **0.635** | **3.311 (+19.5%)** | 1417 (+24) | **0.851** |

Veredicto: **SÍ sirve** — +19.5% gt_hits con tokens casi iguales. Holdout 0.733 (balanced 0.842). Aprender el orden relativo cancela el ruido de escala entre queries que rompía la regresión de costos. Pendiente: integración runtime en optimizer.js (el modelo ya está disponible; la simulación fue offline sobre perTask).
