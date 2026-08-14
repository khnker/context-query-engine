# Context Budget

Presupuestos de tokens por nivel. Cada consulta de retrieval declara un nivel BUDGET; el motor corta al exceder.

## Niveles (BUDGET map)

| Nivel | Tokens | Uso típico |
|-------|--------|------------|
| S | 2000 | Snippet puntual, verificar existencia, lookup de constante |
| M | 8000 | Función + callers directos, cambiar comportamiento local |
| L | 20000 | Subsystem completo, entender módulo antes de refactor |
| XL | 30000 | Análisis de repo completo, auditoría de impacto global |

## Reglas

1. **Declarar presupuesto antes de consultar** — el query type sugiere nivel (ver tabla).
2. **Cada tool reporta tokens estimados** del resultado antes de insertarlo en contexto.
3. **Subir nivel solo si el query type lo justifica**: pasar de M a L requiere nueva necesidad (más callers, otro módulo), no por vaguedad.
4. **Bajar al saturar**: si los resultados del nivel no aportan información nueva, cortar y reportar lo útil.
5. **Early termination**: detener la consulta cuando el resultado satisface la pregunta. No completar la lista "por si acaso".

## Límites duros por fase

| Fase | Presupuesto |
|------|-------------|
| Reconocimiento (project map, tokei, git ls-files) | ≤ 2000 |
| Lexical (rg global) | ≤ 8000 |
| Structural (ast-grep/LSP) | ≤ 16000 |
| Semántico (Probe) | ≤ 20000 |
| Consolidación final | ≤ presupuesto declarado |

## Terminación temprana

- La pregunta está respondida → STOP (no consumir más presupuesto).
- Resultados repetidos entre tools → dedup, no re-ejecutar.
- Solo resultados no relevantes en N intentos → escalar nivel de herramienta (policy), no ampliar presupuesto.
- Presupuesto excedido → reportar resultados parciales + qué falta.

## Excepción

Presupuesto puede excederse únicamente si el resultado está a medias y la información parcial no permite decidir; justificar en el reporte. Exceder 2 niveles (ej. M→XL) sin justificación = violación.

## Ajustes empíricos (grupo 8)

Datos reales de `evals/metrics.ndjson` (20 rows, tasks t01-t10, 6 query types; 10 skill vs 10 baseline):

| Query type | Skill avg tokens | Baseline avg tokens | Ratio | Delta |
|------------|------------------|---------------------|-------|-------|
| identifier | 208 | 3308 | 0.06 | -3100 (-94%) |
| filename | 32 | 102 | 0.32 | -70 (-68%) |
| pattern | 178 | 380 | 0.47 | -202 (-53%) |
| concept | 2329 | 3014 | 0.77 | -685 (-23%) |
| symbol | 535 | 460 | 1.16 | +75 (+16%) |
| repo_map | 97 | 19 | 5.11 | +78 (+411%) |

Ajustes de presupuesto según evidencia:
- **S (2000) se mantiene** para identifier/filename/pattern: máximos observados 212/41/202 tokens → holgura >10x.
- **concept**: promedio 2329 > S (2000) → requiere nivel **M (8000)** o dedicado `concept=4000`; no es query S.
- **symbol**: máx 895, avg 535 → cabe en S (2000), no escala a M.
- **repo_map**: skill ineficiente (97 tokens/1 resultado vs baseline 19 tokens/5 resultados) → revisar política (ver retrieval-policy.md .
