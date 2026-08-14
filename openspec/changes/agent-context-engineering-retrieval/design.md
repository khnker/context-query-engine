## Context

OpenCode y los agentes del workspace incurren en retrieval ineficiente: herramientas caras para búsquedas deterministas, contexto duplicado, presupuestos ausentes. La colección `Agent-Skills-for-Context-Engineering` aporta los principios de progressive disclosure, context optimization y tool design; `file-search-skill` demuestra el patrón CLI-based (rg/fd/ast-grep/tokei); Probe agrega búsqueda AST-aware, extracción de unidades semánticas completas, ranking, presupuestos de tokens, deduplicación y capacidades LSP. ContextForge eleva la propuesta de skill a **motor**: Context Query Language + Cost-Based Optimizer + Execution Engine, donde la skill pasa a ser el adaptador que enseña al agente a usar el motor.

El análisis competitivo confirma el hueco: **Probe** cubre ejecución (semantic + FTS + reranking + focused context), **Open Aware** cubre capa semántica vía MCP, **engram** intercepta lecturas y devuelve contexto comprimido, **ContextOS** hace orquestación/routing amplio, y las **Agent Skills** (filesystem-context) aportan política de contexto. Ninguno construye de forma independiente el par *logical query plan + cost-based optimizer* sobre physical operators locales (rg/AST/LSP/Probe/Git) con telemetría de ejecución. ContextForge apunta a ese hueco.

## Goals / Non-Goals

**Goals:**
- Skill `agent-context-engineering` instalable con estructura SKILL.md + references + scripts + evals.
- Retrieval Planner con árbol de decisión explícito sobre primitivas locales.
- Context Broker: normalize → filter → deduplicate → rank → budget → order.
- Presupuestos configurables (2000/8000/20000/30000) con early termination.
- Métricas de retrieval + benchmark contra baseline naive.
- Context Query API (`context_query({intent, constraints})`) como abstracción única de retrieval complejo.
- Query Interpreter: intención → plan lógico (query_type + confidence), sin depender de un clasificador.
- Cost-Based Optimizer: estimar costo (tokens + latencia + tool calls + relevancia) y seleccionar plan físico entre alternativas.
- Telemetría de ejecución que alimenta el cost model (tool selectivity, precision, tokens/result, latency, success rate, cache hit rate).
- Context Query API (`context_query({intent, constraints})`) como abstracción única de retrieval complejo.
- Query Interpreter: intención → plan lógico (query_type + confidence), sin depender de un clasificador ML.
- Cost-Based Optimizer: estimar costo (tokens + latencia + tool calls + relevancia) y seleccionar plan físico entre alternativas.
- Telemetría de ejecución que alimenta el cost model (tool selectivity, precision, tokens/result, latency, success rate, cache hit rate).
- Objetivos de ingeniería: ≥30% menos tokens irrelevantes, ≥20% menos llamadas redundantes, ≥20% menos contexto duplicado, sin reducción estadística significativa de task success.

**Non-Goals:**
- Motor semántico propio (se delega a Probe/LSP).
- Cliente LSP desde cero (se consume vía Probe o MCP cuando exista).
- Indexación persistente propia (queda como futura investigación).
- Orquestación general de agentes (tipo ContextOS): ContextForge solo planifica retrieval de contexto, no el flujo del agente.
- Clasificador de intención obligatorio: el Query Interpreter funciona con heurísticas; TinyBERT o similar es mejora opcional, nunca el optimizer completo.
- Motor de embeddings propio: se delega a Probe.
- Optimización cross-model de la policy (futura investigación, el broker solo registra métricas por ahora).

## Decisions

**D1 — CLI locales como primitivas deterministas; MCP solo para semántica compleja.**
rg/fd/ast-grep/jq/yq/git/tokei quedan como CLIs locales. MCP es optimización opcional para LSP, índices persistentes, grafos semánticos y relaciones cross-file. Las operaciones expuestas por MCP (`search_code`, `search_structure`, `extract_context`, `find_definition`, `find_references`, `call_hierarchy`, `project_map`) abstraen comportamiento de retrieval complejo, no envuelven comandos shell uno-a-uno.
*Alternativa:* MCP para todo — descartada: agrega latencia y dependencia de infraestructura sin ganancia para retrieval determinista.

**D2 — Probe como motor semántico.**
Combina velocidad tipo ripgrep, parsing Tree-sitter, semantic search, extracción de unidades de código completas, token budgeting y deduplicación en una sola herramienta. Instalación global `npm install -g @probelabs/probe` o installer Linux. Los tools faltantes no bloquean la operación básica.
*Alternativa:* LSP puro — descartado como default: más pesado, requiere servidor por lenguaje; queda en nivel 5 de escalación.

**D3 — Escalación en niveles con early exit.**
Policy default: Level 0 project map → 1 fd → 2 rg → 3 ast-grep → 4 Probe → 5 LSP → 6 tests/git history/runtime. Evidencia suficiente en un nivel temprano → no se invocan niveles profundos.
*Alternativa:* todo-en-uno — descartada: quema presupuesto sin necesidad.

