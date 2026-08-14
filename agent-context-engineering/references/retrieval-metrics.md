# Retrieval Metrics

Definiciones con fórmula. 
## Métricas

| Métrica | Fórmula | Objetivo |
|---------|---------|----------|
| Query cost | tokens consumidos por consulta | minimizar |
| Hit rate | consultas con resultado relevante / total consultas | maximizar |
| Precision | resultados relevantes / total resultados | maximizar |
| Latency | ms desde emisión hasta resultado | minimizar |
| Tool calls | llamadas a herramientas por consulta | minimizar |
| Information density | tokens útiles / tokens totales | maximizar |

## Definiciones detalladas

### Query cost
- Tokens de TODOS los resultados insertados en contexto (snippets + file:line).
- Meta por nivel: S≤2000, M≤8000, L≤20000, XL≤30000.

### Hit rate
- Consulta con hit = al menos 1 resultado relevante usado en la respuesta final.
- 5 resultados, 2 relevantes → precision 0.4.
- Se compara contra baseline (find/grep/cat/git grep).
- Density 0.3 = 30% del contexto consumido fue útil.

## Registro

Formato por consulta (JSON):

```json
{
  "query_type": "identifier",
  "tool": "rg",
  "tokens": 450,
  "relevant": 2,
  "results": 3,
  "latency_ms": 12,
  "tool_calls": 1,
  "satisfied": true
}
```

Acumulado en evals/ para el benchmark (grupo 9).
