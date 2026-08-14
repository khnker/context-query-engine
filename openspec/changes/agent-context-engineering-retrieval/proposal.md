## Why

Los agentes gastan la mayor parte de su ventana de contexto en retrieval ineficiente: `cat .`, lectura de `node_modules`, resultados duplicados y búsquedas redundantes. Cada MCP/CLI es un acceso de bajo nivel equivalente a `SELECT * FROM filesystem WHERE ...` sin optimizer. El objetivo es maximizar `Information Density = useful context / total context tokens` manteniendo o aumentando la tasa de éxito. La solución es un **query optimizer y execution engine para el contexto del agente** — ContextForge — que planifica, optimiza y materializa retrieval, no una skill que enseña comandos.

## What Changes

- **Nuevo proyecto `contextforge`** con tres componentes centrales:
  - **Context Query Language (CQL)**: query lógica declarativa (FIND/FOLLOW/INCLUDE/BUDGET) que el agente emite sin decidir herramientas.
  - **Context Optimizer**: cost-based optimizer que elige entre planes físicos alternativos (tokens + latencia + tool calls + relevancia estimada) y aprende de telemetría histórica.
  - **Context Execution Engine**: ejecuta el plan físico (rg/AST/LSP/Probe/Git) y fusiona resultados (dedup + rank + budget).
- **Context Query API**: el agente invoca `context_query({intent, constraints})` en vez de encadenar `search_files`/`read_file`/`rg` manualmente.
- **Query Interpreter**: traduce lenguaje natural / intención a plan lógico (`query_type`, `confidence`), clasificación opcionalmente asistida por modelo ligero (TinyBERT) pero nunca como optimizer completo.
- **Logical Context Plan → Physical Retrieval Plan**: el agente no ejecuta `rg fallback .`; ContextForge produce y evalúa planes (ej: Plan A rg global 300 matches vs Plan B rg en `src/` + ast-grep + LSP references + tests), seleccionando por costo estimado.
- **Skill como adaptador**: la skill `agent-context-engineering` enseña al agente a usar ContextForge; las CLIs pasan a ser physical operators.
- **Retrieval telemetry**: estadísticas por query type / tool / plan (success rate, latencia, tokens) que alimentan el cost model.
- **Presupuestos configurables**: `initial 2000 / standard 8000 / deep 20000 / hard 30000` con early termination.
- **Exclusiones default** de bajo valor, configurables por proyecto.
- **Benchmark** contra baseline naive (`find`/`grep`/`cat`/`git grep`) y contra `fd`/`rg`/`ast-grep`/Probe/LSP directos.
- **Anti-patrones prohibidos**: `cat .`, lockfiles/node_modules/generados/logs completos, búsquedas repetidas, semantic search cuando basta exact search.

## Capabilities

### New Capabilities

- `context-engineering`: estrategia operativa de retrieval — Context Query API, interpretación de intención, planificación lógica, optimización cost-based, ejecución física, fusión de resultados, presupuestos, telemetría y evaluación.
- `context-query-language`: gramática y semántica del CQL (FIND/FOLLOW/INCLUDE/BUDGET, relations, constraints).

### Modified Capabilities

- (none — capability nueva, no existen specs previas en este proyecto)

## Impact

- **Nuevo proyecto**: `/home/nicolas/dev/contextforge` (motor CQL + optimizer + execution engine + skill adaptadora + scripts + evals).
- **MCP**: nueva operación `context_query()` como abstracción de retrieval complejo (no wrapper shell uno-a-uno). MCP tradicional (search_files/read_file) queda como escape de bajo nivel.
- **Dependencias del sistema**: `ripgrep`, `fd-find`, `jq`, `yq`, `ast-grep` (requeridas); `tokei`, `semgrep`, `Probe`, LSP (opcionales). Tools faltantes no bloquean la operación básica.
- **Clasificador de intención**: opcional (TinyBERT o similar) para `query_type`/`confidence`; el optimizer NO depende de él.
- **No afecta**: specs, APIs ni servicios existentes del workspace.