**D4 — Presupuestos de tokens por defecto, configurables por proyecto.**
`initial 2000 / standard 8000 / deep 20000 / hard_limit 30000`. Preferir *retrieval adicional con presupuesto mayor* sobre dumping del repo completo.
*Alternativa:* presupuesto único — descartada: no distingue reconocimiento vs análisis profundo.

**D5 — Ensamblado con preferencia de unidad semántica completa.**
El ensamblador prefiere `unidad semántica completa > unidad parcial > líneas crudas` cuando todas caben en presupuesto. Orden de contexto deliberado: constraints de la tarea → evidencia de alta confianza → evidencia de soporte → evidencia de baja confianza → pregunta/decisión actual.
*Alternativa:* orden por relevancia cruda — descartada: entierra constraints críticas en mitad del contexto.

**D6 — Ranking multi-factor.**
Exactness, relevancia estructural, relevancia de símbolo, relevancia de path, relación con tests, relación con config, recencia, duplicación y costo de tokens. Cuando hay más candidatos que presupuesto → se retienen los de mayor valor.
*Alternativa:* orden por relevancia cruda — descartada: entierra constraints críticas en mitad del contexto.

**D7 — CQL como query lógica declarativa.**
El agente emite una query lógica (`FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000`) sin elegir herramientas. La gramática (FIND/FOLLOW/INCLUDE/LIMIT/BUDGET) es independiente de los physical operators.
*Alternativa:* el agente encadena tools a mano — descartada: el optimizer debe decidir, no el agente.

**D8 — Cost-Based Optimizer.**
El optimizer genera N planes físicos candidatos (ej: A rg global 300 matches / B rg en `src/` 32 matches + ast-grep + LSP references + tests / C Probe semantic + LSP) y selecciona por función de costo estimado: `cost = w1*tokens + w2*latency + w3*tool_calls − w4*estimated_relevance`, con pesos ajustables desde telemetría.
*Alternativa:* plan fijo único — descartada: no aprovecha estadísticas ni se adapta al repo.

**D9 — Aprendizaje por estadísticas de ejecución.**
Se registran por query type y por tool: selectivity, precision, tokens por resultado, latencia, success rate, cache hit rate. El optimizer aprende mappings empíricos (`implementation_lookup → LSP`, `exact_error → rg`, `subsystem → Probe`, `pattern → AST`, `behavior_change → Git+LSP`) tras suficiente evidencia, y las estadísticas sobreescriben la policy default.
*Alternativa:* mappings hardcodeados — descartada: envejecen; la telemetría es la fuente de verdad.

**D10 — MCP `context_query()` como abstracción única.**
El MCP expone `context_query({intent, constraints})`; `search_files`/`read_file` quedan como escape de bajo nivel. El plan físico y la fusión viven en el execution engine.
*Alternativa:* MCP uno-a-uno por tool — descartada: replica el problema de `SELECT *` sin optimizer.

**D11 — Skill como adaptador, no como motor.**
La skill enseña cuándo y cómo emitir CQL/`context_query`; la lógica (interpretación, planes, costos, fusión) vive en el motor ContextForge. La skill NO reimplementa el pipeline.

**D7 — CQL como query lógica declarativa.**
El agente emite una query lógica (FIND target/concept, FOLLOW relations, INCLUDE tests/config/docs, LIMIT tokens/files/latency) sin elegir herramientas. La gramática es independiente de los physical operators; el optimizer decide la ejecución.
*Alternativa:* el agente encadena tools a mano — descartada: el objetivo es que el optimizer decida, no el agente.

**D8 — Cost-Based Optimizer.**
El optimizer genera N planes físicos candidatos (ej: A rg global; B rg en scope + ast-grep + LSP references; C Probe semantic + LSP) y selecciona por función de costo `cost = w1*tokens + w2*latency + w3*tool_calls − w4*estimated_relevance`. Pesos ajustables con telemetría.
*Alternativa:* plan fijo único — descartada: no aprovecha estadísticas ni se adapta al repo.

**D9 — Aprendizaje por estadísticas de ejecución.**
Se registran por query type y por tool: selectivity, precision, tokens/result, latencia, success rate, cache hit rate. El optimizer aprende mappings empíricos (implementation_lookup → LSP, exact_error → rg, subsystem → Probe, pattern → AST, behavior_change → Git+LSP) cuando la evidencia es suficiente; la estadística sobreescribe la policy default.
*Alternativa:* mappings hardcodeados — descartada: envejecen; la telemetría es la fuente de verdad.

**D10 — MCP `context_query()` como abstracción única.**
El MCP expone `context_query({intent, constraints})`; search_files/read_file quedan como escape de bajo nivel. Plan físico y fusión viven en el execution engine.
*Alternativa:* MCP uno-a-uno por tool — descartada: replica el problema de `SELECT *` sin optimizer.

**D11 — Skill como adaptador, no como motor.**
La skill enseña cuándo y cómo emitir CQL/`context_query`; la lógica (interpretación, planes, costos, fusión) vive en el motor. La skill NO reimplementa el pipeline.

## Risks / Trade-offs

