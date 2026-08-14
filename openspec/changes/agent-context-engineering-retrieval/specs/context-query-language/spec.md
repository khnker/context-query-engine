## ADDED Requirements

### Requirement: Context Query Language Syntax

The system SHALL provide a declarative context query language (CQL) for expressing retrieval intent without physical tools.

#### Scenario: FIND clause

- **WHEN** an agent queries for an implementation or concept
- **THEN** the query SHALL use a FIND clause specifying the target kind (implementation, definition, concept) and the search concept

#### Scenario: FOLLOW clause

- **WHEN** an agent queries for related symbols
- **THEN** the query SHALL use a FOLLOW clause listing relations (references, callers, callees, importers)

#### Scenario: INCLUDE clause

- **WHEN** an agent needs supporting material
- **THEN** the query SHALL use an INCLUDE clause (tests, config, documentation)

#### Scenario: LIMIT clause

- **WHEN** an agent constrains the result
- **THEN** the query SHALL use a LIMIT clause with max tokens, max files, and max latency

#### Scenario: Budget constraint

- **WHEN** a query is emitted
- **THEN** the BUDGET constraint SHALL map to the configured token budgets (2000/8000/20000/30000)

### Requirement: Logical Query Representation

The system SHALL represent a parsed CQL query as a logical query plan independent of execution tools.

#### Scenario: Plan fields

- **WHEN** a CQL query is parsed
- **THEN** the logical plan SHALL contain query type, target, concept, relations, inclusions, and constraints

#### Scenario: Tool independence

- **WHEN** a logical plan is produced
- **THEN** it SHALL NOT reference specific physical tools, so the optimizer can choose execution strategies

### Requirement: Query Semantics

The system SHALL define unambiguous semantics for each CQL clause.

#### Scenario: Ambiguous concept

- **WHEN** a concept appears in multiple implementations
- **THEN** the system SHALL return candidates ranked by relevance and SHALL NOT pick a single arbitrary implementation

#### Scenario: Empty results

- **WHEN** a query yields no results
- **THEN** the system SHALL report the failed query type and SHALL NOT silently return an empty context
