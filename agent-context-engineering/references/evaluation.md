# Evaluation

Evaluación del skill de retrieval vs herramientas directas (baseline). Requisito spec `context-engineering` (Benchmarking, Retrieval Metrics).

## Métricas

Definiciones completas en `retrieval-metrics.md`. Resumen:

- **Query cost**: tokens consumidos por consulta
- **Hit rate**: consultas con resultado relevante / total
- **Precision**: resultados relevantes / total resultados
- **Latency**: ms por consulta
- **Tool calls**: llamadas por consulta
- **Information density**: tokens útiles / tokens totales

## Benchmark

Misma tarea de retrieval ejecutada con:

1. **Skill** (context-engineering): árbol de decisión + budgets + dedup
2. **Baseline directo**: `find`, `grep`, `cat`, `git grep` sin política

### Procedimiento

1. Seleccionar 10 tareas reales sobre un repo ≥50k LOC (ver tasks grupo 9):
   - 2 identifier, 2 filename, 2 pattern, 2 symbol, 1 concepto, 1 repo map
2. Ejecutar ambas vías, registrar métricas por consulta.
3. Acumular en tabla comparativa.

### Tabla comparativa (template)

| # | Tarea | Query type | Skill tokens | Baseline tokens | Skill ms | Baseline ms | Skill hits | Baseline hits |
|---|-------|------------|--------------|-----------------|----------|-------------|------------|---------------|
| 1 | def `parseConfig` | identifier | | | | | | |

### Información density

- Density alta = pocos tokens con toda la info necesaria.
- Meta: density(skill) > density(baseline) en ≥80% de tareas.
- Si baseline con `git grep -n` supera a skill, la policy inicial está mal → revisar árbol de decisión.

## Criterios de éxito (requirement Benchmarking)

- Skill resuelve ≥9/10 tareas con presupuesto M (8000)
- Tokens promedio ≤ 50% del baseline
- Latency promedio ≤ 2x baseline (el skill puede ser más lento por selección, no por 10x)

## Herramienta

Evals automatizados en `evals/` (tasks grupo 9): script que corre ambas vías y emite JSON de métricas comparables.
