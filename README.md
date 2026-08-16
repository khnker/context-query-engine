# context-query-engine

**A query optimizer for agent context.** Turns agent context retrieval into a declarative, cost-aware query execution problem: it interprets what the agent needs, plans how to obtain it (like a database optimizer plans SQL), and materializes only useful context within a token budget.



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

`npm run bench` mide tiempo y tokens reales de context-query-engine (C) vs baseline raw-fs (A) sobre el repo sintético, con guardas: la suite **falla** si C gasta más tokens que A o supera los umbrales.

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
| **C — context-query-engine** | **100%** | **764** | **199 ms** | **104×** |
| D — oracle | 87.5% | 611 | 1,506 ms | 129× |

### Repo real T2 — `polar` (2,129 archivos, 50k+ LOC)

| Modo | Correctitud | Tokens | Latencia | Densidad |
|------|-------------|--------|----------|----------|
| A — baseline | 8/8 | 694,581 | 12,098 ms | 0.1856 |
| B — `rg`/`fd` | 8/8 | 409 | 283 ms | 0.1679 |
| **C — context-query-engine** | **8/8** | **3,403** | **232 ms** | **0.1875** |
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

- **Unit** — `node --test` over `engine/` (parser, optimizer, statistics, local-model).
- **Smoke** — bash scripts: `npm run check-tools` plus one end-to-end run of the worked query.
- **End-to-end** — `node engine/engine.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'`, asserting each pipeline stage emits the expected NDJSON.

**Verification (2026-08-15)** — all green:

```text
npm test                    34/34 pass  (unit + smoke + e2e)
openspec validate           18/18 pass
npm run bench               PASS (61.3% compression, guards)
ML gate (evals/ml/GATE-ML.md)  15/15 PASS — no regression on polar (T1/T2)
mcp-test.sh                 RC=0 (init → tools/list → tools/call)
```


---


```bash
npm test    # 34 unit tests + smoke + e2e
npm run bench  # métricas duras: tokens y latencia reales (C vs A) con guardas de regresión
```

## Reproducibility

All headline benchmark numbers are generated from versioned datasets, pinned repository commits, fixed query sets, reproducible execution manifests, and raw per-query results.

```bash
./evals/reproduce.sh T1          # in-repo fixtures (32 queries)
./evals/reproduce.sh T2          # polar, TEST split (8 queries)
./evals/reproduce.sh dev         # dev workspace tree (14 queries, ground truth real)
./evals/reproduce.sh T1 --smoke  # CI rápido: 2 queries, runs=1
```

Cada run produce un artefacto verificable en `evals/results/<BENCH>-<TS>/`: `manifest.json` (thresholds + SHA256 inputs), `environment.json` (machine/commits/model sha256), `queries.jsonl` (dataset congelado), `raw-results.jsonl` (una fila por query×modo×run), `metrics.json`, `statistical-tests.json` (bootstrap pareado, 95% CI) y `report.md` con veredicto PASS/FAIL (exit 0/1).

The benchmark does not assume that lower token usage is better by itself; results are evaluated jointly on correctness, context cost, latency, information density, and optimizer regret.

| Claim | Test | Baseline | Primary metric |
|-------|------|----------|----------------|
| Reduce context | T1/T2 | rg/fd | tokens |
| No information loss | T1/T2 | baseline | correctness |
| Improves efficiency | T1/T2 | baseline | tokens + latency |
| Improves density | T1/T2 | baseline | information density |
| Optimizes plans | Oracle | heuristic | regret |
| ML improves estimation | held-out | heuristic | MAPE |
| ML improves decisions | Oracle | heuristic | regret |
| Reranker helps | E2E | deterministic | MRR + recall + density |

## CQE vs hybrid retrieval

CQE se evalúa como optimizer *por encima* del algoritmo de retrieval subyacente: los mismos planes de ops corren sobre rg (baseline), sobre un op BM25 propio en node (`engine/bm25.js`, stdlib, sin deps) y sobre la fusión de ambos (`CF_RETRIEVAL=hybrid`). El modo dense (embeddings) queda marcado como `requires-dep` — el proyecto es stdlib solo.

```bash
TMPDIR=$PWD/.tmp CF_TASKS=t1 node evals/scripts/eval-hybrid.js   # matriz → evals/reports/hybrid-<TS>.json
```

Matriz T1 (32 tasks, 1 run):

| config | correctness | recall@5 | MRR | tokens (mean) |
|--------|-------------|----------|-----|---------------|
| BM25 puro | 0.844 | 0.667 | 0.732 | 135 |
| CQE+hybrid | **1.000** | **0.870** | 0.939 | 239 |
| CQE+hybrid+rerank | 1.000 | 0.870 | 0.964 | 253 |
| CQE (baseline) | 1.000 | 0.833 | 0.939 | 105 |
| CQE+rerank | 1.000 | 0.833 | 0.964 | 105 |

Veredicto: **hybrid no degrada correctness** (1.000 = 1.000 en T1 y T2) y **mejora recall@5 en T1** (+3.7pp, 0.870 vs 0.833) — BM25 rescata hits que rg pierde. Costo: 2.3× tokens por los snippets BM25; la fusión compite en score_final de `assemble-context`. BM25 puro pierde correctness (0.844): no reemplaza a CQE, solo aporta como op de fusión. En dev (monorepo), BM25 puro falla (cap de 1000 archivos del índice) — el optimizer + rg siguen siendo necesarios. El op `bm25` queda incorporado al plan físico (COST_TABLE + `CF_RETRIEVAL`).

Veredicto: **hybrid no degrada correctness** (1.000 = 1.000 en T1 y T2) y **mejora recall@5 en T1** (+3.7pp, 0.870 vs 0.833) — BM25 rescata hits que rg pierde. Costo: 2.3× tokens por los snippets BM25; la fusión compite en score_final de `assemble-context`. BM25 puro pierde correctness (0.844): no reemplaza a CQE, solo aporta como op de fusión. En dev (monorepo), BM25 puro falla (cap de 1000 archivos del índice) — el optimizer + rg siguen siendo necesarios. El op `bm25` queda incorporado al plan físico (COST_TABLE + `CF_RETRIEVAL`).

### Reranker–fuse alignment (fix de recall)

