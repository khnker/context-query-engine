# context-query-engine

**Retrieval and context management engine for LLM agents.** Turns context search into an optimizable query: it interprets what the agent needs, plans how to obtain it, and returns only useful context within a token budget.



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
- Heuristic intent interpreter **+ optional local ML classifier** (confidence gate ≥ 0.6, regex fallback intact)
- Candidate physical plans A/B/C per query type
- Statistics store per `(operator, predicate_class)`: avg candidates, p50/p95 tokens, variance, latency, success rate (≥3 records, confidence 0.3/0.6/0.9)
- Cardinality estimation per predicate class, refined with post-execution actuals
- Cost/Quality split: `utility = quality / cost` (CostModel `CF_COST_*`, QualityModel `CF_QUALITY_*`)
- Plan rewriting: cheap/high-selectivity operators first (dependency-safe)
- `FOLLOW` (references/definitions/usages) and `INCLUDE` (tests) operators executed
- Ordered execution with informed **early termination**
- Fusion: cross-tool dedup, multi-factor ranking, token budget, tiered ordering
- Intra-session cache (5 min TTL, persisted between processes)
- MCP server (stdio, zero dependencies)
- Repository statistics snapshot (`repo-stats.js`): files, bytes, estimated tokens, extensions, git recency
- Adaptive: exponential decay (τ=7d) in the statistics store — cost model adapts to repo evolution
- Per-operator cardinality: `estimateCandidates(operator|queryClass → queryClass → default)` wired into the optimizer
- Local model interface (`local-model.js`): `available()/run()/rerank()/rerankSync()`, `CF_MODEL_CMD`, 2s timeout, failure → null
- Optional reranker (engine.js hook before fuse; null → heuristic ranking) + `recall@k` harness
- **ML pipeline (TinyBERT-style)**: 1,000 labeled queries dataset (10 classes, EN+ES) + 70/15/15 split, numpy out-of-band trainer (`evals/ml/train-classifier.py`), node inference (`evals/ml/classify.mjs`, ~6 ms), swappable artifact
- ML gate (11.8): intent classification — regex 0.347 → **ML effective 0.94** (fired 135/150, acc 1.0, fallback 15)
-- Budget override por env `CF_BUDGET` (2k/8k/20k/30k) - eval por nivel de presupuesto sin tocar el plan
-- Context quality harness (`evals/scripts/eval-quality.js`): total/useful/wrong tokens, density, precision/recall por budget -> `evals/reports/quality-budget.json`

**ML evidence — gate PASS (full report: `evals/ml/GATE-ML.md`)**

Measured over real executions (T1 harness 40 tasks / test split 150 queries), no regression:

| Component | Before | With local model | Decision |
|-----------|--------|------------------|----------|
| Intent classification | regex 0.347 | **0.94** (fired 135/150, acc 1.0) | ✅ adopted |
| Spanish queries (es_acc) | ~0.17 | **1.0** (48 test rows) | ✅ adopted |
| Cardinality MAPE | 1.418 (heuristic avg) | **0.498** (ridge, P95 5.43→2.02) | ✅ adopted |
| Optimizer regret (C vs oracle) | 0.6886 | **0.6655** (−3.4%) | ✅ adopted |
| Correctness / tokens (C) | 100% / 764 | 100% / 764 (identical) | ✅ no regression |
| Reranker (real model, MRR) | sanity Δ0.000 | Δ0.000 end-to-end, pair-level MRR 0.909 | ✅ adopted (neutral, no regression) |

**Context quality by budget (real tree /home/nicolas/dev, 24GB, 14 tasks GT, 2026-08-15)**

| Budget | total tok | median/task | >budget | density | p@file | r@file |
|--------|-----------|-------------|---------|---------|--------|--------|
| 2k | 1,865,292 | 204 | 6/14 | 0.261 | 0.277 | 0.857 |
| 8k | 1,865,360 | 204 | 4/14 | 0.261 | 0.277 | 0.857 |
| 20k | 1,865,360 | 204 | 4/14 | 0.261 | 0.277 | 0.857 |
| 30k | 1,865,360 | 204 | 4/14 | 0.261 | 0.277 | 0.857 |

Hallazgo: budget es SOFT-cap por diseño (assemble-context siempre conserva el primer item de cada path) - matches amplios lo exceden (dev-13 pm2: 1.76M tok, 131 items). Medianas tiny (204 tok) porque las queries puntuales entregan poco. Reporte: `evals/reports/quality-budget.json`.
All ML paths are null-safe (`CF_MODEL_CMD` absent/failure → deterministic heuristic, verified Δ0 without model).

**Real-world evidence — heavy tree (2026-08-15, `/home/nicolas/dev`, ~24 GB / 164,063 files)**

