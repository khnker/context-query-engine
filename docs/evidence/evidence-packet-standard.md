# Evidence Packet Standard — SÍ SIRVE (representación)

> Veredicto: SIRVE

Cada resultado de retrieval es un **packet tipado** `{evidence_id, subject{file,symbol,lines}, claim, evidence_type, certainty, source, provenance{operator,parser,index_version}, cost{tokens,latency_ms}}` (engine/evidence.js, aditivo sobre el contrato flat de fuse). La **certainty es tipo epistémico** (determinista tier0 = 1.0, estimación semantic = 0.6), ortogonal al score de ranking — el reranker interpreta evidencia, nunca la sobrescribe (el bug 0.0034 es estructuralmente imposible; el filtro de fuse opera sobre score, no sobre certainty).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-evidence-packets.js   # → evals/reports/evidence-packets-<TS>.json
```

Paridad T1: correctness 1.000 = 1.000 (aditivo), 214 packets con schema completa, tier0 certainty 1.0 ✓. Habilita selección por certeza/provenance en selector.js.
