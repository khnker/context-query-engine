# ABSTAIN / No-Answer

> Veredicto: PASS - precision 0.941

Ante queries sin respuesta en el repo, el engine puede **abstener** en vez de devolver resultados débiles: con `CF_ABSTAIN=1`, si la fusión no produce matches relevantes (exact/filename/structural; git-log cuenta como evidencia para planes git), el resultado es `{abstained:true, reason}` con 0 tokens.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-abstain.js   # → evals/reports/abstain-<TS>.json
```

Dataset: 24 queries no-gold (13 símbolos/archivos fabricados + 11 conceptos ausentes, GT vacío) + 32 gold de T1. Métricas:

| métrica | valor |
|---------|-------|
| abstention precision | 0.941 |
| coverage no-gold (abstiene cuando debe) | 0.667 |
| coverage gold (NO abstiene con respuesta real) | 0.969 |
| FP retrieval (no-gold respondido) | 8 |
| FN retrieval (gold abstuvo) | 1 |

Veredicto umbral 6.5 (precision ≥ 0.7 ∧ coverage_gold ≥ 0.8): **PASS**. Los 8 FP son queries semánticas no-gold cuyo ruido weak (match_type semantic, 0 hits reales) supera el umbral; los 2.7k-7.8k tokens muestran escalación semántica sobre consultas inexistentes. FN restante: sem-04 (concept gold con evidencia solo-semántica). Tuning posible: umbral de score en evidencia semántica (hoy binario por match_type).
