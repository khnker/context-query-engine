# Typed Rank Fusion (RRF) — B1

> Veredicto: mixta - -41% tokens, mrr -5.7pp

Fusión por RANGO multi-fuente con pesos por query-type (`CF_RRF=1` + `CF_RRF_RANK=1`): cada fuente (rg/bm25/structural/git/index) aporta un ranking y se combina Σ w_tier·1/(k+rank), dedupe a una fila por path.

| métrica | baseline | rrf |
|---------|----------|-----|
| correctness | 0.855 | **0.871** |
| mrr | 0.640 | 0.583 |
| tokens | 1572 | **933** (−41%) |

Veredicto: **FAIL por umbral, señal MIXTA** — gana cobertura (+1.6pp correctness) y reduce tokens 41% (dedupe por path), pero pierde precisión de rank (mrr −5.7pp). RRF sirve para paths diversity-first (fan-out/coverage), no para precision-first. Disponible opt-in, default intacto.
