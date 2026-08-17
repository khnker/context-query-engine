# Learned Plan Steering (B12) — PARITY (sin señal pre-ejecución)

> Veredicto: PARITY

Hint ligero sobre el optimizer determinista (Bao-style, NO reemplazo): ranking aprendido del modelo pairwise (Lero) + umbral de confianza + Thompson sampling. `engine/hint.js` exporta `hintSelect`; en `optimize()` se aplica como capa posterior a la selección determinista: solo inclina si `confianza >= umbral` (default 0.35, env `CF_HINT_THRESHOLD`); `CF_HINT=1` lo activa.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-hint.js   # → evals/reports/hint-<TS>.json
```

Resultado (T1, 32 tasks, oracle FORCE_PLAN A/B/C):

| métrica | default | hint |
|---------|---------|------|
| plan_accuracy | 0.53 | 0.25 |
| avg_gt_hits | 3.125 | 3.125 |
| avg_tokens | 132.7 | 132.7 |
| override_rate | — | 0.50 |

El hint nunca cambia de familia de plan (A/B/C): los 16/32 overrides son entre una variante y su rewrite (`Ar`/`Br`), que tienen las MISMAS ops y features pre-ejecución → score pairwise idéntico → confianza≈0 → Thompson elige al azar entre equivalentes. gt_hits y tokens idénticos en todos los casos. Diagnóstico: sin features post-hoc (gt_hits/exactness/n_results/recall5/mrr = 0 pre-ejecución) el ranking aprendido no discrimina — la señal solo aparece en runtime, ya capturada por `CF_PAIRWISE` (pairwise-runtime PASS gt 0.906). PARITY: no degrada outcome, pero el hint pre-ejecución no aporta; no se activa por defecto.
