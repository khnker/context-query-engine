## ADDED Requirements

### Requirement: Statistics Store

El sistema DEBE agregar la telemetría de ejecución en un statistics store consultable por `(operator, predicate_class)`.

- El sistema SHALL agregar las métricas de ejecución por par `(operator, predicate_class)`.
- El store SHALL exponer `avg_candidates`, `p95_tokens`, `avg_latency_ms` y `success_rate` por clave.
- El store SHALL persistir en `engine/telemetry.ndjson` (mismo archivo append-only) y SHALL releerse agregado en cada optimización.
- El store SHALL reemplazar el `learnedMapping` ad-hoc del optimizer.
- El store SHALL requerir evidencia mínima (≥3 registros) antes de influir en selección de plan.

#### Scenario: stats agregadas por clave

- **WHEN** se ejecutan ≥3 queries con el mismo operador y clase de predicado
- **THEN** el statistics store expone `avg_candidates`, `p95_tokens`, `avg_latency_ms` y `success_rate` agregados para esa clave

#### Scenario: store reemplaza learnedMapping

- **WHEN** una clave tiene evidencia ≥3 registros
- **THEN** la selección de plan usa las stats del store y el ranking por `success_rate` con desempate por tokens, sin lógica ad-hoc separada

### Requirement: Cardinality Estimation

El sistema DEBE estimar la cardinalidad (nº de candidatos) de cada operador ANTES de la ejecución y refinarla con los valores reales después.

- El sistema SHALL estimar `candidates` por operador pre-ejecución usando la clase de predicado (`identifier`, `filename`, `pattern`, `concept`, `symbol`, `repo_map`).
- Las estimaciones SHALL alimentar la selección de plan (costo estimado por operador = f(estimación)).
- El sistema SHALL registrar el cardinalidad real (`results.length`) post-ejecución y SHALL refinar las stats de la clase de predicado (analogía `autoanalyze`).
- Ante ausencia de stats, el estimador SHALL usar un default por clase de predicado.

#### Scenario: selección usa estimaciones

- **WHEN** dos planes candidatos difieren solo en el nº esperado de candidatos del primer operador
- **THEN** el plan con menor costo estimado (basado en la cardinalidad estimada) se selecciona

#### Scenario: refinamiento post-ejecución

- **WHEN** una op se ejecuta y su `results.length` difiere de la estimación
- **THEN** las stats de la clase de predicado se actualizan con el valor real y la próxima estimación usa el nuevo promedio

### Requirement: Operator Pipeline

El sistema DEBE ejecutar los operadores del logical plan, incluyendo `relations` (FOLLOW) e `inclusions` (INCLUDE) que hoy se parsean y descartan.

- El sistema SHALL ejecutar el pipeline `SEARCH → FILTER → FOLLOW → JOIN → RANK → LIMIT` sobre los operadores del plan.
- `SEARCH` SHALL producir candidatos vía el tool del plan; `FILTER`/`RANK`/`LIMIT` SHALL reusar el fusionador `assemble-context` (dedup/rank/budget/tiers).
- `FOLLOW` SHALL resolver `relations` (ej. `references`, `definitions`, `usages`) sobre los candidatos resultantes.
- `INCLUDE` SHALL incorporar `inclusions` (ej. `tests`, `config`) al resultado final.
- El sistema SHALL satisfacer queries CQL del tipo `FIND implementation OF concept X AND FOLLOW references AND INCLUDE tests LIMIT 8000`.

#### Scenario: FOLLOW ejecuta references

- **WHEN** un query CQL incluye `AND FOLLOW references`
- **THEN** tras `SEARCH`, el sistema ejecuta el operador `FOLLOW references` sobre los candidatos y los resultados se fusionan al contexto

#### Scenario: INCLUDE incorpora tests

- **WHEN** un query CQL incluye `AND INCLUDE tests`
- **THEN** el resultado final incluye los archivos de tests relacionados, marcados en `tier` T4

#### Scenario: sin relations ni inclusions

- **WHEN** un query CQL no declara `FOLLOW` ni `INCLUDE`
- **THEN** el pipeline ejecuta `SEARCH → FILTER → RANK → LIMIT` y el resultado es idéntico al comportamiento anterior

### Requirement: Plan Rewriting

El sistema DEBE reescribir y reordenar planes candidatos antes de la selección.

- El sistema SHALL generar ≥2 planes candidatos a partir del logical plan (combinaciones de orden de operadores).
- La regla de reordenamiento SHALL priorizar operadores baratos y de alta selectividad (menor cardinalidad estimada) primero.
- La regla SHALL preservar dependencias de datos entre operadores (un `FOLLOW` no precede a su `SEARCH`).
- El sistema SHALL seleccionar el plan de menor costo estimado tras la reescritura.

#### Scenario: reordenamiento barato-primero

- **WHEN** el plan inicial ordena `search-semantic` (costoso) antes que `search-code` (barato)
- **THEN** el rewriter produce un plan candidato con `search-code` primero si la dependencia de datos lo permite

#### Scenario: dependencia respetada

- **WHEN** un operador `FOLLOW` depende del resultado de un `SEARCH` anterior
- **THEN** ninguna reescritura coloca `FOLLOW` antes que su `SEARCH`

### Requirement: Cost/Quality Separation

El sistema DEBE separar el modelo de costo del modelo de calidad y seleccionar por utilidad.

- El `CostModel` SHALL puntuar `tokens`, `latency_ms` y `tool_calls` (menor es mejor).
- El `QualityModel` SHALL puntuar `relevance`, `coverage` y `confidence` (mayor es mejor).
- La selección SHALL maximizar `utility = quality / cost`.
- Los pesos SHALL seguir configurables por env (`CF_W1..W4`), ahora separados: `CF_COST_*` y `CF_QUALITY_*`.
- El ranking final de resultados (tiers T1-T4) SHALL permanecer en `assemble-context`.

#### Scenario: utilidad sobre costo crudo

- **WHEN** el plan A tiene menor costo bruto que el plan B pero B tiene relevancia/cobertura significativamente mayor
- **THEN** la selección usa `utility = quality / cost` y puede elegir B si su utilidad es mayor

#### Scenario: pesos por env

- **WHEN** se definen `CF_COST_WEIGHTS` y `CF_QUALITY_WEIGHTS` en el entorno
- **THEN** el CostModel y QualityModel usan esos pesos, con defaults documentados si no están definidos
