# Adaptive Context Budget (Adaptive-k) — B2, SÍ SIRVE (parity)

> Veredicto: SIRVE (parity)

Selección con parada por diminishing returns: `CF_ADAPTIVE_K=1` + `CF_ADAPTIVE_K_THETA` (knee de la curva de marginal gain = θ·maxGain) integrado a `CF_SELECTOR=marginal` en engine/selector.js.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-adaptive-k.js   # → evals/reports/adaptive-k-<TS>.json
```

44 tasks (fanout + T1), budgets 2000/8000, θ sweep 0.05-0.20: **PASS — density adaptive 0.011105 = topk 0.011105, parity ✓**. Hallazgo: la curva de marginal gain no tiene rodilla en este corpus (top-k y adaptive-k idénticos en todo el sweep) — el knee solo corta en rankings con cola de baja ganancia (flood de ruido, p.ej. adv-po-30), no representado aquí. Sin regresión; el mecanismo queda disponible.
