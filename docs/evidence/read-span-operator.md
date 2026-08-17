# Read Span Operator (A2) — SÍ SIRVE

> Veredicto: SIRVE - reduction 0.505

Operador físico `read-span` en engine.js: materializa SOLO el span (path + [line_start, line_end]) de un row de evidencia, no el archivo. COST_TABLE: 40 tokens / 2ms.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-read-span.js   # → evals/reports/read-span-<TS>.json
```

| métrica | valor |
|---------|-------|
| avg reduction (span vs archivo) | 0.505 |
| span_hit | 1.000 |
| correctness with_span | 1.000 (= baseline) |

Span [l-2, l+8] sobre la línea real del símbolo. Bugs de eval fijados (documentados en tasks.md): rows con line_start default 1 (rg-files/git-log) → resolver línea real; queries file/concept → hit a nivel archivo; regex multi-word sin comillas. Habilita references-en-vez-de-dumps (FastContext) y conecta con explorer next_actions + evidence packets.
