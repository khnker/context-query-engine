# Cheap query bypass — SÍ SIRVE (parcial)

> Veredicto: SIRVE (parcial)

"Optimizar tiene costo": queries triviales (filename inequívoco + repo < 500 archivos) van directo a rg-files + fuse, sin optimizer/plans/cost model (`CF_BYPASS=1`).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-bypass.js   # → evals/reports/bypass-<TS>.json
```

| set | correctness | latencia | tokens |
|-----|-------------|----------|--------|
| trivial baseline | 1.000 | 162ms | 73 |
| trivial bypass | 1.000 | 152ms | 73 |
| T1 baseline | 1.000 | — | 104 |
| T1 bypass | 1.000 | — | 105 |

Verdict: **PASS** (correctness igual en ambos, latencia <= baseline, sin regresión). Matices: bypass_rate 0.17 (solo triviales de repos chicos; polar >500 files fuera por diseño); el objetivo <20ms no es alcanzable vía spawn CLI (floor de node ~40ms) — sí en modo daemon/MCP (cqs-style).