El reranker subía MRR pero BAJABA recall@5 (0.630 vs 0.833). Diagnóstico por etapas (`eval-rerank-stages.js`): candidate recall 1.0 (el GT siempre está en el pool), el reranker MEJORA el pool (0.818→0.833), y la pérdida ocurría en la **fusión**: el modelo puntuaba el GT exacto con ~0.003 (char-ngrams q+p sin vocabulario de código) y el filtro `score >= 0.2` de `assemble-context` lo ELIMINABA. Fix: anclaje de matches exact/filename/structural (conservan score heurístico, siempre arriba) + floor 0.3 al score del modelo (nunca bajo el filtro) + `CF_SCORE_WEIGHT` (peso del score en score_final: 0.3 legacy, 0.5 automático con modelo). Resultado: recall@5 del rerank = heur (0.833, sin sacrificio) con MRR aún mejor (0.964 vs 0.939); hybrid+rerank 0.870 r@5.


## Harder baselines

CQE se compara contra baselines no-triviales: agente crudo (rg -n / rg --files directos), RepoMap textual (file tree rankeado por overlap léxico) y BM25 puro.

```bash
TMPDIR=$PWD/.tmp CF_TASKS=t1 node evals/scripts/eval-baselines.js   # → evals/reports/baselines-<TS>.json
```

Matriz T1 (32 tasks):

| baseline | correctness | recall@5 | MRR | tokens (mean) |
|----------|-------------|----------|-----|---------------|
| Agente crudo (rg -n) | 0.875 | 0.609 | 0.637 | 281 |
| Agente crudo (rg --files) | 0.594 | 0.406 | 0.453 | 13 |
| RepoMap textual | 1.000 | 0.698 | 0.810 | 52 |
| BM25 puro | 0.844 | 0.667 | 0.732 | 135 |
| **CQE** | **1.000** | **0.833** | **0.939** | 105 |
| CQE+rerank | 1.000 | 0.833 | 0.964 | 105 |

Veredicto: **CQE gana o empata en correctness** en T1/T2/dev (1.000/1.000/0.750). En dev, el agente crudo colapsa: 0.000 de correctness con **4.17M tokens** de contexto (rg -n sobre monorepo), vs 538 de CQE — el optimizer existe precisamente para eso. Dónde pierde: recall@10 contra RepoMap en T1 (0.833 vs 0.932) — el file tree completo captura archivos que el plan de CQE no toca; a cambio CQE entrega 2× más recall@5 con el mismo 1.000 de correctness. El baseline de agente completo (rg+read con tool calls, task success, time-to-solution) queda delegado al change `downstream-agent-eval`.

## Downstream agent evaluation

CQE se evalúa por utilidad para un agente, no solo recall: un retrieval-agent determinista (sin LLM, stdlib SOLO) corre el loop retrieve → inspect → think → refine → verify sobre 8 tareas reales con completion medible (answer contiene GT). Dos modalidades: herramientas crudas (rg -n) vs CQE (engine). Hipótesis falsable: "menos contexto ≠ mejor".

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-downstream.js   # → evals/reports/downstream-<TS>.json
```

| modalidad | task success | tokens (mean) | tool calls | tts |
|-----------|--------------|---------------|-----------|-----|
| Agente crudo (rg -n) | 0.750 | 244 | 2.9 | 6 ms |
| Agente + CQE | **1.000** | 349 | 3.4 | 102 ms |

Veredicto del umbral estricto (CQE ≥ crudo en success Y menos tokens): **FAIL** — CQE no reduce tokens totales (+43%). El matiz importa: la prima de tokens viene de las 2 tareas donde el agente crudo NO TIENE respuesta (rg devuelve 0 líneas, 0 tokens, 0 success) — CQE las resuelve (615/268 tokens). Por tarea resuelta el costo es comparable (349 vs 325). Hallazgo: la hipótesis "menos contexto ≠ mejor" se confirma al revés — la utilidad (task success) gana con mejor selección aun con más contexto; CQE aporta +25pp de task success sin responder peor en ninguna tarea. El costo de latencia (102 ms vs 6 ms) es el precio del optimizer; en flujos batch reales domina el ahorro de turnos fallidos.

## ABSTAIN / No-Answer

Ante queries sin respuesta en el repo, el engine puede **abstener** en vez de devolver resultados débiles: con `CF_ABSTAIN=1`, si la fusión no produce matches relevantes (exact/filename/structural; git-log cuenta como evidencia para planes git), el resultado es `{abstained:true, reason}` con 0 tokens.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-abstain.js   # → evals/reports/abstain-<TS>.json
```

Dataset: 24 queries no-gold (13 símbolos/archivos fabricados + 11 conceptos ausentes, GT vacío) + 32 gold de T1. Métricas:

| métrica | valor |
|---------|-------|
| abstention precision | 0.941 |
| coverage no-gold (abstiene cuando debe) | 0.667 |
| coverage gold (NO abstiene con respuesta real) | 0.969 |
| FP retrieval (no-gold respondido) | 8 |
| FN retrieval (gold abstuvo) | 1 |

Veredicto umbral 6.5 (precision ≥ 0.7 ∧ coverage_gold ≥ 0.8): **PASS**. Los 8 FP son queries semánticas no-gold cuyo ruido weak (match_type semantic, 0 hits reales) supera el umbral; los 2.7k-7.8k tokens muestran escalación semántica sobre consultas inexistentes. FN restante: sem-04 (concept gold con evidencia solo-semántica). Tuning posible: umbral de score en evidencia semántica (hoy binario por match_type).



## Distribution shift (OOD) — FAIL

El cost model ML (cardinality, ridge) se evalúa fuera de su distribución de entrenamiento: train en t1-basic (TypeScript) → val t1-modular (Python) → test dev (workspace real). Se entrena ridge en node (mismo pipeline que classify.mjs) y se compara MAPE ML vs baseline heurístico por op|queryClass.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-distribution-shift.js   # → evals/reports/distribution-shift-<TS>.json
```

| split | MAPE ML |
|-------|---------|
| train (t1-basic, n=25) | 25.9% |
| val (t1-modular, n=17) | 92% (3.6×, shift TS→Python) |
| test (dev, n=6) | 237.3% |

Veredicto: **FAIL** — ratio OOD/train 9.18× (umbral 2×). El baseline heurístico generaliza mejor fuera de distribución (test 28% vs ML 237%). **El fallback heurístico queda como default**; el modelo solo se confía en distribución. Tarea derivada: retrain por repo o regularización/feature engineering antes de usar el cost model OOD. Artefacto: evals/reports/ood-cardinality-model.json.

## Adversarial workloads — FAIL parcial (8/10 categorías)

30 queries adversas (10 categorías × 3) sobre polar + fixtures: símbolos de alta frecuencia, identificadores ambiguos, fan-out masivo, zero-results, cadenas de dependencia profundas, implementaciones duplicadas, código generado, vendor-code (anti-leak), monorepo, polyglot.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-adversarial.js   # → evals/reports/adversarial-<TS>.json
```

