# CQE Thesis — Adaptive Evidence Acquisition

**Context-Query Engine: retrieval as evidence acquisition and context optimization under uncertainty and resource constraints.**

Status: draft for review. All empirical claims cite artifacts in `evals/reports/*.json` and the archived OpenSpec change that produced them (`openspec/changes/archive/`).

---

## 1. Motivation

Language models consume context through a token budget. When the model must answer a question about a codebase it has never seen, every token spent on context is a token not spent on reasoning, and every retrieval operation is a latency and tool-call cost. The problem is not "find me all files that match" — it is *which subset of the codebase, retrieved through which operators, in which order, and under what confidence, maximizes the value of the downstream answer per token spent*.

Most retrieval pipelines treat this as a ranking problem: score candidates, take a budget, done. This project argues the problem is better framed as **adaptive evidence acquisition** — sequential, budgeted, uncertainty-aware gathering of typed evidence, where each retrieval operator is a *source* with known cost and confidence, and the pipeline plans acquisition, tracks what it knows, and stops when marginal value is exhausted.

## 2. Problem Statement (formal)

Given:

- a query `q` (CQP or natural language),
- a repository `R`,
- a set of evidence sources/operators `O = {search-code, search-structure, search-semantic, git, ...}` with cost `c(o)` and certainty `τ(o)`,
- a context budget `B` (tokens),
- a downstream consumer `M` (the agent).

Find a context set `C* ⊆ R`, acquired via an ordered plan `P ⊆ O`, such that:

```
C* = argmax_C  E[ utility(M(q, C)) ]   s.t.   tokens(C) ≤ B,  latency(P) ≤ L
```

The difficulty: `utility(M(q,C))` is unobservable at planning time. The system must work with **estimates** — evidence tiers, learned costs, agreement between sources — and decide (a) *whether to retrieve at all* (abstention), (b) *which operators to run in which order* (planning), (c) *how much to acquire* (adaptive budget), and (d) *what to keep* (selection).

## 3. Architecture

Three layers, each evaluated independently (see §4):

### 3.1 Evidence Model — typed evidence, not flat scores

Every retrieval result is an **evidence packet** (`engine/evidence.js`):

```
{evidence_id, subject:{file, symbol, lines}, claim, evidence_type, certainty,
 provenance:{operator, parser, index_version, query, tier},
 score_t:{evidence, estimate}, evidence_tier, cost:{tokens, latency_ms}}
```

Key design decisions, each empirically validated:

- **Score<T> namespaces** (B13): deterministic evidence (exact/filename/structural), probabilistic estimates (semantic/bm25), and costs never share a namespace. A probabilistic score can rank within its tier but cannot override deterministic evidence.
- **Certainty is epistemic** (`CERTAINTY` map): exact=1.0, structural=1.0, reference=0.8, semantic=0.6, test=0.4, config=0.3.
- **Eligibility by type, not by score**: tier-0 evidence (exact/filename/structural) is never dropped by a probabilistic filter.
- **Provenance survives selection**: every row that reaches the final context carries operator, query, and tier — traceability to the plan operation that produced it (B13).
- **Generated code excluded by default** (B14), marked `provenance.generated` when opted in — measured, not assumed.

### 3.2 Planning — VoI and adaptive execution

The optimizer (`engine/optimizer.js`) builds candidate plans per query class, costs them (`tokens = base + 0.05·est_candidates`, `utility = quality/cost`), and selects. Three steering mechanisms, all *advisory* over a deterministic baseline:

- **VoI (B7)**: `VoI(op) = P(new evidence | op, qc) · utility − cost` — prune operations whose expected information value does not pay for their cost. Empirically: parity with strict-budget baseline at zero pruning regret (B7).
- **Adaptive execution (B8)**: re-plan mid-run when realized costs diverge from estimates; loop with index-based iteration to guarantee termination.
- **Learned hints (B12)**: post-hoc ranking over candidate plans (Lero-style pairwise model) with a confidence threshold + Thompson sampling. Empirically inert pre-execution — no discriminative signal exists before runtime features materialize (B12 PARITY).

### 3.3 Selection — budgeted acquisition

`engine/selector.js` decides what the agent actually sees:

- **marginal**: `gain = score_final + TIER_BONUS[tier] + evidence_gain(0.15, first tier0/1) + dive_gain(0.15, diversity) − redundancy(0.1, |Δscore|<0.02) − token_cost/400`, with adaptive-k knee stop (θ=0.10) and tier-0 never pruned.
- **MMR**: `λ·score − (1−λ)·maxSim`, with hard tier-0 boost.

