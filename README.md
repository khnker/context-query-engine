# context-query-engine

**Retrieval and context management engine for LLM agents.** Turns context search into an optimizable query: it interprets what the agent needs, plans how to obtain it, and returns only useful context within a token budget.

## Table of contents

- [What is it?](#what-is-it)
- [Current state](#current-state)
- [Architecture](#architecture)
- [Components](#components)
- [How it works](#how-it-works)
- [Pipeline: worked example](#pipeline-worked-example)
- [Glossary](#glossary)
- [Testing](#testing)
- [Expanded installation](#expanded-installation)
- [Installation](#installation)
- [Usage](#usage)
- [Benchmark: context savings](#benchmark-context-savings)
- [Roadmap](#roadmap)
- [Repository structure](#repository-structure)
- [License](#license)

> Read this in [Español](README.es.md)

---

## What is it?

An LLM agent working on a large codebase spends most of its context window on inefficient retrieval: global `grep`s, `cat` of whole files, duplicated results, redundant searches. The outcome is low **useful information per token**:

```text
Information Density = useful_context_tokens / total_context_tokens
```

context-query-engine fixes this by applying the database query optimizer analogy to code retrieval:

| Database | context-query-engine |
|---|---|
| SQL | Context Query (CQP) |
| Query parser | `interpreter.js` + `cqp.js` |
| Logical plan | Plan with target, relations, inclusions, budget |
| Query optimizer | `optimizer.js` (cost model + candidate plans) |
| Table scan / index | rg / fd / ast-grep / Probe |
| Result set | Fused context bounded by budget |
| Statistics | Execution telemetry (`telemetry.ndjson`) |

The agent says **what** it needs, not **how** to find it. context-query-engine decides which tool to use, with what scope, how much context to return, and when to stop.

---

## Current state

> Honesty first: today context-query-engine is a **tool router with a linear cost model**, on its way to becoming a full query optimizer. Implemented and pending:

**Implemented**

- CQP (declarative query language) + parser
- Heuristic intent interpreter (no ML)
- Candidate physical plans A/B/C per query type
- Statistics store per `(operator, predicate_class)`: avg candidates, p95 tokens, latency, success rate (≥3 records)
- Cardinality estimation per predicate class, refined with post-execution actuals
- Cost/Quality split: `utility = quality / cost` (CostModel `CF_COST_*`, QualityModel `CF_QUALITY_*`)
- Plan rewriting: cheap/high-selectivity operators first (dependency-safe)
- `FOLLOW` (references/definitions/usages) and `INCLUDE` (tests) operators executed
- Ordered execution with informed **early termination**
- Fusion: cross-tool dedup, multi-factor ranking, token budget, tiered ordering
- Intra-session cache (5 min TTL, persisted between processes)
- MCP server (stdio, zero dependencies)

---

## Architecture

```text
                    LLM AGENT
                        │
                        ▼
              context_query() ── MCP or CLI
                        │
                        ▼
               ┌──────────────────────┐
               │   cqp.js / interpreter │  parse + classify intent
               └──────────┬───────────┘
                          ▼
               ┌──────────────────────┐
               │   Logical Plan       │  target, relations, inclusions, limit, budget
               └──────────┬───────────┘
                          ▼
               ┌──────────────────────┐
               │   optimizer.js       │  plans A/B/C → cost model → selection
               └──────────┬───────────┘     + learned mappings (telemetry)
                          ▼
               ┌──────────────────────┐
               │   Physical Plan      │  ordered sequence of ops
               └──────────┬───────────┘
                          ▼
        ┌─────────┬────────┼─────────┬─────────┐
        ▼         ▼        ▼         ▼         ▼
   search-code search-structure search-semantic project-map extract-context
        └─────────┴────────┼─────────┴─────────┘
                           ▼
               ┌──────────────────────┐
               │   assemble-context   │  normalize → filter → dedup → rank → budget → order
               └──────────┬───────────┘
                          ▼
                    FINAL CONTEXT (under budget)
                          ▼
                        LLM
```

### Phases

1. **Interpretation** — the agent issues a CQP query (`FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000`) or natural language (`--intent 'where is parseConfig defined?'`). `cqp.js` turns it into a logical plan; `interpreter.js` classifies the intent into `query_type` + `confidence`.
2. **Optimization** — `optimizer.js` generates candidate physical plans per query type and selects the lowest estimated cost. Accumulated telemetry enables *learned mappings*: if `search-structure` has a better track record than `search-code` for `definitions`, the plan is reordered.
3. **Execution** — plan ops run in order with **early termination**: if the first op satisfies the query, the rest are skipped. Each op emits NDJSON lines of the normalized schema.
4. **Fusion** — `assemble-context` runs the pipeline over results: excludes low-value paths, dedups by `path:line_start:line_end` (collapses cross-tool matches), ranks multi-factor, trims to budget, orders by confidence tiers (T1 constraints → T4 low confidence).

---

## Components

| Module | Description |
|---|---|
| `agent-context-engineering/` | **Agent skill** — `SKILL.md` + 10 policy references (retrieval-policy, tool-selection, context-budget with levels 2000/8000/20000/30000, dedup, semantics, filesystem, evaluation, metrics, result schema, toolchain). Teaches the agent the rules; contains no engine logic. |
| `engine/` | **Node engine (ESM, stdlib-only, zero deps)** — CQP parser, interpreter, optimizer, pipeline, cache and MCP server. |
| `scripts/` | **CLIs** — 9 wrappers around the retrieval tools. |
| `evals/` | **Benchmark** — 10 tasks, skill-vs-baseline runner and 4-target analyzer. |
| `openspec/` | **Spec-driven specification** (governance, local-only, git-ignored). |

---

## How it works

Real example — CQP query:

```bash
node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'
```

```text
1. cqp.js        → { query_type: "implementation",
                     target: {kind:"concept", name:"provider fallback"},
                     relations: ["references"], inclusions: ["tests"],
                     limit: 8000, budget: 8000 }
2. optimizer.js  → 3 candidate plans (A: search-code; B: search-code + search-structure;
                     C: search-semantic + search-code) → picks lowest cost
3. engine.js     → executes ops in order, early termination if one satisfies,
                     fuses with assemble-context
4. Result        → context bounded to budget, deduplicated and ranked
```

Budgets: `BUDGET` maps to levels 2000 / 8000 / 20000 / 30000 (intermediate values round down: `5000 → 2000`).

---

## Pipeline: worked example

The query below is the one shown in [How it works](#how-it-works), traced through every stage with its real outputs:

```bash
node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'
```

1. **Query text (CQP)** — declarative: target `concept "provider fallback"`, relation `implementation`, `FOLLOW references`, `INCLUDE tests`, bounded by `LIMIT 8000` tokens.
2. **Interpreter + parser** (`cqp.js` + `interpreter.js`) — parse into the internal AST, then classify intent into `query_type: "implementation"` with a heuristic `confidence`. Output: `{ query_type: "implementation", target: { kind: "concept", name: "provider fallback" }, relations: ["references"], inclusions: ["tests"], limit: 8000, budget: 8000 }`.
3. **Logical plan** — tool-agnostic: what to retrieve (target, relations, inclusions), not how. The budget is snapped to the closest context level (`8000 → 8000`).
4. **Optimizer** (`optimizer.js`) — builds **candidate physical plans A/B/C** per query type: A = `search-code`; B = `search-code` + `search-structure`; C = `search-semantic` + `search-code`. Each is scored with the cost model (`cost = w1·tokens + w2·latency + w3·tool_calls`, `utility = quality / cost`); cardinality starts from `CARD_DEFAULTS` (e.g. `concept: 100`) and is refined with post-execution actuals.
5. **Physical plan** — the selected ordered sequence of operators:
   `search-code(definitions) → search-code(implementation) → search-structure(implementation) → follow(references) → include(tests)`
6. **Execution** — operators run in order; each emits one NDJSON line with **estimated vs actual** (`engine/statistics.ndjson`). Real row from this query:

```json
{"ts":"2026-08-14T20:37:35.784Z","operator":"search-code","queryClass":"definitions","estimated":{"candidates":15,"tokens":200,"latencyMs":15},"actual":{"candidates":15,"tokens":599,"latencyMs":26}}
```

| Operator / predicate class | Estimated (cand · tok · ms) | Actual (cand · tok · ms) |
|---|---|---|
| `search-code` / definitions | 15 · 200 · 15 | 15 · 599 · 26 |
| `search-code` / implementation | 15 · 200 · 15 | 15 · 551 · 25 |
| `search-structure` / implementation | 15 · 300 · 20 | 0 · 1 · 15 |
| `follow` / implementation | 15 · 300 · 25 | 0 · 1 · 19 |
| `include` / implementation | 15 · 200 · 20 | 4 · 1 · 27 |

   The `search-structure` and `follow` stages returned **0 candidates** — the actuals teach the optimizer that this predicate class is cheap and low-yield, improving future estimates (learned mappings).
7. **Fusion** (`assemble-context`) — normalizes results, filters low-value paths, dedups by `path:line_start:line_end` across tools, ranks multi-factor, trims to the 8000-token budget and orders by confidence tiers.
8. **Stats + context** — actuals append to `engine/statistics.ndjson`; with ≥3 records per `(operator, predicate_class)` the estimates improve. Final context is bounded by budget, deduplicated and ranked — ready for the LLM.

---

## Glossary

| Term | Meaning |
|---|---|
| **CQ** | Context Query — what the agent needs, as natural language or intent text (e.g. `--intent 'where is parseConfig defined?'`). |
| **CQP** | Context Query Plan — the declarative query language the engine executes (`FIND ... AND ... LIMIT ...`), parsed by `cqp.js`. |
| **AST** | Abstract Syntax Tree — the internal structured representation produced by the parser; boundary between query text and the planner. |
| **Logical plan** | Tool-agnostic description of what to retrieve: target, relations, inclusions, limit/budget. |
| **Physical retrieval plan** | The concrete ordered sequence of operators that will run (`search-code`, `search-structure`, `search-semantic`, `project-map`, `extract-context`). Candidates A/B/C per query type. |
| **Cost model** | `cost = w1·tokens + w2·latency + w3·tool_calls` with weights `CF_COST_1..3`; plan selection uses `utility = quality / cost`. |
| **Confidence** | How sure the heuristic interpreter is about the `query_type` classification of a query. |
| **Statistics** | Per `(operator, predicate_class)` aggregates — avg candidates, p95 tokens, latency, success rate — computed with ≥3 records, stored in `engine/statistics.ndjson`. |
| **Information density** | `useful_context_tokens / total_context_tokens` — the metric the engine optimizes. |
| **Wrong-context** | Retrieved context that does not match what the agent actually needs; the failure mode that fusion (dedup, ranking, budget) minimizes. |

---

## Testing

Run the full suite:

```bash
npm test
```

Coverage (aligned with the `test-suite` OpenSpec change):

- **Unit** — `node --test` over `engine/` (parser, optimizer, statistics).
- **Smoke** — bash scripts: `npm run check-tools` plus one end-to-end run of the worked query.
- **End-to-end** — `node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'`, asserting each pipeline stage emits the expected NDJSON.

Until the `test-suite` change lands, run the unit suite directly:

```bash
node --test engine/
```

---

## Expanded installation

### Prerequisites per distribution

Node.js **≥ 18** plus core tools (`rg`, `fd`, `jq`):

| Distribution | Command |
|---|---|
| Fedora | `sudo dnf install ripgrep fd-find jq` |
| Ubuntu / Debian | `sudo apt install ripgrep fd-find jq` |
| macOS | `brew install ripgrep fd jq` |

On Debian/Ubuntu the package is `fd-find` and the binary is `fdfind`; symlink it so `fd` resolves:

```bash
mkdir -p "$HOME/.local/bin" && ln -s "$(command -v fdfind)" "$HOME/.local/bin/fd"
```

### Optional tools

| Tool | Purpose | Install without sudo |
|---|---|---|
| `probe` | Semantic search (`scripts/search-semantic`) | static binary → `~/.local/bin` |
| `tokei` | LOC stats (repo_map cardinality) | static binary → `~/.local/bin` |
| `semgrep` | AST rules for advanced pattern searches | pip or static binary → `~/.local/bin` |

`sg` (semantic grep) is deprecated — use `ast-grep` instead.

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `CF_COST_1` | `0.01` | Cost weight w1 — tokens |
| `CF_COST_2` | `0.001` | Cost weight w2 — latency |
| `CF_COST_3` | `1` | Cost weight w3 — tool calls |
| `CF_QUALITY_1` | `10` | Quality weight q1 — relevance |
| `CF_QUALITY_2` | `5` | Quality weight q2 — coverage |
| `CF_QUALITY_3` | `1` | Quality weight q3 — confidence |
| `CF_STATS_FILE` | `engine/statistics.ndjson` | Path to the statistics store (default in-repo file) |

`utility = quality / cost` drives physical plan selection — tune the weights per workload.

### Exclusions configuration

`agent-context-engineering/config/exclusions.json`:

- `defaults` — paths excluded everywhere: `node_modules`, `.git`, `dist`, `build`, `coverage`, `vendor`, `target`, `__pycache__`, `.next`.
- `project_overrides` — per-project additions (empty by default).

### Verification

```bash
npm run check-tools
```

Checks core (`rg`, `fd`, `jq`) and optional (`yq`, `sg`, `tokei`, `probe`) tools. **Exit 0** if all core tools are present; **exit 1** if any core tool is missing. Missing optional tools are reported as `MISSING` but do not block basic operation.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Semantic search returns nothing | Probe index missing → run `probe index` |
| `sg` reported MISSING / deprecated | Use `ast-grep` instead |
| `fd: command not found` (Debian/Ubuntu) | Install `fd-find` and symlink `fdfind → fd` (see above) |
| Tools in `~/.local/bin` not found | Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile (`check-tools` does this itself) |
| Analyzer exits with code 2 (insufficient data) | Statistics need ≥3 records per `(operator, predicate_class)` — run the query at least 3 times |

---

## Installation

**Requirements** (Fedora):

```bash
sudo dnf install ripgrep fd-find jq yq fzf tokei
```

- `rg` (text search), `fd` (names), `ast-grep`/`sg` (structural), `jq` (JSON), `tokei` (LOC metrics, optional)
- **Probe** (optional, semantic retrieval): `npm install -g @probelabs/probe`
- **Node.js ≥ 18** (the engine uses no npm dependencies)

**Clone and install the skill** into your agent (OpenCode, Claude, etc.):

```bash
git clone https://github.com/khnker/context-query-engine.git
cd context-query-engine

# Install the retrieval skill (symlink into your agent's skills directory):
ln -s "$PWD/agent-context-engineering" ~/.config/opencode/skills/
```

**Verify the toolchain**:

```bash
scripts/check-tools   # exit 0 if rg/fd/jq present; optional tools don't block
```

Per-distro install details and sudo-free fallbacks in `agent-context-engineering/references/toolchain-install.md`.

---

## Usage

**Quick search (direct CLI):**

```bash
scripts/project-map                                          # repo shape (dirs, languages, LOC)
scripts/search-code -d src "provider"                        # scoped rg with default exclusions
scripts/search-code -i -l "retry"                            # files only, case-insensitive
scripts/search-structure -d src 'class $A'                   # AST pattern (ast-grep)
scripts/extract-context src/router.ts 40 60                  # semantic unit (line range)
```

**Full engine:**

```bash
# CQP query
node engine/engine.js 'FIND definitions OF symbol parseConfig'

# Natural language query
node engine/engine.js --intent 'where is parseConfig defined?'

# Same query twice → 2nd run hits the cache
node engine/engine.js 'FIND implementation OF concept "provider fallback"'  # cache_hits: 0
node engine/engine.js 'FIND implementation OF concept "provider fallback"'  # cache_hits: 1
```

**MCP (for agents):**

```bash
engine/mcp-test.sh    # initialize → tools/list → context_query
```

Deliberately minimal MCP surface:

- `context_query({intent, constraints})` — main abstraction
- `search_files` / `read_file` — low-level escape hatches

---

## Benchmark: context savings

Real measurement on `/home/nicolas/dev/polar` (2,129 files, 50k+ LOC), **skill vs naive baseline** (`grep` / `cat` / `find` — what an agent does without a policy):

| Task | Skill tokens | Baseline tokens | % savings | correct S/B |
|-------|-------------|-----------------|----------|-------------|
| identifier | 344 | 2,740 | 87.4% | ✅ / ✅ |
| filename | 305 | 2,792 | 89.1% | ✅ / ✅ |
| pattern | 256 | 2,691 | 90.5% | ✅ / ✅ |
| symbol | 305 | 2,792 | 89.1% | ✅ / ✅ |
| concept | 1,057 | 4,000 | 73.6% | ✅ / ✅ |
| repo_map | 199 | 4,698,530 | 99.996% | ✅ / ✅ |
| **Σ** | **2,466** | **4,711,545** | **99.95%** | **6/6** |

Takeaways:

- **~82–90%** savings on code queries; **~99.9%** on repo mapping (the flat `find` baseline returns the entire file tree).
- Excluding repo_map: **82.6%** overall token savings.
- Tool calls: **13 vs 12** (tie) → the gain is in **context**, not in command count.
- Correctness: **6/6** on both paths — savings don't degrade results.
- Engine behavior: `cache_hits: 1` on the second run, `early_terminated: true` when the first plan op satisfies.

The benchmark is reproducible: `evals/run-benchmark` + `evals/analyze` (10 tasks, 4 acceptance targets).

---

## Roadmap

To move from heuristic router to full query optimizer (in value order):

1. **Statistics store** — aggregate `telemetry.ndjson` per `(operator, predicate class)`: `avg_candidates`, `p95_tokens`, `latency_ms`, `success_rate`.
2. **Cardinality estimation** — estimate candidates **before** running each op and refine with the real post-execution count (PostgreSQL `autoanalyze` analogy). Today costs are per-tool constants.
3. **`FOLLOW` / `INCLUDE` operators** — execute the `relations` and `inclusions` that CQP already parses (references, tests).
4. **Plan rewriting** — commute/reorder ops when the estimate justifies it.
5. **Separate Cost / Quality** — `utility = Quality(plan) / Cost(plan)`, with relevance/coverage/confidence outside the cost formula.

Not on the roadmap: an ML intent classifier (the heuristic interpreter + statistics are enough) and a giant MCP (the surface stays small).

---

## Repository structure

```text
context-query-engine/
├── agent-context-engineering/     # agent skill
│   ├── SKILL.md                   # activation, decision tree, escalation, budgets, anti-patterns
│   ├── references/                # 10 retrieval policy docs
│   ├── config/exclusions.json     # default exclusions (node_modules, dist, ...)
│   └── scripts/check-tools
├── engine/                        # engine (Node, stdlib-only)
│   ├── cqp.js                     # CQP parser → logical plan
│   ├── interpreter.js             # intent classifier (heuristic)
│   ├── optimizer.js               # candidate plans + cost model + telemetry + learned mappings
│   ├── engine.js                  # pipeline: parse → optimize → execute → fuse (+ cache)
│   ├── mcp-server.js              # MCP stdio: context_query / search_files / read_file
│   └── README.md
├── scripts/                       # 9 CLIs (project-map, search-code, search-structure, ...)
├── evals/                         # benchmark + target analyzer
└── openspec/                      # spec-driven (local-only, git-ignored) (local, git-ignored)
```

---

## License

[MIT](LICENSE)

## Naming: CQ / CIR / CQP

context-query-engine's query language is called **CQP (Context Query Plan)** — deliberately not "CQL", which collides with third-party standards (ARROW/Europeana, MDPI "Context Definition and Query Language", USENIX).

```
Context Query (CQ)          → the agent's request text
Context Intermediate Rep.   → parsed representation (concept; folded into CQP today)
Context Query Plan (CQP)    → logical plan produced by parseCQP
Physical Retrieval Plan     → optimizer output (ordered ops)
```

`CIR` is documented as a concept but not implemented as a separate layer (YAGNI: the parser emits the logical plan directly).

## Testing

Suite automatizada (tasks test-suite):

```bash
npm test
```

Cubre:
- Unit (node:test, stdlib): parser CQP (test/cqp.test.js), interpreter (test/interpreter.test.js), optimizer (test/optimizer.test.js), statistics (test/statistics.test.js).
- Smoke bash (test/smoke.sh): sintaxis de los 9 scripts, check-tools, pipeline search-code → assemble-context, retrieval-metrics record/report.
- E2E (engine/test-e2e.sh): runCQP real sobre el repo; verifica plan.selected, results, cache_hits en 2ª corrida, early_terminated/tokens_used.

Exit no-cero ante cualquier fallo (CI-ready).