- PASS (8/10, correctness 1.0): high-frequency, ambiguous, huge-fanout, zero-results (abstain limpio), duplicates, vendor anti-leak, monorepo, polyglot.
- **FAIL con evidencia**: deep-dependency-chain 0.667 (plan concept falla en "dependency injection") y generated-code 0.667 (dist gitignored → invisible a rg).
- Regret 0 en todo; 0 false-confidence (concept falla con confidence < 0.9).

Mitigaciones pendientes (M1-M3): M1 planes concept con fallback estructural/filename (deep-chain); M2 opción --no-ignore opt-in (generated-code, límite de gitignore documentado — no es bug); M3 enforcement estricto de budget o cap top-K fan-out (token explosion en path-clusters) + candidato CF_REOPT lexical-skip para latencia polyglot (4.7s).

## Expected Utility Cost Model (REJECT)

El optimizer puede seleccionar por utilidad esperada (`CF_UTILITY=1`): EU = P(correct|plan)·value − tokens·Wt − latency·Wl − (1−P)·failure_penalty·Wf, con P(correct) derivada de la varianza del cardinality estimator (varianceTokens). Ablación sobre T1 (32 tasks) vs selección actual (cost/quality): **no mejora** — correctness 1.000 = 1.000, pero regret 0.1633 = 0.1633 (0% reducción, umbral 10%).

```bash
TMPDIR=$PWD/.tmp CF_TASKS=t1 node evals/scripts/eval-utility.js   # → evals/reports/utility-<TS>.json
```

| selector | plan_acc | regret | tokens | correctness |
|----------|----------|--------|--------|-------------|
| cost/quality (actual) | 0.906 | 0.163 | 105 | 1.000 |
| EU (CF_UTILITY=1) | 0.438 | 0.163 | 105 | 1.000 |

Root cause: la señal de varianza no diferencia variantes de plan (comparten el op primario y costos de tokens casi idénticos) → EU degenera a ranking por costo. El oráculo distingue por tie-break de gt_hits, no por tokens. Fix necesario (tarea derivada): señal de incertidumbre POR VARIANTE (varianza de est_candidates o success rate por plan id). El modo queda disponible sin tocar el default.

## Cuándo NO usar context-query-engine

Evaluación de failure modes (24 queries triviales, 6 categorías: exact-filename, exact-symbol, single-file, one-shot, tiny-repo, trivial-regex; repos t1-basic/t1-modular/polar). Artefacto: `evals/reports/failure-modes-<TS>.json`, reproducir con `TMPDIR=$PWD/.tmp node evals/scripts/eval-failure-modes.js`.

| categoría | raw correctness | cqe correctness | raw lat | cqe lat |
|-----------|-----------------|-----------------|---------|---------|
| exact-filename | 0.25 | 1.00 | 66ms | 102ms |
| exact-symbol | 0.25 | 1.00 | 67ms | 123ms |
| single-file | 0.25 | 1.00 | 68ms | 123ms |
| one-shot | 0.50 | 1.00 | 71ms | 125ms |
| tiny-repo | 0.00 | 1.00 | 17ms | 113ms |
| trivial-regex | 0.50 | 1.00 | 17ms | 115ms |

Hallazgos (24 queries, lose_rate 0.000 — CQE nunca pierde correctness en estos casos):

- **Correctness**: CQE gana en TODAS las categorías. El raw `rg -n` por palabras pierde queries de nombre de archivo (rg busca contenido, no rutas) y se contamina en repos grandes (dumps/coverage lo desbordan).
- **Dónde SÍ gana rg**: solo en **latencia en repos pequeños**. Lookup de archivo/símbolo exacto en t1-basic/t1-modular: rg 8-18ms vs CQE 95-149ms → **rg ~6-10x más rápido**. Para un one-shot puntual de un nombre único en un repo chico, `rg` directo es la opción.
- **Dónde NO puede competir rg**: tokens. En polar, rg content-scan devuelve ~16.7M tokens (líneas de dumps SQL/coverage) vs CQE 10-292. Overhead de pipeline CQE: +36-98ms por query (spawn+optimizer+fusión), compensado con creces en repos medianos/grandes.

Regla de oro: **búsqueda de archivo por nombre exacto en repos pequeños → rg es 6-10x más rápido en latencia (pero sin garantía de correctness). En repos ≥ mediana o con queries mixtas filename+contenido → CQE domina en correctness y tokens.**

## Indexing cost & break-even

Medición (`evals/scripts/eval-indexing.js`, tasks 3.1-3.5 del change `indexing-cost-breakeven`): T_index = build BM25 cold (median 3 runs, proceso fresh, index lazy per-process en `engine/bm25.js`, cap 1000 files/256KB); T_incremental = rebuild full por proceso (impl actual no tiene índice incremental — touch 5 files no reduce coste); RAM = rss tras build; T_query cold/warm = `engine.js` sobre el cqp representativo del repo (warm = cache persistido en `engine/.cache.json`, `cache_hits=1`); baseline = `rg -n --no-ignore -g !node_modules` (median 3). Artefacto: `evals/reports/indexing-cost-*.json`.

| repo | files | bytes | T_index (med) | RAM pico | T_incremental | T_query cold | T_query warm | rg baseline | N_break_even |
|---|---|---|---|---|---|---|---|---|---|
| t1-basic | 9 | 3.3KB | 2ms | 45.9MB | 2ms | 132ms | 77ms | 6ms | 0 |
| t1-modular | 11 | 1.8KB | 2ms | 45.7MB | 2ms | 128ms | 80ms | 7ms | 0 |
| polar | 1000 (cap) | 11.4MB | 418ms | 141.6MB | 408ms | 150ms | 93ms | 712ms | 0.7 |
| dev | 1000 (cap) | 17.9MB | 924ms | 181.2MB | 920ms | 383ms | 100ms | 822ms | 1.3 |