- [R1] Probe/LSP no instalados → Mitigación: verificación de disponibilidad al init; la skill opera solo con fd/rg/ast-grep.
- [R2] Exclusiones default muy agresivas ocultan código relevante → Mitigación: lista configurable por proyecto; nivel 6 (git history/runtime) como escape.
- [R3] Ranking heurístico subóptimo (budgets son heurísticas, no garantías) → Mitigación: métricas por tarea habilitan optimización empírica posterior.
- [R4] Presupuesto `hard_limit` corta evidencia necesaria → Mitigación: early termination + retrieval adicional escalonado en vez de límites duros silenciosos.
- [R5] `cat .` sigue siendo posible en agentes que no sigan la skill → Mitigación: anti-patrones listados explícitamente en SKILL.md.

## DB Analogy

| Base de datos      | ContextForge                  |
| ------------------ | ----------------------------- |
| SQL                | Context Query (CQL)           |
| Query parser       | Query Interpreter             |
| Logical plan       | Logical Context Plan          |
| Query optimizer    | Retrieval Optimizer (cost-based) |
| Physical plan      | Tool Execution Plan           |
| Table scan         | filesystem scan (fd/rg)       |
| Index              | AST/LSP/semantic index (Probe)|
| Predicate pushdown | limitar retrieval temprano    |
| Projection         | `jq` / extracción de campos   |
| Join               | combinar símbolos/files/tests |
| Query cost         | tokens + latency + tool calls |
| Result set         | Context set                   |
| Buffer/cache       | retrieval cache               |
| Cardinality        | candidatos/resultados         |
| Statistics         | retrieval telemetry           |
| Execution plan     | retrieval plan                |

## Cost-Based Optimizer Statistics

La DB usa cardinalidad/selectividad/costo de índice/join. ContextForge aprende: `tool selectivity`, `retrieval precision`, `tokens per result`, `latency`, `success rate`, `cache hit rate`. Mappings empíricos esperados tras ~10.000 consultas:

```
"find implementation"        → LSP
"find exact error"           → rg
"understand subsystem"       → Probe
"find structural pattern"    → AST
"find why behavior changed"  → Git + LSP
```

El optimizer estima por plan `estimated_cost` / `estimated_latency` / `estimated_relevance` y selecciona el ganador (ej: Plan B sobre Plan A si `300 matches → 32 matches`).

## Migration Plan

1. Instalar dependencias del sistema (Fedora: `sudo dnf install ripgrep fd-find jq yq fzf tokei`; ast-grep vía mecanismo del proyecto; Probe opcional global).
2. Copiar skill a `~/.config/opencode/skills/agent-context-engineering/`.
3. Verificar `command -v rg fd jq yq sg tokei probe`.
4. Rollback: remover el directorio de la skill; las CLIs son herramientas del sistema, no cambian el comportamiento existente.

## DB Analogy

| Base de datos            | ContextForge                       |
| ------------------------ | ---------------------------------- |
| SQL                      | Context Query (CQL)                |
| Query parser             | Query Interpreter                  |
| Logical plan             | Logical Context Plan               |
| Query optimizer          | Retrieval Optimizer (cost-based)   |
| Physical plan            | Tool Execution Plan                |
| Table scan               | filesystem scan (fd/rg)            |
| Index                    | AST/LSP/semantic index (Probe)     |
| Predicate pushdown       | limitar retrieval temprano         |
| Projection               | `jq` / extracción de campos        |
| Join                     | combinar símbolos/files/tests      |
| Query cost               | tokens + latency + tool calls      |
| Result set               | Context set                        |
| Buffer/cache             | retrieval cache                    |
| Cardinality              | candidatos/resultados              |
| Statistics               | retrieval telemetry                |
| Execution plan           | retrieval plan                     |

## Cost-Based Optimizer Statistics

La DB usa cardinalidad/selectividad/costo de índice/join. ContextForge aprende de la ejecución:

```
tool selectivity
retrieval precision
tokens per result
latency
success rate
cache hit rate
```

Mappings empíricos esperados tras ~10.000 consultas:

```
"find implementation"         → LSP
"find exact error"            → rg
"understand subsystem"        → Probe
"find structural pattern"     → AST
"find why behavior changed"   → Git + LSP
```

El optimizer estima por plan: `estimated_cost`, `estimated_latency`, `estimated_relevance` y selecciona el ganador (ej: Plan B sobre Plan A cuando `300 matches → 32 matches` con LSP references acotadas).

## Open Questions

- ¿ast-grep se instala por gestor del proyecto (cargo/npm) o binario standalone?
- ¿Probe se incluye como dependencia opcional del skill o se documenta solo?
- ¿El proyecto `contextforge` necesita repo git propio o vive bajo el monorepo del workspace?
- ¿MCP server del broker se construye en este change o queda como futura investigación?
- ¿El Query Interpreter usa un clasificador (TinyBERT) en v1 o heurísticas puras?
- ¿El retrieval cache persiste entre sesiones (disco) o es solo intra-sesión?
- ¿El Query Interpreter usa un clasificador (TinyBERT) en v1 o heurísticas puras?
- ¿El retrieval cache persiste entre sesiones (disco) o es solo intra-sesión?
