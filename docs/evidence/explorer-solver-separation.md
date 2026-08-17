# Explorer-Solver Separation (FastContext) — SÍ SIRVE

> Veredicto: SIRVE - -59% tokens

El explorador (modo headless `CF_EXPLORER=1`) devuelve **evidence references** — `{path, lines:[start,end], reason, certainty}` + `next_actions: [{operator, target, eig}]` — no dumps de contenido. El solver recibe 59% menos tokens (2336 → 1100 media sobre 22 tasks downstream+adversarial) con correctness idéntica (0.955 = 0.955).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-explorer.js   # → evals/reports/explorer-<TS>.json
```

next_actions se derivan del belief state: agreement<0.5 → symbol-lookup (eig 0.7); relations sin reference → follow (0.5); inclusions sin test/config → read_span (0.4). El ahorro es el costo que el solver no paga en lectura temprana; los spans (`line_start/line_end` de la evidencia) habilitan el operador físico READ_SPAN del roadmap.