- **N_break_even = T_index / (baseline − T_query_warm)**; denominador ≤ 0 → N=0 (el setup nunca se amortiza).
- **Regla (3.5):** repos con N_break_even > 100 → *usar rg para workloads < N queries*. Ningún repo del stack excede el umbral.
- t1-*: N=0 — CQE warm (~80ms de overhead node+engine) es más caro por query que rg (~6ms); en repos chicos conviene rg directo (CQE agrega latencia sin ahorro de setup, que es trivial).
- polar/dev: N<1.3 — el index build (~0.4-0.9s) se paga con la primera query (rg tarda 0.7-0.8s por query). Alternativa BM25-only cold (reindexa por proceso cada query): N≈1 — CQE evita re-indexar, quiebre inmediato.
- T_incremental == T_index: la impl actual reindexa full por proceso; tarea derivada = índice incremental persistente si T_index > 1s en repos grandes.


## Derived tasks (roadmap v1.6)

- **Índice BM25 incremental persistente**: ✅ DONE (bm25-incremental-index) — índice persistido a `engine/.bm25-index.json` con validación por mtime; reuse entre procesos polar 335→180ms / dev 714→317ms (~2.1-2.2×, umbral 0.6×). Resta: incremental por archivo (hoy touch 1 archivo → rebuild full, 973-1828ms). Ver `evals/reports/index-persist-<TS>.json`.
- **Señal de incertidumbre por variante de plan**: ✅ DONE (plan-variant-confidence) — telemetría `plan:<id>|queryClass` con success=relevant encontrado (skipBlend); planPCorrect usa successRate por plan (n≥5). La señal discrimina (P 0.84-0.96 vs fallback 0; expected_total_cost 202→105: EU evita retry) pero NO flipea selección en T1: A/B quedan con P similar y el término de costo domina → regret sin cambio (0.1660 = 0.1660). REJECT igual que expected-utility-cost, con la causa aislada: para flipear hace falta P que difiera entre variantes en queries donde los costos empatan (hoy el oráculo gana por tie-break de gt_hits, no capturable por tokens). Ver `evals/reports/utility-<TS>.json` (último run con preheat).
- **Cost model OOD**: ✅ DONE (cost-model-ood, REJECT) — retrain combinado TS+Python (t1-basic+t1-modular) con λ sweep {1,10} evalúa en dev: MAPE out 237%→194.9% (λ=10) pero el baseline heurístico (avg por op|qc del train) da 27.7% → el promedio por (op|qc) transfiere mejor OOD que el ridge; la feature log1p(est_candidates) corrompe OOD (est es sistemáticamente erróneo). Fallback heurístico confirmado como default correcto; modelos por repo o features de lenguaje = límite conocido fuera de alcance. Ver `evals/reports/cost-model-ood-<TS>.json`.
- **Mitigaciones adversarial**: ✅ DONE (adversarial-mitigations) — M1 escalación concept con evidencia exacta primero (rg-files por palabra → search-structure → semántica; dc-14/15 ✓, dc-13 miss estructural documentado: GT sin match léxico, probe ausente); M2 generated-code recuperado 3/3 con `CF_SEARCH_NO_IGNORE=1` + `CF_INCLUDE_GENERATED=1` (bad_path relajado; gc-19 package-lock gitignored, gc-20 dist main.js); M3 token explosion acotada con budget duro en fuse (mo-26 15836→7992 tokens sin perder correctness). Descartado: cap fan-out por truncación en engine (rompía correctness — rg scores uniformes → truncado arbitrario). **strict-budget-default**: el budget duro es ahora el DEFAULT (opt-out `CF_STRICT_BUDGET=0` para el comportamiento legacy con path-cluster); mo-26 default = 7,992 ≤ 8,000 con correctness ✓; matriz T1 idéntica. Ver `evals/reports/mitigations-<TS>.json`.
- **Harness acotado/reproducible**: ✅ DONE (harness-bounded-reproducible) — todo run del engine desde un eval script tiene timeout por query (60s) + aislamiento de error (fila con error, no aborta) en eval-recall/hybrid/baselines/downstream/failure-modes; dev completo sin --limit bajó de >15 min a ~9s; artefactos siempre escritos. Ver `evals/reports/` y `reproduce.sh`.

## Quality-aware selection (REJECT)

Política de escalación simulada offline sobre el artefacto congelado de diagnosis (32 tasks, planes A/B/C forzados): correr en orden de costo estimado y escalar a un plan mayor solo si la señal de calidad observada < umbral.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-quality-policy.js   # → evals/reports/quality-policy-<TS>.json
```

| política | tokens | gt_hits | r@5 | escalaciones |
|----------|--------|---------|-----|--------------|
| cost_only (actual) | 105 | 4.438 | 0.833 | 0 |
| exactness θ=1.0 | 116 | 4.438 | 0.833 | 4 |
| gt_hits θ=5 (techo) | 237 | 4.875 | 1.021* | 17 |
| oracle_quality | 221 | 5.375 | 1.021* | — |

La señal exactness (runtime-observable sin GT) es **plana**: nunca escala el gt (4.438 en todo el sweep) — mismo diagnóstico que cost/quality. Incluso con señal oráculo gt_hits, ningún umbral alcanza el objetivo (≥90% del oráculo @ ≤2.0× tokens): θ=5 da 4.875 (90.7%) pero a 2.26× tokens. La frontera es dura: el +21% de gt_hits del oráculo cuesta 2.1× tokens sin punto medio barato. **Veredicto REJECT** en fixtures sintéticas (plan A ya satisface casi todo); re-testear en repos reales (T2/dev) o exponer tradeoff explícito para queries high-stakes. (*1.021 = anomalía de display del artefacto base.)


## Evidence Model + Context Selection (07A ADOPTED / 07B REJECT parcial)

El score no es el lenguaje universal: evidencia determinista (exact/filename/structural = hecho observado) y estimaciones (semantic/reranker = belief) viven en espacios epistémicos distintos. La fusión ahora usa **eligibility por tier** (`evidence_tier <= 1` → siempre elegible; tier2+ → umbral 0.2) y el reranker deja el score crudo del modelo (el floor 0.3 desapareció — su rol lo tomó la eligibilidad). Context selection submodular (`CF_SELECTOR=marginal`, engine/selector.js): greedy por ganancia marginal bajo budget duro; con budget holgado es inerte (sin pérdida), con budget tight (fan-out) la variante MMR supera a top-k (gt +14%, density 0.0063 vs 0.0055).

```bash
TMPDIR=$PWD/.tmp CF_TASKS=adv CF_SELECTOR_BUDGET=400 node evals/scripts/eval-context-selection.js
```

| selector | gt_hits | tokens | dirs | density |
|----------|---------|--------|------|---------|
| top-k (fuse legacy) | 1.75 | 319 | 17.0 | 0.0055 |
| MMR (λ=0.7) | **2.00** | 318 | **17.3** | **0.0063** |
| marginal (07B v1) | 1.75 | 319 | 17.0 | 0.0055 |

Iteración siguiente: calibrar pesos de marginal (diversidad/redundancia) o adoptar CF_SELECTOR=mmr. Ver también: pairwise-plan-preference, adaptive-query-execution (backlog v1.7).


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

## Retriever disagreement → active retrieval

Señal de incertidumbre de retrieval sin entrenar modelo: el desacuerdo entre fuentes (lexical/structural/semantic/bm25/git) predice riesgo de GT missing y activa adquisición adicional.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-disagreement.js --adv   # → evals/reports/disagreement-<TS>.json
```

