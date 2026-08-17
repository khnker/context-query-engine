# Pairwise Runtime (A1) — PARITY, señal pre-ejecución inerte

> Veredicto: PARITY

CF_PAIRWISE=1 integra el modelo pairwise (Lero) en optimizer.js: score por plan = Σ P(plan ≻ otro) con features de las ops (est_tokens/latencia) y features post-hoc (gt_hits/exactness/n_results/recall5/mrr) = 0 pre-ejecución.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-pairwise-runtime.js   # → evals/reports/pairwise-runtime-<TS>.json
```

| selector | plan_acc | gt_hits | tokens | correctness |
|----------|----------|---------|--------|-------------|
| default | 0.906 | 4.406 | 105 | 1.000 |
| pairwise runtime | 0.906 | 4.406 | 105 | 1.000 |

Paridad exacta — sin regresión, pero el +19.5% gt del paso 08 (offline) NO se reproduce pre-ejecución: la señal vive en los features post-ejecución (gt_hits/exactness/n_results), que son 0 antes de correr. Conclusión: Lero no reemplaza la selección inicial; su valor es ADAPTAR tras observar la primera op → motor de re-selección en adaptive-query-execution (B8). CF_PAIRWISE queda disponible, default intacto.
