# Claim-Level Context (B3) — SÍ SIRVE

> Veredicto: SIRVE - -58.6% tokens

La unidad de contexto es el **claim** (span mínimo con evidencia), no el archivo completo. `CF_CLAIMS=1` materializa los resultados como `{claim_id, subject, text, evidence:[{path, lines}], evidence_type, certainty, source, cost}`.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-claim.js   # → evals/reports/claims-<TS>.json
```

44 tasks (T1 + fan-out): coverage **0.977 = 0.977** (parity), tokens 53681 → 25040 (**−58.6%**). Habilita evaluación line-level (SWE-Explore-style) y el op físico READ_SPAN para materializar solo lo necesario.