Instrumento (hook CF_DISAGREEMENT_FILE en engine, pre-fuse): agreement_rate = soporte medio de archivos en la unión de top-5 por fuente (paths normalizados; 1 = convergen, 0 = dispersión). 47 queries (T1 + adversarial fan-out):

| estado | P(gt_miss) |
|--------|------------|
| agreement ≥ 0.5 (alta) | **0.000** |
| agreement < 0.5 (baja) | **0.050** |
| no-signal (fuente única: concept/zero-results) | 5/6 misses → abstain |

Hipótesis SOSTENIDA: baja concordancia → más riesgo de miss. Caso validado: adv-po-30 ('main', poliglote) — rg inundado (score 1 uniforme), bm25 irrelevante, agreement 0 → requiere índice estructural/símbolos. Regla de trigger: agreement < 0.5 → adquirir fuentes ausentes; fuente única sin candidatos → abstain. Loop de adquisición runtime = change `adaptive-query-execution`. Instrumentación descartada: Jaccard top-10 entre fuentes (disjuntos por construcción) y margen top1-top2 (scores rg uniformes 1.0).

## Repository Index Layer

Capas de acceso a los repositorios materializadas (SQLite+FTS5, node:sqlite, zero deps) bajo `engine/index-layer/`. El índice produce **evidencia tipada**, no search results: `{source, entity, path, span, certainty, index_version, cost{latency_ms, tokens}}` — determinista (symbol/dependency: certainty 1.0) o probabilística (lexical: 0.9).

```bash
node engine/index-layer/index.js index <repo>         # build incremental (manifiesto sha256)
node engine/index-layer/index.js query <repo> symbol retryWithFallback
node engine/index-layer/index.js query <repo> lexical fallback
node engine/index-layer/index.js freshness <repo>    # snapshot | dirty_scope → use_index | reindex
```

Componentes: store (SQLite WAL + FTS5, `.cqe/catalog.db`), manifest (diff sha256/mtime/size), extractores de símbolos/deps por lenguaje (TS/JS/Python regex), indexer incremental (1 archivo tocado → 1 reindexado), watcher (fs.watch recursive + debounce + coalescing a `FileChangeEvent`), freshness model (nunca evidencia vieja silenciosa — decide reindex o live-disk).

| repo | build | reuse | incr (1 f) |
|------|-------|-------|------------|
| t1-basic | 54ms | 58ms | 58ms (1) |
| polar | 134ms | 123ms | 130ms (1) |

Watcher roundtrip 259ms; queries < 50ms. Este es el access layer del planner: los índices se convierten en **access paths** que el optimizer puede elegir (change `context-query-ir`), en vez de rg/search sobre filesystem crudo. Detalle v1: symbols por regex (sin tree-sitter); differencial vs Frigg/cqs = el planner/retrieval queda en CQE, aquí solo el catálogo materializado.

## Repository structure

│   ├── optimizer.js               # candidate plans + cost model + telemetry + learned mappings
│   ├── engine.js                  # pipeline: parse → optimize → execute → fuse (+ cache)
│   ├── mcp-server.js              # MCP stdio: context_query / search_files / read_file
│   └── README.md
├── scripts/                       # 9 CLIs (project-map, search-code, search-structure, ...)
├── evals/                         # benchmark + target analyzer
└── openspec/                      # spec-driven (local-only, git-ignored) (local, git-ignored)
```

---



## Operator cost model (REJECT)

`CF_LEARNED_COST=1` reemplaza la COST_TABLE estática por costos medidos (p95 tokens / avg latencia por op|query_class, n>=5) desde la telemetría. Ablación T1: correctness 1.000 = 1.000 pero tokens 105 vs 104 → **REJECT**. Los promedios por op no discriminan variantes A/B/C (mismas ops reordenadas → coin-flip: plan_acc 0.9063→0.4375 sin cambio de tokens); la señal de costo relevante es cardinalidad por query. El valor real de costos aprendidos es para elegir entre FAMILIAS de ops (rg 15ms vs index 2-5ms), donde la COST_TABLE ya captura la diferencia — re-test orientado a access paths (context-query-ir) si se quiere.


## Evidence State (REJECT parcial)

Belief state por query (`stats.belief`): sources, agreement_rate (soporte cross-source top-5), coverage_estimate (fracción de evidencia determinista tier0/1 en el pool), n_pool. Correlación Spearman vs gt_hit sobre T1 + adversarial fan-out (47 queries):

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-evidence-state.js   # → evals/reports/evidence-state-<TS>.json
```

| señal | Spearman |
|-------|----------|
| coverage_estimate | **-0.268** (anti-correla) |
| agreement_rate | +0.155 (débil) |

Hallazgo: coverage alto ≠ confianza — la inundación léxica (rg score 1 uniforme sobre símbolos comunes tipo 'main') llena el pool de tier0 y es justo el caso miss. coverage sirve como señal ANTI (flood-detection), no de suficiencia; agreement es la señal usable para adquirir (coherente con retriever-disagreement). Umbral 1.4 no cumplido → REJECT; señales documentadas para adaptive-plan-selection.


## Adaptive plan selection (REJECT)

