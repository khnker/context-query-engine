# Context selection (MMR) — paso 06

> Veredicto: PASS

Selección de contexto bajo budget duro vía MMR real en `engine/selector.js` (`CF_SELECTOR=mmr`, λ=0.7, sameRegion dirname=1/prefijo-compartido=0.5), comparada con el greedy marginal y con top-k.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-ssm.js   # → evals/reports/ssm-<TS>.json
```

44 tasks (12 adversarial fan-out + 32 T1), ranked único con `CF_SELECTOR_RANKED_ONLY=1` + hybrid; selectores reales offline a 2000/800/400:

| budget | top-k gt | marginal gt | MMR gt |
|--------|----------|-------------|--------|
| 2000 | 208 | 233 | 233 |
| 800 | 208 | 224 | 212 |
| 400 (tight) | 204 | 204 | **207** |

Veredicto **PASS**: MMR ≥ top-k en tight (207 ≥ 204) y sin regresión en T1 loose (197 = 197); smoke end-to-end `CF_SELECTOR=mmr CF_SELECTOR_BUDGET=400` verificado en fan-out. Lectura: MMR gana cuando el budget aprieta (diversidad evita cluster de ruido); marginal en budget medio; ambos ≥ top-k en todo el sweep. Tuning de λ por familia de query = refinamiento.