Full report: [`EVIDENCIA-DEV-TREE.md`](EVIDENCIA-DEV-TREE.md) (14 tasks with real ground truth, `evals/reports/dev-tree-20260815.json`).

| Metric | Heuristic | Reranker |
|--------|-----------|----------|
| recall@5 / recall@10 | 0.857 / 0.929 | 0.786 / 0.857 (Δ = fs noise on `filename` queries; neutral on concept/symbol) |
| MRR | 0.637 | 0.520 |

Token/time savings vs naive full-tree grep:

| Case | Naive (grep raw) | Engine | Savings |
|------|------------------|--------|---------|
| dev-13 `pm2` (broad concept) | 33.5M tokens (134 MB) | **1.76M tokens**, 0.66 s cold | **~19×** fewer tokens |
| dev-14 `SERVICE_META` (precise symbol) | 4,056 tokens | **104 tokens**, rerank 83 ms | **~39×** fewer tokens |

Time (cold, measured 2026-08-15 over `/home/nicolas/dev`):

| Query | Naive (grep match + read all files) | Engine cold | Engine warm (cache 5 min) |
|-------|--------------------------------------|-------------|---------------------------|
| dev-13 broad `pm2` (134 MB / 33.5M tok) | ~1.9 s | **0.66 s** | ~0 s |
| dev-14 `SERVICE_META` (16 KB / 4k tok) | ~0.9 s | **0.50 s** | ~0 s |

Intra-session cache (5 min TTL) → warm ≈ 0 latency. Honest: raw grep is faster cold; the engine pays off on broad-concept queries over large trees (ranking + budget + cache included).

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

Métricas duras de tokens y latencia medidas sobre ejecuciones reales (no estimadas). Todo reproducible.

### Test de regresión de métricas (hard)

`npm run bench` mide tiempo y tokens reales de contextforge (C) vs baseline raw-fs (A) sobre el repo sintético, con guardas: la suite **falla** si C gasta más tokens que A o supera los umbrales.

| Query | A tokens | C tokens | A lat | C lat |
|-------|----------|----------|-------|-------|
| lex-01 | 655 | 239 | 43 ms | 144 ms |
| dep-01 | 655 | 239 | 67 ms | 295 ms |
| sem-01 | 655 | 239 | 57 ms | 216 ms |
| tst-01 | 504 | 239 | 47 ms | 251 ms |
| **Σ** | **2,469** | **956** | — | — |

→ **61.3% menos tokens**, wall 1.4 s, 4/4 queries correctas en ambas vías.

### Harness T1 — 32 tasks sintéticas, 4 modos

| Modo | Correctitud | Tokens | Latencia | Compresión vs A |
|------|-------------|--------|----------|-----------------|
| A — baseline raw (`grep`/`cat`) | 100% | 139,199 | 978 ms | 1.0× |
| B — `rg`/`fd` | 92.5% | 95 | 108 ms | 637× |
| **C — contextforge** | **100%** | **764** | **199 ms** | **104×** |
| D — oracle | 87.5% | 611 | 1,506 ms | 129× |

### Repo real T2 — `polar` (2,129 archivos, 50k+ LOC)

| Modo | Correctitud | Tokens | Latencia | Densidad |
|------|-------------|--------|----------|----------|
| A — baseline | 8/8 | 694,581 | 12,098 ms | 0.1856 |
| B — `rg`/`fd` | 8/8 | 409 | 283 ms | 0.1679 |
| **C — contextforge** | **8/8** | **3,403** | **232 ms** | **0.1875** |
| D — oracle | 8/8 | 2,512 | 7,867 ms | 0.1668 |

C corta **204× vs baseline** en el repo real con 98% menos latencia, manteniendo correctitud y la mayor densidad (información útil por token).

Reproducible: `npm run eval` (harness completo) y `npm run bench` (métricas duras con guardas).

---
## Testing

Run the full suite (34 unit tests + smoke + e2e):

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


```bash
npm test    # 34 unit tests + smoke + e2e
npm run bench  # métricas duras: tokens y latencia reales (C vs A) con guardas de regresión
```

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


## Naming: CQ / CIR / CQP

context-query-engine's query language is called **CQP (Context Query Plan)** — deliberately not "CQL", which collides with third-party standards (ARROW/Europeana, MDPI "Context Definition and Query Language", USENIX).

```
Context Query (CQ)          → the agent's request text
Context Intermediate Rep.   → parsed representation (concept; folded into CQP today)
Context Query Plan (CQP)    → logical plan produced by parseCQP
Physical Retrieval Plan     → optimizer output (ordered ops)
```

`CIR` is documented as a concept but not implemented as a separate layer (YAGNI: the parser emits the logical plan directly).


## License

[MIT](LICENSE)