CF_ADAPTIVE=1: el belief state (agreement/coverage pre-fuse) decide adquisición extra — flood (coverage > 0.85, n_pool > 30, agreement < 0.5) → symbol-lookup; divergencia de fuentes (agreement < 0.5) → bm25 + dependency-expand. Eval 62 queries (T1+adv): correctness 0.839 = 0.839 (parity), flood detectado en 14, **recovery 0** — la evidencia adquirida (structural 0.7) rankea bajo el flood rg 'exact' (1.0) y el budget se consume antes del GT (adv-po-30: pool 35k rows → gt 0).

Variante descartada con evidencia: descartar la fuente inundada rompe correctness (0.839→0.710) — la fuente flood suele contener el GT (logger/env multi-hit). Mitigación correcta (derivada): boost de prioridad de evidencia adquirida en fuse o cap diverso pre-fuse. CF_ADAPTIVE queda disponible, OFF por default.


## Context selection (MMR) — paso 06

Selección de contexto bajo budget duro vía MMR real en `engine/selector.js` (`CF_SELECTOR=mmr`, λ=0.7, sameRegion dirname=1/prefijo-compartido=0.5), comparada con el greedy marginal y con top-k.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-ssm.js   # → evals/reports/ssm-<TS>.json
```

44 tasks (12 adversarial fan-out + 32 T1), ranked único con `CF_SELECTOR_RANKED_ONLY=1` + hybrid; selectores reales offline a 2000/800/400:

| budget | top-k gt | marginal gt | MMR gt |
|--------|----------|-------------|--------|
| 2000 | 208 | 233 | 233 |
| 800 | 208 | 224 | 212 |
| 400 (tight) | 204 | 204 | **207** |

Veredicto **PASS**: MMR ≥ top-k en tight (207 ≥ 204) y sin regresión en T1 loose (197 = 197); smoke end-to-end `CF_SELECTOR=mmr CF_SELECTOR_BUDGET=400` verificado en fan-out. Lectura: MMR gana cuando el budget aprieta (diversidad evita cluster de ruido); marginal en budget medio; ambos ≥ top-k en todo el sweep. Tuning de λ por familia de query = refinamiento.


## Abstain calibration (conformal) — REJECT

Split-conformal para abstention: nonconformity = 1 − max evidence strength (tiers por match_type), θ = 1 − q̂ calibrado, modo `CF_ABSTAIN_CONFORMAL=1`. Resultado (α=0.2, holdout 8 gold + 24 no-gold): gold_calibrated θ=1.0 → **gold coverage 0.875 ≥ 0.80 ✓**, no-gold 0.625 (< 0.667 ✗), precision 0.938 ✓; mixed θ=0.0 → responde todo (garantiza cobertura, abstention 0). **Veredicto: REJECT con hallazgo** — la evidencia strength no separa gold de no-gold (los FP alcanzan tier0 = strength 1.0 igual que gold); conformal honesto colapsa a la regla binaria legacy (θ=1), que queda CONFIRMADA como abstain máximo consistente con la garantía de cobertura (formalizada: P(GT∈context) ≥ 1−α bajo exchangeability). Mejora de no-gold requiere señal de distribución de query o score de modelo calibrado, no umbral de evidencia.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-conformal.js   # → evals/reports/abstain-conformal-<TS>.json
```


## Context query IR (CF_INDEX=1) — PASSA

Access paths materializados: el planner puede sustituir ops sobre filesystem crudo por consultas al catálogo (engine/index-layer) — `CF_INDEX=1` mapea search-code/rg-files→lexical-index, search-structure→dependency-expand (solo definitions/references/implementation/filename; pattern/concept conservan rg, FTS no es regex).

```bash
TMPDIR=$PWD/.tmp CF_TASKS=t1 node evals/scripts/eval-ir.js   # → evals/reports/ir-<TS>.json
```

| modo | correctness | tokens | r@5 | MRR |
|------|-------------|--------|-----|-----|
| cqe (rg) | 1.000 | 104 | 0.833 | 0.939 |
| index (CF_INDEX=1) | **1.000** | **36** (2.9× menos) | 0.823 | 0.720 |

Veredicto: **SÍ sirve** — 2.9× menos tokens sin perder correctness; MRR menor porque las filas del índice no traen spans de línea exactos (siguiente: op físico READ_SPAN). Costo: build 326-341ms. Descartados con evidencia: AND-tokens camelCase, symbol-lookup para filename, substitución en pattern/concept.

## Physical query decomposition (CF_DECOMPOSE=1) — NO sirve (REJECT parcial)

Descomposición determinista (sin LLM) de queries multi-facet en sub-consultas por keywords EN+ES (`engine/decompose.js`): facetas persistence/callers/definition → `FIND references/definitions/implementation OF symbol <name>`.

| modo | correctness | tokens (medio) |
|------|-------------|----------------|
| baseline | 0.900 | ~4.5k |
| CF_DECOMPOSE=1 | 0.900 | +3006 (2-3×) |

Veredicto: **NO sirve en el corpus actual** — gt gain 0/10 (la intención resuelta ya cubre la faceta principal); costos 2-3× (polar 2×). `CF_DECOMPOSE` OFF por default. Escenario de ganancia real (entidad con callers/impl distintos del def) no representado en fixtures — anotado para re-test. El mecanismo determinista funciona (facetas 7/10).


## Pairwise plan preference (Lero) — paso 08, SÍ SIRVE

Primera vía de aprendizaje que mejora la selección de plan. Modelo logístico pairwise (numpy, sin deps): aprende P(A≻B | features del par + query_type) del OUTCOME real (gt_hits), no de costos estimados — la diferencia clave vs los 4 REJECTs previos (EU/plan-variant/cost-model/quality-aware).

```bash
python3 evals/ml/train-pairwise.py                      # 74 tasks, 222 pares → pairwise-model.json
TMPDIR=$PWD/.tmp node evals/scripts/eval-pairwise.js    # → evals/reports/pairwise-<TS>.json
```

| selector | plan_acc | gt_hits (media) | tokens | correctness |
|----------|----------|-----------------|--------|-------------|
| cost_only (default) | 0.608 | 2.770 | 1393 | 0.851 |
| pairwise | **0.635** | **3.311 (+19.5%)** | 1417 (+24) | **0.851** |

Veredicto: **SÍ sirve** — +19.5% gt_hits con tokens casi iguales. Holdout 0.733 (balanced 0.842). Aprender el orden relativo cancela el ruido de escala entre queries que rompía la regresión de costos. Pendiente: integración runtime en optimizer.js (el modelo ya está disponible; la simulación fue offline sobre perTask).


## Repo fingerprint consistency (máxima transversal)

