# ContextForge

**Retrieval and context management engine for LLM agents.** Turns context search into an optimizable query: it interprets what the agent needs, plans how to obtain it, and returns only useful context within a token budget.

## Table of contents

- [What is it?](#what-is-it)
- [Current state](#current-state)
- [Architecture](#architecture)
- [Components](#components)
- [How it works](#how-it-works)
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

ContextForge fixes this by applying the database query optimizer analogy to code retrieval:

| Database | ContextForge |
|---|---|
| SQL | Context Query (CQL) |
| Query parser | `interpreter.js` + `cql.js` |
| Logical plan | Plan with target, relations, inclusions, budget |
| Query optimizer | `optimizer.js` (cost model + candidate plans) |
| Table scan / index | rg / fd / ast-grep / Probe |
| Result set | Fused context bounded by budget |
| Statistics | Execution telemetry (`telemetry.ndjson`) |

The agent says **what** it needs, not **how** to find it. ContextForge decides which tool to use, with what scope, how much context to return, and when to stop.

---

## Current state

> Honesty first: today ContextForge is a **tool router with a linear cost model**, on its way to becoming a full query optimizer. Implemented and pending:

**Implemented**

- CQL (declarative query language) + parser
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
               │   cql.js / interpreter │  parse + classify intent
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

1. **Interpretation** — the agent issues a CQL query (`FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000`) or natural language (`--intent 'where is parseConfig defined?'`). `cql.js` turns it into a logical plan; `interpreter.js` classifies the intent into `query_type` + `confidence`.
2. **Optimization** — `optimizer.js` generates candidate physical plans per query type and selects the lowest estimated cost. Accumulated telemetry enables *learned mappings*: if `search-structure` has a better track record than `search-code` for `definitions`, the plan is reordered.
3. **Execution** — plan ops run in order with **early termination**: if the first op satisfies the query, the rest are skipped. Each op emits NDJSON lines of the normalized schema.
4. **Fusion** — `assemble-context` runs the pipeline over results: excludes low-value paths, dedups by `path:line_start:line_end` (collapses cross-tool matches), ranks multi-factor, trims to budget, orders by confidence tiers (T1 constraints → T4 low confidence).

---

## Components

| Module | Description |
|---|---|
| `agent-context-engineering/` | **Agent skill** — `SKILL.md` + 10 policy references (retrieval-policy, tool-selection, context-budget with levels 2000/8000/20000/30000, dedup, semantics, filesystem, evaluation, metrics, result schema, toolchain). Teaches the agent the rules; contains no engine logic. |
| `engine/` | **Node engine (ESM, stdlib-only, zero deps)** — CQL parser, interpreter, optimizer, pipeline, cache and MCP server. |
| `scripts/` | **CLIs** — 9 wrappers around the retrieval tools. |
| `evals/` | **Benchmark** — 10 tasks, skill-vs-baseline runner and 4-target analyzer. |
| `openspec/` | **Spec-driven specification** of the project (governance). |

---

## How it works

Real example — CQL query:

```bash
node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'
```

```text
1. cql.js        → { query_type: "implementation",
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
git clone https://github.com/khnker/contextforge.git
cd contextforge

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
# CQL query
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
3. **`FOLLOW` / `INCLUDE` operators** — execute the `relations` and `inclusions` that CQL already parses (references, tests).
4. **Plan rewriting** — commute/reorder ops when the estimate justifies it.
5. **Separate Cost / Quality** — `utility = Quality(plan) / Cost(plan)`, with relevance/coverage/confidence outside the cost formula.

Not on the roadmap: an ML intent classifier (the heuristic interpreter + statistics are enough) and a giant MCP (the surface stays small).

---

## Repository structure

```text
contextforge/
├── agent-context-engineering/     # agent skill
│   ├── SKILL.md                   # activation, decision tree, escalation, budgets, anti-patterns
│   ├── references/                # 10 retrieval policy docs
│   ├── config/exclusions.json     # default exclusions (node_modules, dist, ...)
│   └── scripts/check-tools
├── engine/                        # engine (Node, stdlib-only)
│   ├── cql.js                     # CQL parser → logical plan
│   ├── interpreter.js             # intent classifier (heuristic)
│   ├── optimizer.js               # candidate plans + cost model + telemetry + learned mappings
│   ├── engine.js                  # pipeline: parse → optimize → execute → fuse (+ cache)
│   ├── mcp-server.js              # MCP stdio: context_query / search_files / read_file
│   └── README.md
├── scripts/                       # 9 CLIs (project-map, search-code, search-structure, ...)
├── evals/                         # benchmark + target analyzer
└── openspec/                      # spec-driven specification
```

---

## License

[MIT](LICENSE)
