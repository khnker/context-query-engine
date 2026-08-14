## ADDED Requirements

### Requirement: Retrieval Strategy Selection

The system SHALL select a retrieval strategy based on the type of information needed, choosing deterministic and cheap mechanisms before expensive semantic ones.

#### Scenario: Exact identifier lookup

- **WHEN** the requested information is an exact identifier or text pattern
- **THEN** the system SHALL use `rg` and SHALL NOT invoke semantic retrieval

#### Scenario: Filename or path lookup

- **WHEN** the requested information is a filename or path characteristic
- **THEN** the system SHALL use `fd`

#### Scenario: Syntactic pattern

- **WHEN** the requested information is a syntactic code pattern
- **THEN** the system SHALL use `ast-grep`

#### Scenario: Security policy pattern

- **WHEN** the requested information concerns security or policy patterns
- **THEN** the system SHALL use `semgrep`

#### Scenario: Symbol relationships

- **WHEN** the requested information concerns relationships between symbols
- **THEN** the system SHALL use semantic code intelligence (Probe or LSP)

#### Scenario: Structured data

- **WHEN** the requested information is JSON
- **THEN** the system SHALL use `jq`

#### Scenario: YAML data

- **WHEN** the requested information is YAML
- **THEN** the system SHALL use `yq`

### Requirement: Symbol-Level Retrieval

The system SHALL use semantic code intelligence when the requested information concerns relationships between symbols.

#### Scenario: Definition and references

- **WHEN** the agent needs a symbol's definition, callers, or callees
- **THEN** the system SHALL retrieve the complete symbol context including definition, callers, and callees

#### Scenario: Cross-file relationships

- **WHEN** the requested information spans multiple files
- **THEN** the system SHALL resolve cross-file symbol relationships

### Requirement: Context Budgeting

The system SHALL enforce configurable context budgets for retrieval operations.

#### Scenario: Multiple candidates

- **WHEN** retrieval produces more candidates than the context budget allows
- **THEN** the highest-value candidates SHALL be retained

#### Scenario: Additional retrieval

- **WHEN** the agent needs more evidence than the current budget provides
- **THEN** the agent SHALL prefer additional retrieval with a larger budget over dumping the entire repository into context

#### Scenario: Early termination

- **WHEN** sufficient evidence has been collected
- **THEN** retrieval SHALL terminate early and deeper levels SHALL NOT be invoked

#### Scenario: Budget adjustment

- **WHEN** task requirements change
- **THEN** the system SHALL support both budget increase and budget decrease

### Requirement: Project Reconnaissance

The system SHALL provide a low-cost mechanism for determining repository shape before deep retrieval.

#### Scenario: Initial exploration

- **WHEN** the agent starts a task on an unfamiliar repository
- **THEN** the system SHALL generate a project map with low token cost before invoking deeper retrieval levels

### Requirement: Generated and Low-Signal Content Exclusion

The system SHALL exclude known low-value paths from default retrieval.

#### Scenario: Default exclusions

- **WHEN** a retrieval operation runs
- **THEN** the system SHALL exclude `.git/`, `node_modules/`, `vendor/`, `dist/`, `build/`, `coverage/`, `.cache/`, `.tmp/`, `target/`, `generated/`, minified assets, lockfiles, and binary files by default

#### Scenario: Per-project configuration

- **WHEN** a project defines custom exclusions
- **THEN** the system SHALL apply the project's exclusion list over the defaults

### Requirement: Normalized Retrieval Results

The system SHALL normalize retrieval results into a common representation before ranking and deduplication.

#### Scenario: Context assembly

- **WHEN** multiple retrieval mechanisms are used
- **THEN** results SHALL be normalized into a common representation before ranking and deduplication

#### Scenario: Result fields

- **WHEN** a retrieval result is returned
- **THEN** it SHALL expose source, path, symbol, language, line_start, line_end, match_type, score, token_estimate, and reason

### Requirement: Escalation Policy

The system SHALL escalate retrieval depth only when lower levels yield insufficient evidence.

#### Scenario: Retrieval levels

- **WHEN** retrieval runs
- **THEN** the system SHALL follow the default policy: Level 0 project map, Level 1 fd, Level 2 rg, Level 3 ast-grep, Level 4 Probe, Level 5 LSP, Level 6 tests / git history / runtime evidence

#### Scenario: Successful early retrieval

- **WHEN** sufficient evidence is obtained at an earlier level
- **THEN** deeper levels SHALL NOT be invoked

### Requirement: Retrieval Metrics

The system SHALL record retrieval metrics for every task and expose them for evaluation.

#### Scenario: Completed task

- **WHEN** an agent completes a task
- **THEN** retrieval metrics SHALL be available for evaluation, including task_id, retrieval_strategy, tool, tool_calls, input_size, output_tokens, deduplicated_tokens, final_context_tokens, estimated_cost, latency, retrieval_depth, files_touched, and success

#### Scenario: Information density

- **WHEN** retrieval effectiveness is assessed
- **THEN** the primary metric SHALL be `Information Density = useful_context_tokens / total_context_tokens`

#### Scenario: Secondary metrics

- **WHEN** retrieval effectiveness is assessed
- **THEN** the system SHALL also report tokens_per_successful_task, retrieval_calls_per_task, retrieval_latency, context_reuse_rate, duplicate_token_rate, irrelevant_token_rate, and task_success_rate

### Requirement: Benchmarking

The system SHALL provide a benchmark that compares retrieval strategies on task success and retrieval cost.

#### Scenario: Evaluation

- **WHEN** a retrieval strategy is evaluated
- **THEN** the system SHALL measure retrieval precision, retrieval recall, context token count, tool-call count, latency, and downstream task success

#### Scenario: Baseline comparison