Máxima: **todo artefacto que derive de archivos declara su dependencia del estado del repo** — si el fingerprint cambia, se invalida o se marca stale; nunca evidencia vieja silenciosa.

Fingerprint barato (`repoFingerprint`, engine/index-layer/manifest.js): sha256 de la lista ordenada `path|size|mtimeMs` (walk+stat, sin leer contenido). mtime+size para el scan completo; sha256 de contenido solo sobre archivos cambiados.

| Artefacto | Acción al cambiar el repo |
|-----------|---------------------------|
| Cache engine (`.cache.json`) | Key con fingerprint: entrada filtrada en loadCache → miss determinista (activo si `CF_FINGERPRINT=1` o existe catálogo `.cqe/`) |
| BM25 persistido (`.bm25-index.json`) | `loadPersisted` valida fingerprint → rebuild (además de mtime+size) |
| statistics.ndjson | Cada record lleva `repo_fp` (setFingerprint por runPlan) → provenance para modelos |
| Índice catalog (SQLite) | Manifest sha256 + freshness snapshot/dirty_scope (ya existía) |

Verificado (eval-fingerprint.js): cache cold 0 → warm 1 → **touch → 0 (invalidada)** → 1 (repoblada); BM25 rebuild por fingerprint; stats con repo_fp. Bugs que esto elimina: cache con TTL 5min devolviendo evidencia vieja, stale-catálogo sin rebuild, drift de stats sin provenance. Modelos aprendidos: tagging con fingerprint de entrenamiento queda como refinamiento (runtime staleness check).


## Cheap query bypass — SÍ SIRVE (parcial)

"Optimizar tiene costo": queries triviales (filename inequívoco + repo < 500 archivos) van directo a rg-files + fuse, sin optimizer/plans/cost model (`CF_BYPASS=1`).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-bypass.js   # → evals/reports/bypass-<TS>.json
```

| set | correctness | latencia | tokens |
|-----|-------------|----------|--------|
| trivial baseline | 1.000 | 162ms | 73 |
| trivial bypass | 1.000 | 152ms | 73 |
| T1 baseline | 1.000 | — | 104 |
| T1 bypass | 1.000 | — | 105 |

Verdict: **PASS** (correctness igual en ambos, latencia <= baseline, sin regresión). Matices: bypass_rate 0.17 (solo triviales de repos chicos; polar >500 files fuera por diseño); el objetivo <20ms no es alcanzable vía spawn CLI (floor de node ~40ms) — sí en modo daemon/MCP (cqs-style).


## Semantic-Structural Operator (CeQe) — SÍ SIRVE (dc-13 fijo)

Concept queries cuya implementación no tiene match léxico (dc-13: 'dependency injection' → app.module.ts encontrado por `@Module`) ahora resuelven: tras el plan, si el pool de un concept es mayoría-docs sin evidencia estructural, se escanean anclas de framework (`@Module`, `@Injectable`, `providers:`, `app.use`...) y se anexan los archivos con más anclas (solo implementación, docs excluidos).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-structural.js   # → evals/reports/structural-<TS>.json
```

| categoría | antes | después |
|-----------|-------|---------|
| deep-dependency-chain | 0.667 | **1.000** |
| vendor-code | 1.000 | 1.000 |
| T1 (32) | 1.000 | 1.000 |

Hallazgo de diseño: la evidencia del *concept* (docs con match léxico) no es evidencia de la *implementación* estructural — el gate correcto es "mayoría docs + 0 filas estructurales", no "pool vacío". Costo: +15 filas/ancla solo en el caso miss (raro); sin regresión en ninguna categoría.


## Evidence Packet Standard — SÍ SIRVE (representación)

Cada resultado de retrieval es un **packet tipado** `{evidence_id, subject{file,symbol,lines}, claim, evidence_type, certainty, source, provenance{operator,parser,index_version}, cost{tokens,latency_ms}}` (engine/evidence.js, aditivo sobre el contrato flat de fuse). La **certainty es tipo epistémico** (determinista tier0 = 1.0, estimación semantic = 0.6), ortogonal al score de ranking — el reranker interpreta evidencia, nunca la sobrescribe (el bug 0.0034 es estructuralmente imposible; el filtro de fuse opera sobre score, no sobre certainty).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-evidence-packets.js   # → evals/reports/evidence-packets-<TS>.json
```

Paridad T1: correctness 1.000 = 1.000 (aditivo), 214 packets con schema completa, tier0 certainty 1.0 ✓. Habilita selección por certeza/provenance en selector.js.


## Explorer-Solver Separation (FastContext) — SÍ SIRVE

El explorador (modo headless `CF_EXPLORER=1`) devuelve **evidence references** — `{path, lines:[start,end], reason, certainty}` + `next_actions: [{operator, target, eig}]` — no dumps de contenido. El solver recibe 59% menos tokens (2336 → 1100 media sobre 22 tasks downstream+adversarial) con correctness idéntica (0.955 = 0.955).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-explorer.js   # → evals/reports/explorer-<TS>.json
```

next_actions se derivan del belief state: agreement<0.5 → symbol-lookup (eig 0.7); relations sin reference → follow (0.5); inclusions sin test/config → read_span (0.4). El ahorro es el costo que el solver no paga en lectura temprana; los spans (`line_start/line_end` de la evidencia) habilitan el operador físico READ_SPAN del roadmap.


## Pairwise Runtime (A1) — PARITY, señal pre-ejecución inerte

CF_PAIRWISE=1 integra el modelo pairwise (Lero) en optimizer.js: score por plan = Σ P(plan ≻ otro) con features de las ops (est_tokens/latencia) y features post-hoc (gt_hits/exactness/n_results/recall5/mrr) = 0 pre-ejecución.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-pairwise-runtime.js   # → evals/reports/pairwise-runtime-<TS>.json
```

| selector | plan_acc | gt_hits | tokens | correctness |
|----------|----------|---------|--------|-------------|
| default | 0.906 | 4.406 | 105 | 1.000 |
| pairwise runtime | 0.906 | 4.406 | 105 | 1.000 |

Paridad exacta — sin regresión, pero el +19.5% gt del paso 08 (offline) NO se reproduce pre-ejecución: la señal vive en los features post-ejecución (gt_hits/exactness/n_results), que son 0 antes de correr. Conclusión: Lero no reemplaza la selección inicial; su valor es ADAPTAR tras observar la primera op → motor de re-selección en adaptive-query-execution (B8). CF_PAIRWISE queda disponible, default intacto.

## Read Span Operator (A2) — SÍ SIRVE

Operador físico `read-span` en engine.js: materializa SOLO el span (path + [line_start, line_end]) de un row de evidencia, no el archivo. COST_TABLE: 40 tokens / 2ms.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-read-span.js   # → evals/reports/read-span-<TS>.json
```

