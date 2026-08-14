## 1. Baseline — Skill Structure

- [x] 1.1 Crear proyecto `contextforge` con estructura `agent-context-engineering/{SKILL.md,references/,scripts/,evals/}`
- [x] 1.2 Escribir `SKILL.md` con: criterios de activación, árbol de decisión de retrieval, reglas de escalación, reglas de presupuesto de tokens, comportamientos ineficientes prohibidos
- [x] 1.3 Crear `references/retrieval-policy.md` (policy inicial: identifier→rg, filename→fd, pattern→ast-grep, symbol→LSP, subsystem→Probe, else→recon→lexical→structural; registrar estrategia seleccionada)
- [x] 1.4 Crear `references/tool-selection.md` (árbol de decisión completo con semgrep/jq/yq)
- [x] 1.5 Crear `references/context-budget.md` (presupuestos default 2000/8000/20000/30000 + reglas de aumento/decremento/terminación temprana)
- [x] 1.6 Crear `references/context-deduplication.md` (dedup de sesión: resultados repetidos, búsquedas idénticas)
- [x] 1.7 Crear `references/semantic-retrieval.md` (Probe: AST-aware, unidades semánticas, ranking, presupuestos; LSP: definiciones/referencias/call hierarchy)
- [x] 1.8 Crear `references/filesystem-context.md` (fd/rg/git ls-files, exclusiones, project map)
- [x] 1.9 Crear `references/evaluation.md` (métricas, benchmark, información density)

## 2. Linux Toolchain

- [x] 2.1 Documentar instalación Fedora: `sudo dnf install ripgrep fd-find jq yq fzf tokei`
- [x] 2.2 Documentar instalación ast-grep vía mecanismo soportado del proyecto
- [x] 2.3 Documentar instalación Probe: `npm install -g @probelabs/probe` o installer Linux
- [x] 2.4 Script de verificación de disponibilidad: `command -v rg fd jq yq sg tokei probe` (tools faltantes no bloquean operación básica)

## 3. Retrieval Wrappers

- [x] 3.1 Implementar `scripts/project-map` (reconocimiento de shape del repo con bajo costo de tokens)
- [x] 3.2 Implementar `scripts/search-code` (wrapper rg con exclusiones default)
- [x] 3.3 Implementar `scripts/search-structure` (wrapper ast-grep)
- [x] 3.4 Implementar `scripts/extract-context` (extracción de unidad semántica completa desde path+line range)
- [x] 3.5 Implementar `scripts/inspect-json` (jq helper)
- [x] 3.6 Implementar `scripts/retrieval-metrics` (registro y reporte de métricas por tarea)

## 4. Context Assembly

- [x] 4.1 Definir schema normalizado de resultado de retrieval: source, path, symbol, language, line_start, line_end, match_type, score, token_estimate, reason
- [x] 4.2 Implementar pipeline normalize → filter → deduplicate → rank → budget → order
- [x] 4.3 Implementar ranking multi-factor: exactness, relevancia estructural/símbolo/path, relación tests/config, recencia, duplicación, costo tokens
- [x] 4.4 Implementar presupuesto con retención de candidatos de mayor valor (scenario Multiple candidates)
- [x] 4.5 Implementar ordering de contexto: constraints de tarea → evidencia alta confianza → soporte → baja confianza → decisión actual

## 5. Semantic Retrieval

- [x] 5.1 Integrar Probe (semantic search, unidades completas, token budgeting, deduplicación)
- [x] 5.2 Definir política de escalación LSP/Probe (nivel 4/5 del default policy)
- [x] 5.3 Implementar exclusión de paths de bajo valor (defaults + configurables por proyecto)

## 6. Evaluation

- [x] 6.1 Construir corpus de tareas de codificación representativas (benchmark.md + retrieval.json)
- [x] 6.2 Definir criterios de éxito por tarea: files/tool calls/raw tokens/dedup tokens/final context/latency/correctness
- [x] 6.3 Implementar comparación A. semantic (fd+rg+ast-grep+Probe/LSP) vs baseline (find/grep/cat/git grep)
- [x] 6.4 Registrar métricas por tarea: total tokens, useful tokens, duplicate tokens, tool calls, latency, retrieval precision, retrieval recall, task success
- [x] 6.5 Validar targets: ≥30% menos tokens irrelevantes, ≥20% menos llamadas redundantes, ≥20% menos duplicados, sin reducción significativa de task success

## 7. OpenCode Integration

- [x] 7.1 Instalar skill en OpenCode (`~/.config/opencode/skills/agent-context-engineering/`)
- [x] 7.2 Verificar activación y árbol de decisión con tarea de prueba

## 8. Optimization

- [x] 8.1 Identificar patrones de retrieval con mayor información density de los evals
- [x] 8.2 Ajustar presupuestos y orden de escalación según evidencia empírica

## 9. Acceptance Test

- [x] 9.1 Ejecutar acceptance test en repo typeScript del proyecto contextforge (engine/ + scripts/ + agent-context-engineering/), con tests/generados/node_modules: "Find where the query interpreter classifies intents and explain what happens when confidence is low"
- [x] 9.2 Verificar secuencia esperada: project-map → search-code/interpreter → cql parse → optimizer → ejecución plan → fusión → contexto acotado → respuesta
- [x] 9.3 Verificar que el agente NO lea el repositorio inicialmente (sin `cat .` / lecturas completas)
- [x] 9.4 Registrar: files inspected, tool calls, raw tokens, deduplicated tokens, final context tokens, latency, correctness

## 10. Context Query Language

- [x] 10.1 Definir gramática CQL: FIND/FOLLOW/INCLUDE/LIMIT/BUDGET + ejemplo `FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000`
- [x] 10.2 Implementar parser CQL → logical query plan (query_type, target, concept, relations, inclusions, constraints)
- [x] 10.3 Documentar semántica: candidatos ranked, empty results con reporte del query type fallido

## 11. Query Interpreter

- [x] 11.1 Implementar heurísticas de clasificación de intención → query_type + confidence (sin dependencia de ML)
- [x] 11.2 Evaluar clasificador opcional (TinyBERT) para query_type — mejora opcional, no bloqueante

## 12. Cost-Based Optimizer

- [x] 12.1 Implementar generación de planes físicos candidatos (A rg global / B rg scope + ast-grep + LSP / C Probe + LSP)
- [x] 12.2 Implementar cost model: `w1*tokens + w2*latency + w3*tool_calls − w4*relevance` con pesos ajustables
- [x] 12.3 Implementar selección de plan por menor costo estimado
- [x] 12.4 Implementar registro de telemetría por query type y tool (selectivity, precision, tokens/result, latency, success rate, cache hit rate)
- [x] 12.5 Implementar learned mappings: estadísticas sobreescriben policy default tras evidencia suficiente

## 13. Execution Engine + Result Fusion

- [x] 13.1 Implementar ejecución de plan físico ordenado con early termination
- [x] 13.2 Implementar fusión: dedup cross-tool + ranking multi-factor + enforce budget
- [x] 13.3 Implementar MCP `context_query({intent, constraints})` con search_files/read_file como escape bajo nivel
- [x] 13.4 Implementar retrieval cache intra-sesión (cache hit rate en telemetría)
