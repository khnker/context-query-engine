# Federated Evidence Sources (B9) — SÍ SIRVE (representación)

> Veredicto: SIRVE

Catálogo de 7 planos de evidencia con metadata (cost, latency, freshness, P/R) por query_type.

| plano | access | cost(tok) | lat(ms) | precision | recall | query_types |
|-------|--------|-----------|---------|-----------|--------|-------------|
| lexical | index | 50 | 6 | 0.75 | 0.65 | concept/pattern/default |
| symbol | index | 40 | 4 | 0.95 | 0.60 | definitions/references/impl/filename |
| dependency | index | 80 | 8 | 0.85 | 0.55 | references/implementation |
| callgraph | disk | 200 | 20 | 0.70 | 0.40 | references/implementation/callers |
| history | disk | 120 | 15 | 0.60 | 0.30 | pattern/concept/default |
| test | disk | 80 | 10 | 0.50 | 0.25 | pattern/default |
| semantic | disk | 400 | 50 | 0.65 | 0.80 | concept/pattern/default |

Resultado: 24/32 tasks con metadata adjunta (stats.federated), 7 planos cubriendo todos los query_types. Aditivo — no muta ejecución. El catálogo habilita selección de planos por cost-benefit en VoI/B8.