Fusion is **rank-based (RRF, B1)** with per-tier weights — signals do not share a scale, so fusing by rank instead of by score is strictly better.

## 4. Empirical Evidence by Claim

Every claim below is backed by an artifact and the archived change that produced it.

| # | Claim | Verdict | Artifact | Change (openspec/changes/archive/) |
|---|-------|---------|----------|-------------------------------------|
| C1 | Score fusion by rank (RRF, per-tier weights) beats shared-scale merging | SÍ SIRVE | `evals/reports/rrf-1786913284315.json` | `2026-08-16-typed-rank-fusion` |
| C2 | Tier-0 anchoring prevents probabilistic re-ranking from displacing deterministic hits | SÍ SIRVE | `evals/reports/rerank-stages-*.json` | `2026-08-16-reranker-fuse-alignment` |
| C3 | Adaptive budget (knee detection) keeps parity with strict budget while saving tokens | SÍ SIRVE (parity) | `evals/reports/adaptive-k-1786914133064.json` | `2026-08-16-adaptive-context-budget` |
| C4 | Claim-level retrieval cuts context tokens −58.6% without recall loss | SÍ SIRVE | `evals/reports/claims-1786914285035.json` | `2026-08-16-claim-level-context` |
| C5 | Execution receipts give per-claim provenance to outcomes | SÍ SIRVE | `evals/reports/receipts-1786914455210.json` | `2026-08-16-execution-receipts` |
| C6 | Information-bottleneck metrics are standard, comparable evidence quality metrics | SÍ SIRVE | `evals/reports/information-bottleneck-1786914983835.json` | `2026-08-16-information-bottleneck-metrics` |
| C7 | IR-style compilation pipeline (index → operators → context) is a valid representation | SÍ SIRVE | `evals/reports/ir-pipeline-1786915214585.json` | `2026-08-16-context-compilation-ir` |
| C8 | VoI pruning matches baseline outcomes at zero regret — mechanism works, no free win on this corpus | SÍ SIRVE (parity) | `evals/reports/voi-1786915803586.json` | `2026-08-16-information-acquisition-voi` |
| C9 | Federated evidence sources: 7 typed planes (lexical/symbol/dependency/callgraph/history/test/semantic) cover all query types with declared cost/latency/precision | SÍ SIRVE | `evals/reports/federated-1786922130619.json` | `2026-08-16-federated-evidence-sources` |
| C10 | External benchmarks: ContextBench explored-recall 0.75 / used-precision 0.67 (Δ+0.08); ARB calibration 1.000 (abstain rate 1.0) | PASS | `evals/reports/external-1786927703018.json` | `2026-08-17-external-agent-benchmarks` |
| C11 | Per-repo cardinality calibration improves in-distribution error (val 122.5%→74.1%) but fails out-of-distribution (339%) — heuristic stays default | NO SIRVE (OOD) | `evals/reports/calibrated-1786944190156.json` | `2026-08-17-repo-calibrated-cardinality` |
| C12 | Learned plan steering has no pre-execution signal: all overrides were tie-breaks between equivalent plans; runtime features are required | PARITY | `evals/reports/hint-1786945193112.json` | `2026-08-17-learned-plan-steering` |
| C13 | Typed Score<T> semantics (deterministic ≠ probabilistic ≠ cost) with full provenance holds through selection; 223/223 rows conform, tier-0 dropped 0 | PASS | `evals/reports/evidence-semantics-1786945805504.json` | `2026-08-17-evidence-semantics` |
| C14 | Generated code OFF by default is correct: ON adds nothing (single flag is inert), ON+no-ignore gains gc recall 0.667→1.000 at +30 tokens, zero control noise | OFF default | `evals/reports/generated-code-1786946396743.json` | `2026-08-17-generated-code-default-policy` |
| C15 | Pairwise plan preference (Lero) wins offline (+19.5% gt) but runtime selection is parity — post-hoc features are unavailable pre-execution | PARITY | `evals/reports/pairwise-runtime-1786912762842.json`, `evals/reports/pairwise-1786909565054.json` | `2026-08-16-pairwise-runtime`, `2026-08-16-pairwise-plan-preference` |
| C16 | Read-span operator reduces context footprint (reduction 0.505) | SÍ SIRVE | `evals/reports/read-span-1786912969432.json` | `2026-08-16-read-span-op` |
| C17 | Fuse flood boost is REJECT: boosting low-certainty floods causes noise; root cause is dedup by path, not boosting | REJECT | `evals/reports/flood-boost-1786913117433.json` | `2026-08-16-fuse-flood-boost` |
| C18 | Abstain via conformal calibration is REJECT (over-abstains); abstention remains decision-theoretic, not calibrated | REJECT | `evals/reports/abstain-conformal-1786907498812.json` | `2026-08-16-abstain-calibration`, `2026-08-15-abstain-no-answer` |
| C19 | MMR context selection (diversity) wins over marginal on downstream signal | SÍ SIRVE | `evals/reports/context-selection-1786891976441.json` | `2026-08-16-context-selection`, `2026-08-16-adaptive-context-budget` |
| C20 | Evidence packets are additive: packetized rows produce identical results to flat rows, with typed certainty | SÍ SIRVE | `evals/reports/evidence-packets-1786912152574.json` | `2026-08-16-evidence-packet-standard` |
| C21 | Physical query decomposition (fan-out) does not pay on this corpus | NO SIRVE | `evals/reports/decomposition-1786905266009.json` | `2026-08-16-physical-query-decomposition` |
| C22 | Quality-aware selection REJECT; operator cost model REJECT (estimation error dominates) | REJECT | `evals/reports/quality-policy-1786885237043.json`, `evals/reports/cost-model-1786905556437.json` | `2026-08-16-quality-aware-selection`, `2026-08-16-operator-cost-model` |
| C23 | Distribution shift (OOD): learned components fail OOD — robustness requires per-repo adaptation | FAIL | `evals/reports/distribution-shift-1786823428121.json`, `evals/reports/cost-model-ood-1786831688498.json` | `2026-08-15-distribution-shift-testing`, `2026-08-15-cost-model-ood` |

