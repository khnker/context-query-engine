# Quality-aware selection (REJECT)

> Veredicto: REJECT

Política de escalación simulada offline sobre el artefacto congelado de diagnosis (32 tasks, planes A/B/C forzados): correr en orden de costo estimado y escalar a un plan mayor solo si la señal de calidad observada < umbral.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-quality-policy.js   # → evals/reports/quality-policy-<TS>.json
```

| política | tokens | gt_hits | r@5 | escalaciones |
|----------|--------|---------|-----|--------------|
| cost_only (actual) | 105 | 4.438 | 0.833 | 0 |
| exactness θ=1.0 | 116 | 4.438 | 0.833 | 4 |
| gt_hits θ=5 (techo) | 237 | 4.875 | 1.021* | 17 |
| oracle_quality | 221 | 5.375 | 1.021* | — |

La señal exactness (runtime-observable sin GT) es **plana**: nunca escala el gt (4.438 en todo el sweep) — mismo diagnóstico que cost/quality. Incluso con señal oráculo gt_hits, ningún umbral alcanza el objetivo (≥90% del oráculo @ ≤2.0× tokens): θ=5 da 4.875 (90.7%) pero a 2.26× tokens. La frontera es dura: el +21% de gt_hits del oráculo cuesta 2.1× tokens sin punto medio barato. **Veredicto REJECT** en fixtures sintéticas (plan A ya satisface casi todo); re-testear en repos reales (T2/dev) o exponer tradeoff explícito para queries high-stakes. (*1.021 = anomalía de display del artefacto base.)
