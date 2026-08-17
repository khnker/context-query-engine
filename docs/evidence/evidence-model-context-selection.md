# Evidence Model + Context Selection (07A ADOPTED / 07B REJECT parcial)

> Veredicto: 07A ADOPTED / 07B REJECT parcial

El score no es el lenguaje universal: evidencia determinista (exact/filename/structural = hecho observado) y estimaciones (semantic/reranker = belief) viven en espacios epistémicos distintos. La fusión ahora usa **eligibility por tier** (`evidence_tier <= 1` → siempre elegible; tier2+ → umbral 0.2) y el reranker deja el score crudo del modelo (el floor 0.3 desapareció — su rol lo tomó la eligibilidad). Context selection submodular (`CF_SELECTOR=marginal`, engine/selector.js): greedy por ganancia marginal bajo budget duro; con budget holgado es inerte (sin pérdida), con budget tight (fan-out) la variante MMR supera a top-k (gt +14%, density 0.0063 vs 0.0055).

```bash
TMPDIR=$PWD/.tmp CF_TASKS=adv CF_SELECTOR_BUDGET=400 node evals/scripts/eval-context-selection.js
```

| selector | gt_hits | tokens | dirs | density |
|----------|---------|--------|------|---------|
| top-k (fuse legacy) | 1.75 | 319 | 17.0 | 0.0055 |
| MMR (λ=0.7) | **2.00** | 318 | **17.3** | **0.0063** |
| marginal (07B v1) | 1.75 | 319 | 17.0 | 0.0055 |

Iteración siguiente: calibrar pesos de marginal (diversidad/redundancia) o adoptar CF_SELECTOR=mmr. Ver también: pairwise-plan-preference, adaptive-query-execution (backlog v1.7).
