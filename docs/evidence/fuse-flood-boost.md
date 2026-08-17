# Fuse Flood Boost (A3) — REJECT parcial, root cause: dedup por path

> Veredicto: REJECT parcial

CF_FLOOD_BOOST añade bonus a score_final para evidencia adquirida (structural/symbol-lookup/dependency-expand/read-span) en assemble-context.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-flood-boost.js   # → evals/reports/flood-boost-<TS>.json
```

| config | correct | gt | tokens |
|--------|---------|----|--------|
| baseline | 0.855 | 3.823 | 1572 |
| boost 0.2 | 0.855 | 3.839 | 1572 |
| adaptive | 0.855 | 3.823 | 1591 |
| adaptive+boost | 0.855 | 3.839 | 1591 |

Sin regresión (T1 1.000 en todas), pero adv-po-30 NO se rescata: el flood (coverage 1.0, n_pool 7309) dispara la adquisición, pero las filas adquiridas se dedupean por path contra el flood existente → no queda evidencia adquirida que boostear; el GT queda fuera del budget por tie-order de rg exact 0.86. Fix derivado: UPSERT por path en adquisición (reemplazar fila flood por la adquirida con mayor certeza/span) — para B8.
