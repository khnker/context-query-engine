# Retriever disagreement → active retrieval

> Veredicto: SIRVE - hipotesis sostenida

Señal de incertidumbre de retrieval sin entrenar modelo: el desacuerdo entre fuentes (lexical/structural/semantic/bm25/git) predice riesgo de GT missing y activa adquisición adicional.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-disagreement.js --adv   # → evals/reports/disagreement-<TS>.json
```

Instrumento (hook CF_DISAGREEMENT_FILE en engine, pre-fuse): agreement_rate = soporte medio de archivos en la unión de top-5 por fuente (paths normalizados; 1 = convergen, 0 = dispersión). 47 queries (T1 + adversarial fan-out):

| estado | P(gt_miss) |
|--------|------------|
| agreement ≥ 0.5 (alta) | **0.000** |
| agreement < 0.5 (baja) | **0.050** |
| no-signal (fuente única: concept/zero-results) | 5/6 misses → abstain |

Hipótesis SOSTENIDA: baja concordancia → más riesgo de miss. Caso validado: adv-po-30 ('main', poliglote) — rg inundado (score 1 uniforme), bm25 irrelevante, agreement 0 → requiere índice estructural/símbolos. Regla de trigger: agreement < 0.5 → adquirir fuentes ausentes; fuente única sin candidatos → abstain. Loop de adquisición runtime = change `adaptive-query-execution`. Instrumentación descartada: Jaccard top-10 entre fuentes (disjuntos por construcción) y margen top1-top2 (scores rg uniformes 1.0).
