# CQE vs hybrid retrieval

> Veredicto: SIRVE - recall@5 +3.7pp

CQE se evalúa como optimizer *por encima* del algoritmo de retrieval subyacente: los mismos planes de ops corren sobre rg (baseline), sobre un op BM25 propio en node (`engine/bm25.js`, stdlib, sin deps) y sobre la fusión de ambos (`CF_RETRIEVAL=hybrid`). El modo dense (embeddings) queda marcado como `requires-dep` — el proyecto es stdlib solo.

```bash
TMPDIR=$PWD/.tmp CF_TASKS=t1 node evals/scripts/eval-hybrid.js   # matriz → evals/reports/hybrid-<TS>.json
```

Matriz T1 (32 tasks, 1 run):

| config | correctness | recall@5 | MRR | tokens (mean) |
|--------|-------------|----------|-----|---------------|
| BM25 puro | 0.844 | 0.667 | 0.732 | 135 |
| CQE+hybrid | **1.000** | **0.870** | 0.939 | 239 |
| CQE+hybrid+rerank | 1.000 | 0.870 | 0.964 | 253 |
| CQE (baseline) | 1.000 | 0.833 | 0.939 | 105 |
| CQE+rerank | 1.000 | 0.833 | 0.964 | 105 |

Veredicto: **hybrid no degrada correctness** (1.000 = 1.000 en T1 y T2) y **mejora recall@5 en T1** (+3.7pp, 0.870 vs 0.833) — BM25 rescata hits que rg pierde. Costo: 2.3× tokens por los snippets BM25; la fusión compite en score_final de `assemble-context`. BM25 puro pierde correctness (0.844): no reemplaza a CQE, solo aporta como op de fusión. En dev (monorepo), BM25 puro falla (cap de 1000 archivos del índice) — el optimizer + rg siguen siendo necesarios. El op `bm25` queda incorporado al plan físico (COST_TABLE + `CF_RETRIEVAL`).

Veredicto: **hybrid no degrada correctness** (1.000 = 1.000 en T1 y T2) y **mejora recall@5 en T1** (+3.7pp, 0.870 vs 0.833) — BM25 rescata hits que rg pierde. Costo: 2.3× tokens por los snippets BM25; la fusión compite en score_final de `assemble-context`. BM25 puro pierde correctness (0.844): no reemplaza a CQE, solo aporta como op de fusión. En dev (monorepo), BM25 puro falla (cap de 1000 archivos del índice) — el optimizer + rg siguen siendo necesarios. El op `bm25` queda incorporado al plan físico (COST_TABLE + `CF_RETRIEVAL`).

### Reranker–fuse alignment (fix de recall)

El reranker subía MRR pero BAJABA recall@5 (0.630 vs 0.833). Diagnóstico por etapas (`eval-rerank-stages.js`): candidate recall 1.0 (el GT siempre está en el pool), el reranker MEJORA el pool (0.818→0.833), y la pérdida ocurría en la **fusión**: el modelo puntuaba el GT exacto con ~0.003 (char-ngrams q+p sin vocabulario de código) y el filtro `score >= 0.2` de `assemble-context` lo ELIMINABA. Fix: anclaje de matches exact/filename/structural (conservan score heurístico, siempre arriba) + floor 0.3 al score del modelo (nunca bajo el filtro) + `CF_SCORE_WEIGHT` (peso del score en score_final: 0.3 legacy, 0.5 automático con modelo). Resultado: recall@5 del rerank = heur (0.833, sin sacrificio) con MRR aún mejor (0.964 vs 0.939); hybrid+rerank 0.870 r@5.
