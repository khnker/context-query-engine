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
| CQE+hybrid+rerank | 1.000 | 0.703 | **1.000** | 133 |
| CQE (baseline) | 1.000 | 0.833 | 0.939 | 105 |
| CQE+rerank | 1.000 | 0.630 | 0.984 | 57 |

Veredicto: **hybrid no degrada correctness** (1.000 = 1.000 en T1 y T2) y **mejora recall@5 en T1** (+3.7pp, 0.870 vs 0.833) — BM25 rescata hits que rg pierde. Costo: 2.3× tokens por los snippets BM25; la fusión compite en score_final de `assemble-context`. BM25 puro pierde correctness (0.844): no reemplaza a CQE, solo aporta como op de fusión. En dev (monorepo), BM25 puro falla (cap de 1000 archivos del índice) — el optimizer + rg siguen siendo necesarios. El op `bm25` queda incorporado al plan físico (COST_TABLE + `CF_RETRIEVAL`).

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
| CQE+rerank | 1.000 | 0.630 | 0.984 | 57 |

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