- **WHEN** the optimized strategy is evaluated
- **THEN** it SHALL be compared against the baseline (`find`, `grep`, `cat`, `git grep`) and against `fd`, `rg`, `ast-grep`, Probe, and LSP

#### Scenario: Benchmark result

- **WHEN** optimized retrieval is evaluated
- **THEN** results SHALL show whether context reduction produces an actual improvement in downstream task performance

#### Scenario: Benchmark corpus

- **WHEN** a benchmark task is defined
- **THEN** it SHALL contain a task description, repository state, expected relevant files and symbols, expected behavior, retrieval budget, and success criteria

### Requirement: Anti-Pattern Prevention

The system SHALL explicitly discourage unbounded and redundant retrieval behaviors.

#### Scenario: Unbounded retrieval

- **WHEN** an agent needs repository content
- **THEN** the system SHALL discourage `cat .` and equivalent unbounded retrieval

#### Scenario: Low-value reads

- **WHEN** an agent plans file reads
- **THEN** the system SHALL discourage reading package-lock files unnecessarily, node_modules, generated code, entire log files, and entire large configuration files

#### Scenario: Redundant operations

- **WHEN** an agent performs retrieval
- **THEN** the system SHALL discourage repeating previous tool outputs, repeating identical searches, using semantic search when exact search is sufficient, and using expensive retrieval when deterministic retrieval is sufficient

### Requirement: Token Budget Configuration

The system SHALL provide configurable default token budgets for retrieval operations.

#### Scenario: Default budgets

- **WHEN** the skill runs without custom configuration
- **THEN** the default budgets SHALL be initial_budget 2000, standard_budget 8000, deep_budget 20000, and hard_limit 30000

#### Scenario: Budget override

- **WHEN** a project configures budgets
- **THEN** the configured values SHALL override the defaults

### Requirement: Tool Availability Verification

The system SHALL verify required tool availability and operate with missing optional tools.

#### Scenario: Missing optional tools

- **WHEN** an optional tool is not installed
- **THEN** the basic skill SHALL continue to operate using available tools

#### Scenario: Availability check

- **WHEN** the skill initializes
- **THEN** it SHALL verify `rg`, `fd`, `jq`, `yq`, `sg`, `tokei`, and `probe` availability

### Requirement: Context Query API

The system SHALL expose a single context query interface that accepts an intent and constraints without requiring the agent to choose retrieval tools.

#### Scenario: Context query submission

- **WHEN** an agent needs contextual information
- **THEN** the agent SHALL be able to submit a context query with an intent and constraints (max tokens, max files, max latency) and receive a context result

#### Scenario: Tool decision encapsulation

- **WHEN** a context query is submitted
- **THEN** the system SHALL decide which tools to use and SHALL NOT require the agent to specify physical retrieval tools

### Requirement: Query Interpretation

The system SHALL interpret the agent's request into a typed logical query with confidence.

#### Scenario: Intent classification

- **WHEN** a context query is submitted
- **THEN** the system SHALL classify the query type (symbol relationship, structural pattern, semantic concept, dependency, exact text) with a confidence value

#### Scenario: Heuristic fallback

- **WHEN** a classifier is not available
- **THEN** the system SHALL interpret the query using deterministic heuristics and SHALL NOT fail

### Requirement: Logical Context Plan

The system SHALL represent each context query as a logical plan independent of physical retrieval tools.

#### Scenario: Logical plan structure

- **WHEN** a query is interpreted
- **THEN** the system SHALL produce a logical plan specifying the retrieval target, relations (references, callers, callees), inclusions (tests), and constraints (max tokens, max files, max latency)

### Requirement: Cost-Based Optimization

The system SHALL generate multiple candidate physical plans and select the one with the lowest estimated cost.

#### Scenario: Candidate plans

- **WHEN** a logical plan is ready
- **THEN** the system SHALL generate at least two candidate physical plans when alternatives exist

#### Scenario: Plan selection

- **WHEN** candidate plans are generated
- **THEN** the system SHALL select the plan with the lowest estimated cost, where cost accounts for tokens, latency, tool calls, and estimated relevance

#### Scenario: Cost model

- **WHEN** a plan's cost is estimated
- **THEN** the system SHALL estimate cost as a weighted combination of tokens, latency, tool calls, and relevance, with weights adjustable from execution statistics

### Requirement: Execution Statistics

The system SHALL record per-tool and per-query-type execution statistics and use them to improve plan selection.

#### Scenario: Statistics recording

- **WHEN** a plan executes
- **THEN** the system SHALL record tool selectivity, retrieval precision, tokens per result, latency, success rate, and cache hit rate

#### Scenario: Learned mappings

- **WHEN** sufficient execution evidence accumulates for a query type
- **THEN** the optimizer SHALL prefer the tools with the best historical success-cost tradeoff for that query type

#### Scenario: Statistics override

- **WHEN** execution statistics exist for a query type
- **THEN** statistics-based estimates SHALL take precedence over the static default policy

### Requirement: Physical Execution Plan

The system SHALL execute a sequence of physical retrieval operations derived from the selected plan.

#### Scenario: Tool sequence

- **WHEN** a plan is selected
- **THEN** the system SHALL execute the ordered tool operations (rg, fd, ast-grep, LSP, Probe, git) and SHALL support early termination when sufficient evidence is collected

### Requirement: Result Fusion

The system SHALL fuse results from multiple tools before presenting context to the agent.

#### Scenario: Fusion pipeline

- **WHEN** multiple tools return results
- **THEN** the system SHALL deduplicate, rank, and enforce the token budget across the combined result set

#### Scenario: Budget enforcement

- **WHEN** the fused result set exceeds the budget
- **THEN** the highest-value results SHALL be retained and the remainder SHALL be discarded
