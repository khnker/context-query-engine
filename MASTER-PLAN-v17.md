# Master Plan v1.7 — Ejecución autónoma

Plan superior con TODOS los changes pendientes. Cada item = change OpenSpec (creado o por crear) → implementar → validar (tests + eval) → archivar → commit → siguiente. Sin detenerse.

## Fase A — Integraciones runtime (consolidar hallazgos ADOPTED)

| id | change | qué | origen |
|----|--------|-----|--------|
| A1 | pairwise-runtime | CF_PAIRWISE en optimizer.js (modelo pairwise.json; gate presente + fallback default) | paso 08 PASS +19.5% gt |
| A2 | read-span-op | operador físico READ_SPAN sobre spans del explorer/evidence | explorer-solver -59% tokens |
| A3 | fuse-flood-boost | boost de prioridad a evidencia adquirida/estructural en score_final | adaptive REJECT (flood 35089 rows) |

## Fase B — Backlog v1.7 restante (16)

| id | change | foco |
|----|--------|------|
| B1 | typed-rank-fusion | RRF por tiers + pesos por query-type |
| B2 | adaptive-context-budget | adaptive-k, parada por marginal gain |
| B3 | claim-level-context | evidencia por claim, no por documento |
| B4 | execution-receipts | seen/inferred/unknown + evidencia→claim→acción→outcome |
| B5 | information-bottleneck-metrics | Δ task success / Δ token (no tokens ≤ B) |
| B6 | context-compilation-ir | repo IR → evidence IR → optimizer → LLM context |
| B7 | information-acquisition-voi | VoI = P(evidencia nueva)×utilidad − costo; ordenar/podar secuencia |
| B8 | adaptive-query-execution | replan mid-execution (LIP/AJA/APQO) |
| B9 | federated-evidence-sources | schema multi-plano (CODE/HISTORY/GIT/AST/LSP/TESTS/LOGS/DOCS) |
| B10 | external-agent-benchmarks | ContextBench explored-vs-used + ARB no-gold |
| B11 | repo-calibrated-cardinality | residual por repo (MAPE OOD < 2×heur) |
| B12 | learned-plan-steering | Bao hints sobre el modelo pairwise |
| B13 | evidence-semantics | Score<T> formal, provenance, eligibility |
| B14 | generated-code-default-policy | medir recall gain/noise/tokens antes de decidir |
| B15 | backlog-audit-v17 | governance: archivar superseded, elevar activos |
| B16 | cqe-thesis | paper/architecture doc con evidencia por claim |

## Reglas de ejecución
- Cada item: `openspec new change <id>` (si falta) → spec SHALL + tasks → implementar mínimo → eval/veredicto → `openspec validate` → `openspec archive <id> -y` → commit+push → `npm test` (TMPDIR=$PWD/.tmp) → siguiente
- README: sección por paso con veredicto (SÍ SIRVE / NO SIRVE + evidencia), ancla `## Glossary`
- Veredictos esperados de alta probabilidad de REJECT por señal (B11, B7) — data es data
- Estado actual en evals/reports/ + este plan

Última actualización: 2026-08-16 (Fase A en curso)
