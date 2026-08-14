## ADDED Requirements
### Requirement: Statistics Store
The system SHALL aggregate execution telemetry into a queryable statistics store keyed by `(operator, predicate_class)`.
- The store SHALL expose `avg_candidates`, `p95_tokens`, `avg_latency_ms` and `success_rate` per key.
- The store SHALL persist in `engine/telemetry.ndjson` (append-only) and SHALL be re-aggregated at each optimization.
- The store SHALL replace the optimizer's ad-hoc learned mapping.
- The store SHALL require minimum evidence (≥3 records) before influencing plan selection.
#### Scenario: stats aggregated per key
- **WHEN** ≥3 queries execute with the same operator and predicate class
- **THEN** the statistics store exposes `avg_candidates`, `p95_tokens`, `avg_latency_ms` and `success_rate` aggregated for that key
#### Scenario: store replaces learned mapping
- **WHEN** a key has ≥3 records of evidence
- **THEN** plan selection uses store statistics ranked by `success_rate` with token average as tiebreaker, without separate ad-hoc logic
### Requirement: Cardinality Estimation
The system SHALL estimate the cardinality (expected candidate count) of each operator before execution and SHALL refine it with actual values after execution.
- Estimates SHALL be based on the predicate class (`identifier`, `filename`, `pattern`, `concept`, `symbol`, `repo_map`).
- Estimates SHALL feed plan selection (estimated operator cost = f(estimate)).
- The system SHALL record actual `results.length` post-execution and SHALL refine the statistics of that predicate class (autoanalyze analogy).
- When no statistics exist, the estimator SHALL use a per-class default.
#### Scenario: selection uses estimates
- **WHEN** two candidate plans differ only in the expected candidate count of the first operator
- **THEN** the plan with the lower estimated cost (based on estimated cardinality) is selected
#### Scenario: post-execution refinement
- **WHEN** an operator executes and its `results.length` differs from the estimate
- **THEN** the predicate-class statistics update with the real value and the next estimate uses the new average
### Requirement: Operator Pipeline
The system SHALL execute the operators of the logical plan, including `relations` (FOLLOW) and `inclusions` (INCLUDE) currently parsed but dropped.
- The system SHALL execute the pipeline `SEARCH → FILTER → FOLLOW → JOIN → RANK → LIMIT` over the plan operators.
- `SEARCH` SHALL produce candidates via the plan's tool; `FILTER`/`RANK`/`LIMIT` SHALL reuse the `assemble-context` fusion (dedup/rank/budget/tiers).
- `FOLLOW` SHALL resolve `relations` (e.g. `references`, `definitions`, `usages`) over the resulting candidates.
- `INCLUDE` SHALL merge `inclusions` (e.g. `tests`, `config`) into the final result.
- The system SHALL satisfy CQL queries of the form `FIND implementation OF concept X AND FOLLOW references AND INCLUDE tests LIMIT 8000`.
#### Scenario: FOLLOW executes references
- **WHEN** a CQL query includes `AND FOLLOW references`
- **THEN** after `SEARCH` the system executes the `FOLLOW references` operator over the candidates and the results are merged into the context
#### Scenario: INCLUDE merges tests
- **WHEN** a CQL query includes `AND INCLUDE tests`
- **THEN** the final result includes the related test files marked in `tier` T4
#### Scenario: no relations or inclusions
- **WHEN** a CQL query declares neither `FOLLOW` nor `INCLUDE`
- **THEN** the pipeline executes `SEARCH → FILTER → RANK → LIMIT` and the result is identical to previous behavior
### Requirement: Plan Rewriting
The system SHALL rewrite and reorder candidate plans before selection.
- The system SHALL generate ≥2 candidate plans from the logical plan (operator order combinations).
- The reordering rule SHALL prioritize cheap, high-selectivity operators (lowest estimated cardinality) first.
- The rule SHALL preserve data dependencies between operators (a `FOLLOW` SHALL NOT precede its `SEARCH`).
- The system SHALL select the lowest-cost plan after rewriting.
#### Scenario: cheap-first reordering
- **WHEN** the initial plan orders expensive `search-semantic` before cheap `search-code`
- **THEN** the rewriter produces a candidate plan with `search-code` first if data dependencies allow it
#### Scenario: dependency respected
- **WHEN** a `FOLLOW` operator depends on the result of a previous `SEARCH`
- **THEN** no rewrite places `FOLLOW` before its `SEARCH`
### Requirement: Cost/Quality Separation
The system SHALL separate the cost model from the quality model and select by utility.
- The `CostModel` SHALL score `tokens`, `latency_ms` and `tool_calls` (lower is better).
- The `QualityModel` SHALL score `relevance`, `coverage` and `confidence` (higher is better).
- Selection SHALL maximize `utility = quality / cost`.
- Weights SHALL remain configurable via environment, now split into `CF_COST_*` and `CF_QUALITY_*`.
- Final result ranking (tiers T1-T4) SHALL remain in `assemble-context`.
#### Scenario: utility over raw cost
- **WHEN** plan A has lower raw cost than plan B but B has significantly higher relevance/coverage
- **THEN** selection uses `utility = quality / cost` and MAY pick B if its utility is higher
#### Scenario: weights via environment
- **WHEN** `CF_COST_WEIGHTS` and `CF_QUALITY_WEIGHTS` are defined in the environment
- **THEN** the CostModel and QualityModel use those weights, with documented defaults otherwise
