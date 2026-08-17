# Repo-Calibrated Cardinality (B11) — NO SIRVE (OOD dev)

> Veredicto: NO SIRVE

Calibración del estimador de cardinalidad por repo: modelo global (ridge) + per-repo profile (residuos por `op|queryClass` vía `repo:<fp>|op|qc` en `statistics.js`) + corrección online en `estimateCandidates(repoFp)`. `CF_FINGERPRINT=1` activa los fingerprints.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-calibrated.js --limit 6   # → evals/reports/calibrated-<TS>.json
```

Resultado (train=t1-basic TS, val=t1-modular Python, test=dev OOD):

| grupo | global MAPE | calibrated MAPE | heur MAPE |
|-------|------------|-----------------|-----------|
| train | 29.4% | 45.0% | 32.4% |
| val | 122.5% | 74.1% | 144.8% |
| test (dev) | 339.0% | 339.0% | 27.7% |

La calibración por repo SÍ mejora val (122.5% → 74.1%, < 2×heur) — el residual per-repo captura el shift de lenguaje TS→Python. Pero en dev (repo nuevo sin profile previo) la corrección no aplica (339% = global ML), muy por encima del umbral 2×heur (55.4%). Confirma el patrón previo: el modelo ML global no generaliza a workspaces reales; el heurístico por (op,qc) sigue siendo el default robusto. REJECT — se mantiene `cardinality-model-ood.json` como fallback opcional, heurístico ON.
