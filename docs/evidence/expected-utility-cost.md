# Expected Utility Cost Model (REJECT)

> Veredicto: REJECT

El optimizer puede seleccionar por utilidad esperada (`CF_UTILITY=1`): EU = P(correct|plan)·value − tokens·Wt − latency·Wl − (1−P)·failure_penalty·Wf, con P(correct) derivada de la varianza del cardinality estimator (varianceTokens). Ablación sobre T1 (32 tasks) vs selección actual (cost/quality): **no mejora** — correctness 1.000 = 1.000, pero regret 0.1633 = 0.1633 (0% reducción, umbral 10%).

```bash
TMPDIR=$PWD/.tmp CF_TASKS=t1 node evals/scripts/eval-utility.js   # → evals/reports/utility-<TS>.json
```

| selector | plan_acc | regret | tokens | correctness |
|----------|----------|--------|--------|-------------|
| cost/quality (actual) | 0.906 | 0.163 | 105 | 1.000 |
| EU (CF_UTILITY=1) | 0.438 | 0.163 | 105 | 1.000 |

Root cause: la señal de varianza no diferencia variantes de plan (comparten el op primario y costos de tokens casi idénticos) → EU degenera a ranking por costo. El oráculo distingue por tie-break de gt_hits, no por tokens. Fix necesario (tarea derivada): señal de incertidumbre POR VARIANTE (varianza de est_candidates o success rate por plan id). El modo queda disponible sin tocar el default.
