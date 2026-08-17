# Evidence Semantics (B13) — SÍ SIRVE (contrato tipado Score<T>)

> Veredicto: SIRVE - contrato 223/223

Cada row del resultado es un packet con `score_t` de namespaces disjuntos: `score_t.evidence` (determinista: exact/filename/structural, certainty 1.0) vs `score_t.estimate` (probabilístico: semantic/bm25/rerank, certainty < 1.0). El flat `score` se conserva solo como compat legacy (assemble-context jq y selectores lo leen); el modelo tipado es `score_t`. Provenance completa en cada row hasta la selección: `provenance.{operator, parser, index_version, query, tier}` + `evidence_tier` derivado del match_type. Eligibility por tipo: tier0 determinista NUNCA eliminado por score probabilístico — en fuse/rerank (anclaje `ANCHORED`, engine.js) y en selector (guard marginal sobre el knee de adaptive-k + boost MMR, selector.js).

| Campo | Tipo | Namespace |
|-------|------|-----------|
| score_t.evidence | determinista | evidence |
| score_t.estimate | probabilístico | estimates |
| cost.tokens | costo | cost |
| provenance.{operator,query,tier} | trazabilidad | provenance |
| score (flat) | legacy compat | deprecated |

Resultado eval `evidence-semantics-*.json`: 32 tasks / 223 rows, contrato 223/223 (score_t disjunto + provenance query/tier), 210 rows tier0 en output seleccionado, 0 eliminadas por score. `test/evidence-semantics.test.js` (5 asserts) fija el contrato.
