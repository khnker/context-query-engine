# agent-context-engineering-retrieval

## Contexto

Los agentes (OpenCode) gastan la mayor parte de la ventana de contexto en retrieval ineficiente: `cat .`, `node_modules`, resultados duplicados, búsquedas redundantes, semantic search donde basta exact search. **Objetivo:** maximizar `Information Density = useful context / total context tokens` manteniendo o aumentando la tasa de éxito.

**Referencias:** [Agent-Skills-for-Context-Engineering](https://github.com/muratcankoylan/agent-skills-for-context-engineering) (progressive disclosure, context optimization), [file-search-skill](https://github.com/netresearch/file-search-skill) (rg/fd/ast-grep/tokei), [Probe](https://github.com/probelabs/probe) (AST-aware, unidades semánticas completas, ranking, token budgets, dedup, LSP).

## Alcance

- [ ] Proyecto `contextforge`: motor con Context Query API + Query Interpreter + Logical Plan + Cost-Based Optimizer + Physical Plan + Result Fusion
- [ ] CQL declarativo: FIND/FOLLOW/INCLUDE/LIMIT/BUDGET (spec propia `context-query-language`)
- [ ] Skill `agent-context-engineering` como adaptador (SKILL.md + references/ + scripts/ + evals/)
- [ ] Retrieval Planner: árbol de decisión (fd/rg/ast-grep/semgrep/Probe/LSP/jq/yq)
- [ ] Context Broker: normalize → filter → deduplicate → rank → budget → order
- [ ] Cost model con telemetría: selectivity, precision, tokens/result, latency, success rate, cache hit rate → learned mappings
- [ ] MCP `context_query({intent, constraints})` como abstracción única
- [ ] Presupuestos configurables: 2000/8000/20000/30000
- [ ] Exclusiones default de bajo valor + configurables por proyecto
- [ ] Métricas de retrieval + benchmark contra baseline (find/grep/cat/git grep)
- [ ] Anti-patrones prohibidos en SKILL.md
- [ ] Acceptance test: "Find where model fallback is implemented..." en repo TS >50k LOC

## Especificación

- `specs/context-engineering/spec.md` — 18 requirements con scenarios (SHALL + WHEN/THEN)
- `specs/context-query-language/spec.md` — 3 requirements de gramática/semántica CQL
- `proposal.md` — why / what / capabilities
- `design.md` — 11 decisiones técnicas con alternativas + riesgos + migración + DB analogy + cost-based stats

## Herramientas

| Nivel | Herramientas |
|-------|--------------|
| Requeridas | rg, fd, jq, yq, ast-grep |
| Recomendadas | tokei, semgrep |
| Opcionales avanzadas | Probe, LSP, SCIP |

Tools faltantes NO bloquean la operación básica.

## Targets

```
≥ 30% reducción tokens de contexto irrelevantes
≥ 20% reducción llamadas de retrieval redundantes
≥ 20% reducción contexto duplicado
sin reducción estadística significativa de task success (ideal: aumento)
```
