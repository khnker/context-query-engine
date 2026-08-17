# Physical query decomposition (CF_DECOMPOSE=1) — NO sirve (REJECT parcial)

> Veredicto: NO sirve

Descomposición determinista (sin LLM) de queries multi-facet en sub-consultas por keywords EN+ES (`engine/decompose.js`): facetas persistence/callers/definition → `FIND references/definitions/implementation OF symbol <name>`.

| modo | correctness | tokens (medio) |
|------|-------------|----------------|
| baseline | 0.900 | ~4.5k |
| CF_DECOMPOSE=1 | 0.900 | +3006 (2-3×) |

Veredicto: **NO sirve en el corpus actual** — gt gain 0/10 (la intención resuelta ya cubre la faceta principal); costos 2-3× (polar 2×). `CF_DECOMPOSE` OFF por default. Escenario de ganancia real (entidad con callers/impl distintos del def) no representado en fixtures — anotado para re-test. El mecanismo determinista funciona (facetas 7/10).
