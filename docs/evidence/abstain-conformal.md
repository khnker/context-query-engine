# Abstain calibration (conformal) — REJECT

> Veredicto: REJECT (con hallazgo)

Split-conformal para abstention: nonconformity = 1 − max evidence strength (tiers por match_type), θ = 1 − q̂ calibrado, modo `CF_ABSTAIN_CONFORMAL=1`. Resultado (α=0.2, holdout 8 gold + 24 no-gold): gold_calibrated θ=1.0 → **gold coverage 0.875 ≥ 0.80 ✓**, no-gold 0.625 (< 0.667 ✗), precision 0.938 ✓; mixed θ=0.0 → responde todo (garantiza cobertura, abstention 0). **Veredicto: REJECT con hallazgo** — la evidencia strength no separa gold de no-gold (los FP alcanzan tier0 = strength 1.0 igual que gold); conformal honesto colapsa a la regla binaria legacy (θ=1), que queda CONFIRMADA como abstain máximo consistente con la garantía de cobertura (formalizada: P(GT∈context) ≥ 1−α bajo exchangeability). Mejora de no-gold requiere señal de distribución de query o score de modelo calibrado, no umbral de evidencia.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-conformal.js   # → evals/reports/abstain-conformal-<TS>.json
```
