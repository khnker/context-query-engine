# Experiments

Registro completo de experimentos del proyecto. Cada fila enlaza a la evidencia completa (metodología, métricas, veredicto, artifacts) en `docs/evidence/`.

> Veredictos: ✅ PASS/SIRVE · ⚠️ PARITY · ❌ NO SIRVE/REJECT/FAIL · ℹ️ medición/gobernanza/paper.

| Experimento | Status | Evidencia |
|---|---|---|
| Benchmark: context savings | ✅ PASS | [md](docs/evidence/benchmark-context-savings.md) |
| CQE vs hybrid retrieval | ✅ SIRVE | [md](docs/evidence/hybrid-retrieval.md) |
| Harder baselines | ✅ SIRVE | [md](docs/evidence/harder-baselines.md) |
| Downstream agent evaluation | ❌ FAIL | [md](docs/evidence/downstream-agent-eval.md) |
| ABSTAIN / No-Answer | ✅ PASS | [md](docs/evidence/abstain-no-answer.md) |
| Distribution shift (OOD) — FAIL | ❌ FAIL | [md](docs/evidence/distribution-shift-ood.md) |
| Adversarial workloads — FAIL parcial (8/10 categorías) | ❌ FAIL | [md](docs/evidence/adversarial-workloads.md) |
| Expected Utility Cost Model (REJECT) | ❌ REJECT | [md](docs/evidence/expected-utility-cost.md) |
| Cuándo NO usar context-query-engine | ✅ SIRVE | [md](docs/evidence/failure-modes.md) |
| Indexing cost & break-even | ℹ️ medicion - N_break_even < 1.3 | [md](docs/evidence/indexing-cost-breakeven.md) |
| Roadmap v1.8 (Index-Centric) | ℹ️ Formalizado: Catálogo → Index → Operadores Índice → Cost Model Index → Contexto Selección → Semántica → Adaptativo ML (refinamiento) | [md](docs/evidence/roadmap-v1-8.md) |
| Quality-aware selection (REJECT) | ❌ REJECT | [md](docs/evidence/quality-aware-selection.md) |
| Evidence Model + Context Selection (07A ADOPTED / 07B REJECT parcial) | ✅ ADOPTED | [md](docs/evidence/evidence-model-context-selection.md) |
| Retriever disagreement → active retrieval | ✅ SIRVE | [md](docs/evidence/retriever-disagreement.md) |
| Repository Index Layer | ✅ SIRVE | [md](docs/evidence/repository-index-layer.md) |
| Operator cost model (REJECT) | ❌ REJECT | [md](docs/evidence/operator-cost-model.md) |
| Evidence State (REJECT parcial) | ❌ REJECT | [md](docs/evidence/evidence-state.md) |
| Adaptive plan selection (REJECT) | ❌ REJECT | [md](docs/evidence/adaptive-plan-selection.md) |
| Context selection (MMR) — paso 06 | ✅ PASS | [md](docs/evidence/context-selection-mmr.md) |
| Abstain calibration (conformal) — REJECT | ❌ REJECT | [md](docs/evidence/abstain-conformal.md) |
| Context query IR (CF_INDEX=1) — PASSA | ✅ SIRVE | [md](docs/evidence/context-query-ir.md) |
| Physical query decomposition (CF_DECOMPOSE=1) — NO sirve (REJECT parcial) | ❌ NO SIRVE | [md](docs/evidence/physical-decomposition.md) |
| Pairwise plan preference (Lero) — paso 08, SÍ SIRVE | ✅ SIRVE | [md](docs/evidence/pairwise-plan-preference.md) |
| Repo fingerprint consistency (máxima transversal) | ✅ SIRVE | [md](docs/evidence/repo-fingerprint.md) |
| Cheap query bypass — SÍ SIRVE (parcial) | ✅ SIRVE | [md](docs/evidence/cheap-query-bypass.md) |
| Semantic-Structural Operator (CeQe) — SÍ SIRVE (dc-13 fijo) | ✅ SIRVE | [md](docs/evidence/semantic-structural-operator.md) |
| Evidence Packet Standard — SÍ SIRVE (representación) | ✅ SIRVE | [md](docs/evidence/evidence-packet-standard.md) |
| Explorer-Solver Separation (FastContext) — SÍ SIRVE | ✅ SIRVE | [md](docs/evidence/explorer-solver-separation.md) |
| Pairwise Runtime (A1) — PARITY, señal pre-ejecución inerte | ⚠️ PARITY | [md](docs/evidence/pairwise-runtime.md) |
| Read Span Operator (A2) — SÍ SIRVE | ✅ SIRVE | [md](docs/evidence/read-span-operator.md) |
| Fuse Flood Boost (A3) — REJECT parcial, root cause: dedup por path | ❌ REJECT | [md](docs/evidence/fuse-flood-boost.md) |
| Typed Rank Fusion (RRF) — B1 | ℹ️ mixta - -41% tokens, mrr -5.7pp | [md](docs/evidence/typed-rank-fusion.md) |
| Adaptive Context Budget (Adaptive-k) — B2, SÍ SIRVE (parity) | ✅ SIRVE | [md](docs/evidence/adaptive-context-budget.md) |
| Claim-Level Context (B3) — SÍ SIRVE | ✅ SIRVE | [md](docs/evidence/claim-level-context.md) |
| Execution Receipts (B4) — SÍ SIRVE | ✅ SIRVE | [md](docs/evidence/execution-receipts.md) |
| Information Bottleneck Metrics (B5) — SÍ SIRVE (métrica estándar) | ✅ SIRVE | [md](docs/evidence/info-bottleneck-metrics.md) |
| Context Compilation / IR (B6) — SÍ SIRVE (representación) | ✅ SIRVE | [md](docs/evidence/context-compilation-ir.md) |
| Information Acquisition / VoI (B7) — SÍ SIRVE (mecanismo, parity) | ✅ SIRVE | [md](docs/evidence/information-acquisition-voi.md) |
| Federated Evidence Sources (B9) — SÍ SIRVE (representación) | ✅ SIRVE | [md](docs/evidence/federated-evidence-sources.md) |
| Repo-Calibrated Cardinality (B11) — NO SIRVE (OOD dev) | ❌ NO SIRVE | [md](docs/evidence/repo-calibrated-cardinality.md) |
| Learned Plan Steering (B12) — PARITY (sin señal pre-ejecución) | ⚠️ PARITY | [md](docs/evidence/learned-plan-steering.md) |
| Evidence Semantics (B13) — SÍ SIRVE (contrato tipado Score<T>) | ✅ SIRVE | [md](docs/evidence/evidence-semantics.md) |
| Generated Code Default Policy (B14) — OFF default (medición empírica) | ✅ SIRVE | [md](docs/evidence/generated-code-policy.md) |
| Backlog Audit v1.7 (B15) — inventario y archivo de superseded | ℹ️ gobernanza - 28 archivados | [md](docs/evidence/backlog-audit.md) |
| CQE Thesis (B16) — paper/architecture doc | ℹ️ paper - 23 claims con artifact | [md](docs/evidence/cqe-thesis.md) |
| Soundex Fallback (B17) — SÍ SIRVE (typos) | ✅ SIRVE | [md](docs/evidence/soundex-fallback.md) |


## Reproducibilidad

Cada experimento referencia el script de eval y el artefacto `evals/reports/<change>-<TS>.json`. Correr:

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-<cambio>.js   # -> evals/reports/<cambio>-<TS>.json
```

Suite completa de tests: `TMPDIR=$PWD/.tmp npm test` (50/50).
