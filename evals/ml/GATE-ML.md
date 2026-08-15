# Gate ML — reporte consolidado (fase 15)

Veredicto global del tramo ML del roadmap: **PASS**. El ML local mejora decisiones del engine sin degradar el fallback determinista ni la correctitud del benchmark.

## Tesis

> Un agente resuelve tareas con menos contexto transmitido al LLM si una capa de consulta optimiza qué información recuperar. El ML local (TinyBERT-style) entra al final como operador auxiliar — solo si demuestra mejora contra un optimizer determinista ya competente.

## 1. Baseline determinista (gate 14)

`npm test` 34/34 · `openspec validate --all --strict` 18/18 · `npm run eval` PASS
Harness T1 (40 tasks): C contextforge **100% correctitud, 764 tokens** (104× vs baseline A 139,199), latencia 199 ms. Repo real T2 (polar, 2,129 archivos): C **204× vs baseline**, densidad 0.1875 (la mayor).

## 2. Clasificador de intención (11.4-11.8) — ADOPTADO

| Vía | Accuracy (test 150) |
|-----|--------------------|
| Regex heurística | 0.347 |
| **ML efectivo (gate conf ≥ 0.6)** | **0.94** (fired 135, fallback 15) |
| ML cuando dispara | 1.0 (135/135) |

- Modelo: regresión logística sobre char n-grams 2-4 hashed (H=2048), entrenado out-of-band en numpy (0 deps), inferencia node ~6 ms vía `CF_MODEL_CMD`.
- Español: `es_acc` **1.0** (48 rows) tras ampliar el seed con plantillas ES (166+ rows train).
- Fallback intacto: conf < 0.6 o modelo ausente → regex heurístico.

## 3. Modelo de costo / cardinalidad (13.1-13.7) — ADOPTADO

| Métrica (test 148 obs) | Heurístico | Ridge (ML) |
|------------------------|-----------|------------|
| MAPE cardinalidad | 1.418 | **0.498** |
| P95 error | 5.43 | **2.02** |

Benchmark T1 con modelo activo:
| Métrica C | Sin modelo | Con modelo |
|-----------|-----------|------------|
| Optimizer regret | 0.6886 | **0.6655** (-3.4%) |
| est_mape | 0.8497 | 0.8453 |
| Correctitud | 1.0 | 1.0 |
| Tokens | 764 | 764 |

Planes elegidos idénticos en 40/40 (selección robusta); costo honesto: +195 ms/task por spawn del modelo (memo por proceso; cacheable en mcp-server persistente).

## 4. Reranker (12.1-12.5) — PIPELINE LISTO, adopción pendiente de modelo

- Contrato `rerank` + hook en engine.js + fuse consume `.score` (peso 0.3 en `score_final` + dedup).
- Harness `eval-recall.js` con **MRR** (orden-sensitiva): sanity Δmrr 0.000; stub reversed → Δmrr +0.038 (efecto end-to-end demostrado).
- Sin modelo de relevancia real → no se adopta (gate ML: se medirá recall@k/MRR con el modelo real en 11.10).

## 5. Sin degradación

Todas las integraciones son null-safe: modelo ausente/roto/timeout (2 s) → heurístico. Benchmark antes/después idéntico sin modelo (Δ0 verificado).

## 6. Veredicto

| Componente | Decisión |
|-----------|----------|
| Clasificador de intención | **ADOPTADO** (0.347 → 0.94) |
| Cost model cardinalidad | **ADOPTADO** (MAPE 0.498, regret -3.4%) |
| Reranker | Pendiente de modelo de relevancia real |
| TinyBERT distilled (11.10) | Fuera de alcance sin torch/GPU (artifact swappable, mismo contrato) |

**GATE ML: PASS** — el optimizer determinista sigue siendo el piso; el ML local lo mejora donde entra y nunca lo degrada.

## Reproducibilidad

```bash
npm test && npm run bench          # 34 + métricas duras (61.3% compresión, guardas)
npm run eval                       # harness completo (PASS)
CF_MODEL_CMD="node evals/ml/classify.mjs" node evals/scripts/eval-intent-ml.js   # 11.8
CF_MODEL_CMD="node evals/ml/classify.mjs" node evals/scripts/eval-recall.js       # 12.4
python3 evals/ml/train-cardinality.py                                              # 13.3-13.4
```
