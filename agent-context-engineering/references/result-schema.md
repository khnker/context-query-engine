# Schema de Resultado de Retrieval

Schema normalizado que produce cualquier herramienta de retrieval del pipeline
(`search-code`, `search-structure`, `extract-context`, `project-map`) y que
consume `scripts/assemble-context` para ensamblar el contexto final.

Cada resultado de retrieval es UNA línea NDJSON (objeto JSON por línea).

## Formato

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `source` | string | Herramienta que produjo el match: `rg` \| `fd` \| `ast-grep` \| `lsp` \| `probe` \| `git`. Default si falta: `unknown`. |
| `path` | string | Ruta del archivo **relativa** al root del proyecto (sin `./`). Requerido. |
| `symbol` | string \| null | Nombre del símbolo match (función, clase, variable). Opcional, `null` si no aplica (p. ej. match filename). |
| `language` | string \| null | Lenguaje del archivo (p. ej. `typescript`, `bash`, `markdown`). Opcional. |
| `line_start` | number | Línea inicial del match (1-based). Requerido. |
| `line_end` | number | Línea final del match (inclusive, `>= line_start`). Requerido. |
| `match_type` | enum | Tipo de match: `exact` \| `filename` \| `structural` \| `semantic` \| `reference` \| `test` \| `config`. Default si falta: `semantic`. |
| `score` | number | Confianza del match en `[0,1]`. Default si falta: `0.5`. |
| `token_estimate` | number | Estimación de tokens que consume el fragmento. Default si falta: `(line_end - line_start + 1) * 5`. |
| `reason` | string | Una línea explicando por qué el match es relevante para la tarea. Opcional. |

### Valores de `match_type`

| Valor | Significado |
|-------|-------------|
| `exact` | Coincidencia literal de consulta en el contenido. |
| `filename` | Match por nombre de archivo. |
| `structural` | Coincidencia estructural (AST): firma, declaración, bloque. |
| `semantic` | Similitud semántica/embeddings. |
| `reference` | Referencia/uso de un símbolo desde otro lugar. |
| `test` | Match en archivos de test o spec. |
| `config` | Match en archivos de configuración. |

## Ejemplo JSON completo

```json
{
  "source": "rg",
  "path": "openspec/changes/agent-context-engineering-retrieval/specs/context-engineering/spec.md",
  "symbol": null,
  "language": "markdown",
  "line_start": 1,
  "line_end": 5,
  "match_type": "structural",
  "score": 0.8,
  "token_estimate": 120,
  "reason": "requisitos de retrieval definidos en la spec"
}
```

## Notas

- `line_start`/`line_end`/`score`/`token_estimate` son los campos mínimos
  validados por `assemble-context` (etapa normalize). Sin `path` o rangos de
  línea no numéricos la línea se descarta.
- `assemble-context` enriquece cada línea con `sources` (array de herramientas
  tras fusionar duplicados), `score_final` (ranking multi-factor) y `tier`
  (agrupación por confianza).
