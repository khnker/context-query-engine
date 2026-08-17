# Execution Receipts (B4) — SÍ SIRVE

> Veredicto: SIRVE

Receipt por query con `CF_RECEIPT=1`: separa **seen** (evidencia determinista tier0, certainty 1.0) de **inferred** (semántica/bm25) y **unknown** (códigos: no-candidates / single-source / low-agreement desde belief), con cadena de provenance evidencia→claim (evidence_id de evidence-packet en cada fila + claims por span).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-receipts.js   # → evals/reports/receipts-<TS>.json
```

| métrica | valor |
|---------|-------|
| parity correctness (38 tasks) | 38/38 |
| receipts con evidence_id | 38/38 |
| GT en receipt | 35/38 (3 misses = zero-results abstain ✓) |
| seen / inferred / unknown / claims | 1360 / 13 / 34 / 1373 |

`files_touched`/`tests_run` quedan para que el agente anote post-acción (schema listo para auditoría evidencia→cambio).
