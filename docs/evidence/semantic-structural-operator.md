# Semantic-Structural Operator (CeQe) — SÍ SIRVE (dc-13 fijo)

> Veredicto: SIRVE - dc-13 fijo

Concept queries cuya implementación no tiene match léxico (dc-13: 'dependency injection' → app.module.ts encontrado por `@Module`) ahora resuelven: tras el plan, si el pool de un concept es mayoría-docs sin evidencia estructural, se escanean anclas de framework (`@Module`, `@Injectable`, `providers:`, `app.use`...) y se anexan los archivos con más anclas (solo implementación, docs excluidos).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-structural.js   # → evals/reports/structural-<TS>.json
```

| categoría | antes | después |
|-----------|-------|---------|
| deep-dependency-chain | 0.667 | **1.000** |
| vendor-code | 1.000 | 1.000 |
| T1 (32) | 1.000 | 1.000 |

Hallazgo de diseño: la evidencia del *concept* (docs con match léxico) no es evidencia de la *implementación* estructural — el gate correcto es "mayoría docs + 0 filas estructurales", no "pool vacío". Costo: +15 filas/ancla solo en el caso miss (raro); sin regresión en ninguna categoría.