**Synthesis across 23 claims:** the mechanisms that survived are those that respect *evidence typing and provenance* (C1-C7, C9, C13, C14, C16, C19, C20). The mechanisms that failed or went parity are those that required *pre-execution prediction of downstream value* (C8 parity, C11 OOD, C12, C15, C17, C22) — the signal simply does not exist before runtime features materialize, and calibration does not transfer across repositories. This is the central empirical finding of the project: **invest in the evidence layer, not in predictive steering.**

## 5. Limitations

1. **Corpus scale**: T1 is 32 synthetic tasks over two small repos; T2 is one real repo (`polar`, 2,129 files). Statistical confidence on mechanism deltas is limited.
2. **No-gold evaluation** is thin: two datasets (ARB abstain; ContextBench explored-vs-used) cover external validity but not downstream answer quality at scale.
3. **Runtime-feature dependence**: every predictive mechanism (pairwise, hints, VoI, calibrated cost) is bounded by the absence of pre-execution signal; only *in-situ* re-planning (B8) exploits runtime data, and only partially.
4. **Abstention is unresolved**: conformal calibration over-abstains; decision-theoretic abstention lacks a calibrated utility model for the downstream agent.
5. **OOD transfer**: learned cardinality/cost components do not generalize across repos without per-repo retraining (C23).

## 6. Roadmap (post-v1.7)

Per the v1.7 audit (`2026-08-17-backlog-audit-v17`), the active roadmap is:

```
00 evidence-model → 01 query-ir → 02 physical-operators → 03 operator-cost-model
04 evidence-state → 05 adaptive-plan-selection → 06 context-selection
07 abstain/calibration → 08 learning
```

- The **evidence layer** (00-01) is the funded core: typed packets, provenance, rank fusion, index access paths.
- **Learning (08)** is explicitly an *implementation candidate* (e.g., TinyBERT), not architecture — every learned component must beat the robust heuristic on held-out + OOD before adoption.
- **Abstention (07)** remains open: needs a utility model of the downstream agent, not calibration of the retriever.

## 7. How to reproduce

```bash
TMPDIR="$PWD/.tmp" npm test            # 46/46 unit+integration
node evals/scripts/eval-<change>.js    # per-change eval → evals/reports/<change>-<ts>.json
bash evals/run-eval.sh --tier t1       # harness (4 modes)
```

Every report referenced in §4 is reproducible from the archived change's script; the artifacts are committed under `evals/reports/`.

## 8. Artifact Index

- Code: `engine/` (evidence, optimizer, selector, rrf, voi, ir, claims, receipts, federated, hint, index-layer).
- Eval scripts: `evals/scripts/eval-*.js`; datasets: `evals/datasets/` (tasks.json, adversarial.json, contextbench.json, arb.json, no-gold.json).
- Reports: `evals/reports/*.json`.
- Governance: `openspec/changes/archive/` (87 archived changes, one per experiment), specs in `openspec/specs/`.
