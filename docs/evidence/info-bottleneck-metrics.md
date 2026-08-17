# Information Bottleneck Metrics (B5) — SÍ SIRVE (métrica estándar)

> Veredicto: SIRVE

Métrica primaria: **task-information density = Δ task success / Δ token** (y success/token por config) — un contexto de 8000 tokens puede tener utilidad radicalmente distinta; `tokens ≤ 8000` solo es el cap, no la calidad.

```bash
node evals/scripts/eval-ib-metrics.js   # → evals/reports/information-bottleneck-<TS>.json
```

| harness | config | success/token |
|---------|--------|---------------|
| downstream | raw | 0.00307 |
| downstream | cqe | 0.00287 (Δsuccess/Δtokens 0.0024) |
| context-selection @400 | topk | 0.0175 |
| context-selection @400 | mmr | **0.0178** |

La densidad se agregó a `report.md`/`metrics.json` del reproduce.sh como métrica estándar por modo. Hallazgo: topk gana densidad en budget holgado, MMR en tight — el par (density, correctness) discrimina configs, no una sola métrica.