| métrica | valor |
|---------|-------|
| avg reduction (span vs archivo) | 0.505 |
| span_hit | 1.000 |
| correctness with_span | 1.000 (= baseline) |

Span [l-2, l+8] sobre la línea real del símbolo. Bugs de eval fijados (documentados en tasks.md): rows con line_start default 1 (rg-files/git-log) → resolver línea real; queries file/concept → hit a nivel archivo; regex multi-word sin comillas. Habilita references-en-vez-de-dumps (FastContext) y conecta con explorer next_actions + evidence packets.

## Fuse Flood Boost (A3) — REJECT parcial, root cause: dedup por path

CF_FLOOD_BOOST añade bonus a score_final para evidencia adquirida (structural/symbol-lookup/dependency-expand/read-span) en assemble-context.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-flood-boost.js   # → evals/reports/flood-boost-<TS>.json
```

| config | correct | gt | tokens |
|--------|---------|----|--------|
| baseline | 0.855 | 3.823 | 1572 |
| boost 0.2 | 0.855 | 3.839 | 1572 |
| adaptive | 0.855 | 3.823 | 1591 |
| adaptive+boost | 0.855 | 3.839 | 1591 |

Sin regresión (T1 1.000 en todas), pero adv-po-30 NO se rescata: el flood (coverage 1.0, n_pool 7309) dispara la adquisición, pero las filas adquiridas se dedupean por path contra el flood existente → no queda evidencia adquirida que boostear; el GT queda fuera del budget por tie-order de rg exact 0.86. Fix derivado: UPSERT por path en adquisición (reemplazar fila flood por la adquirida con mayor certeza/span) — para B8.

## Typed Rank Fusion (RRF) — B1

Fusión por RANGO multi-fuente con pesos por query-type (`CF_RRF=1` + `CF_RRF_RANK=1`): cada fuente (rg/bm25/structural/git/index) aporta un ranking y se combina Σ w_tier·1/(k+rank), dedupe a una fila por path.

| métrica | baseline | rrf |
|---------|----------|-----|
| correctness | 0.855 | **0.871** |
| mrr | 0.640 | 0.583 |
| tokens | 1572 | **933** (−41%) |

Veredicto: **FAIL por umbral, señal MIXTA** — gana cobertura (+1.6pp correctness) y reduce tokens 41% (dedupe por path), pero pierde precisión de rank (mrr −5.7pp). RRF sirve para paths diversity-first (fan-out/coverage), no para precision-first. Disponible opt-in, default intacto.


## Adaptive Context Budget (Adaptive-k) — B2, SÍ SIRVE (parity)

Selección con parada por diminishing returns: `CF_ADAPTIVE_K=1` + `CF_ADAPTIVE_K_THETA` (knee de la curva de marginal gain = θ·maxGain) integrado a `CF_SELECTOR=marginal` en engine/selector.js.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-adaptive-k.js   # → evals/reports/adaptive-k-<TS>.json
```

44 tasks (fanout + T1), budgets 2000/8000, θ sweep 0.05-0.20: **PASS — density adaptive 0.011105 = topk 0.011105, parity ✓**. Hallazgo: la curva de marginal gain no tiene rodilla en este corpus (top-k y adaptive-k idénticos en todo el sweep) — el knee solo corta en rankings con cola de baja ganancia (flood de ruido, p.ej. adv-po-30), no representado aquí. Sin regresión; el mecanismo queda disponible.


## Claim-Level Context (B3) — SÍ SIRVE

La unidad de contexto es el **claim** (span mínimo con evidencia), no el archivo completo. `CF_CLAIMS=1` materializa los resultados como `{claim_id, subject, text, evidence:[{path, lines}], evidence_type, certainty, source, cost}`.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-claim.js   # → evals/reports/claims-<TS>.json
```

44 tasks (T1 + fan-out): coverage **0.977 = 0.977** (parity), tokens 53681 → 25040 (**−58.6%**). Habilita evaluación line-level (SWE-Explore-style) y el op físico READ_SPAN para materializar solo lo necesario.

## Glossary

| Term | Meaning |
|---|---|
| **CQ** | Context Query — what the agent needs, as natural language or intent text (e.g. `--intent 'where is parseConfig defined?'`). |
| **CQP** | Context Query Plan — the structured logical representation the parser produces from a CQ (`FIND ... AND ... LIMIT ...`), consumed by the optimizer. |
| **AST** | Abstract Syntax Tree — the internal structured representation produced by the parser; boundary between query text and the planner. |
| **Logical plan** | Tool-agnostic description of what to retrieve: target, relations, inclusions, limit/budget. |
| **Physical retrieval plan** | The concrete ordered sequence of operators that will run (`search-code`, `search-structure`, `search-semantic`, `project-map`, `extract-context`). Candidates A/B/C per query type. |
| **Cost model** | `cost = w1·tokens + w2·latency + w3·tool_calls` with weights `CF_COST_1..3`; plan selection uses `utility = quality / cost`. |
| **Confidence** | How sure the heuristic interpreter is about the `query_type` classification of a query. |
| **Statistics** | Per `(operator, predicate_class)` aggregates — avg candidates, p95 tokens, latency, success rate — computed with ≥3 records, stored in `engine/statistics.ndjson`. |
| **Information density** | `useful_context_tokens / total_context_tokens` — the metric the engine optimizes. |
| **Wrong-context** | Retrieved context that does not match what the agent actually needs; the failure mode that fusion (dedup, ranking, budget) minimizes. |

---


## Naming: CQ / CQP

The engine distinguishes two levels, like SQL vs its plan:

```
Context Query (CQ)          → the agent's request text (declarative, `FIND ... AND ... LIMIT ...`)
Context Query Plan (CQP)    → structured logical representation produced by parseCQP
Physical Retrieval Plan     → optimizer output (ordered ops)
```

The query language is deliberately not called "CQL", which collides with third-party standards (ARROW/Europeana, MDPI "Context Definition and Query Language", USENIX).


## License

[MIT](LICENSE)

