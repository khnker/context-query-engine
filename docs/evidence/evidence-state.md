# Evidence State (REJECT parcial)

> Veredicto: REJECT parcial

Belief state por query (`stats.belief`): sources, agreement_rate (soporte cross-source top-5), coverage_estimate (fracción de evidencia determinista tier0/1 en el pool), n_pool. Correlación Spearman vs gt_hit sobre T1 + adversarial fan-out (47 queries):

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-evidence-state.js   # → evals/reports/evidence-state-<TS>.json
```

| señal | Spearman |
|-------|----------|
| coverage_estimate | **-0.268** (anti-correla) |
| agreement_rate | +0.155 (débil) |

Hallazgo: coverage alto ≠ confianza — la inundación léxica (rg score 1 uniforme sobre símbolos comunes tipo 'main') llena el pool de tier0 y es justo el caso miss. coverage sirve como señal ANTI (flood-detection), no de suficiencia; agreement es la señal usable para adquirir (coherente con retriever-disagreement). Umbral 1.4 no cumplido → REJECT; señales documentadas para adaptive-plan-selection.
