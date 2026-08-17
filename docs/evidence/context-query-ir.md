# Context query IR (CF_INDEX=1) — PASSA

> Veredicto: SIRVE - 2.9x menos tokens

Access paths materializados: el planner puede sustituir ops sobre filesystem crudo por consultas al catálogo (engine/index-layer) — `CF_INDEX=1` mapea search-code/rg-files→lexical-index, search-structure→dependency-expand (solo definitions/references/implementation/filename; pattern/concept conservan rg, FTS no es regex).

```bash
TMPDIR=$PWD/.tmp CF_TASKS=t1 node evals/scripts/eval-ir.js   # → evals/reports/ir-<TS>.json
```

| modo | correctness | tokens | r@5 | MRR |
|------|-------------|--------|-----|-----|
| cqe (rg) | 1.000 | 104 | 0.833 | 0.939 |
| index (CF_INDEX=1) | **1.000** | **36** (2.9× menos) | 0.823 | 0.720 |

Veredicto: **SÍ sirve** — 2.9× menos tokens sin perder correctness; MRR menor porque las filas del índice no traen spans de línea exactos (siguiente: op físico READ_SPAN). Costo: build 326-341ms. Descartados con evidencia: AND-tokens camelCase, symbol-lookup para filename, substitución en pattern/concept.
