# Benchmark de Retrieval — Grupo 6 (Evaluation)

Corpus + runner + analyzer del skill de retrieval (context-engineering) vs baseline naive (`find`/`grep`/`cat`).
Referencias: `references/evaluation.md`, `references/retrieval-metrics.md` (spec `context-engineering`: Benchmarking, Retrieval Metrics).
Ejecutables: `evals/retrieval.json` (corpus), `evals/run-benchmark` (runner 6.3/6.4), `evals/analyze` (validator 6.5).

## Corpus (6.1) — 10 tareas

| # | tarea (pregunta de retrieval real) | query type | files esperados (glob) | success criteria (qué debe encontrar) |
|---|-----------------------------------|------------|------------------------|----------------------------------------|
| 1 | ¿Dónde está definida la función `parseConfig`? Reportar `archivo:línea` de la definición y sus usos. | identifier | `*` | Definición (o símbolo más cercano, fallback `token`) con archivo:línea; ≥1 archivo con el símbolo |
| 2 | ¿Dónde se usa la constante `METRICS_FILE` y qué valor tiene? | identifier | `scripts/*` | Uso de la constante en `scripts/retrieval-metrics` (definición en línea 17) |
| 3 | Encontrar el archivo de configuración de exclusiones del repo y listar sus exclusiones por defecto. | filename | `*exclusions*` | `agent-context-engineering/config/exclusions.json` |
| 4 | Encontrar los archivos spec del cambio `agent-context-engineering-retrieval`. | filename | `openspec/changes/*` | `openspec/changes/agent-context-engineering-retrieval/{design,tasks,proposal}.md` |
| 5 | Buscar el patrón estructural null-guard (`if [ -z ... ]`) en los scripts. | pattern | `scripts/*` | `scripts/retrieval-metrics:19` (`if [ -z "$cmd" ]`) |
| 6 | Encontrar el manejo de error/fallback (try/catch) de la función `probe` en `search-semantic`. | pattern | `scripts/search-semantic` | `scripts/search-semantic:38` (`if ! OUTPUT="$(probe ...)"`) |
| 7 | Encontrar la definición del comando `report` del script de métricas y todas sus referencias. | symbol | `scripts/retrieval-metrics` | Definición (`report)`) + referencias (`report TASK`) |
| 8 | Construir la call hierarchy del helper `tok()` (estimación de tokens): dónde se define y quién lo llama. | symbol | `evals/*` | Definición en `evals/run-benchmark` + llamadores (`run_via`) |
| 9 | Identificar el subsystem de retry/fallback del repo: degradación de herramientas cuando fallan. | concept | `*` | Archivos con lógica de fallback/degradación (`scripts/search-code`, `scripts/search-semantic`) |
| 10 | Describir el shape general del repo: directorios, lenguajes y tamaño (archivos/LOC). | repo_map | `*` | Salida de shape: root, dirs, lenguajes, conteo de archivos |

## Criterios de éxito por tarea (6.2)

Métricas (ver `references/retrieval-metrics.md`): tokens estimados = `wc -c` de la salida / 4; tool_calls = comandos ejecutados (1 por segmento + fallbacks); dupes = pares `path:line` repetidos; final context = tokens de la salida (antes de dedup); latency = ms por consulta; correctness = hits (paths distintos en salida que matchean el glob esperado) ≥ `min_hits`. Valores esperados (skill; baseline naive suele ser 1.5–3× peor en tokens y tool_calls):

| # | files | tool calls | raw tokens | dedup tokens | final context | latency | correctness |
|---|-------|-----------|------------|--------------|---------------|---------|-------------|
| 1 | 1–20 (paths, lista con `-l`) | 2 (fallback) | 100–300 | 0 | < 400 | < 800 ms | ≥ 1 hit |
| 2 | 1–2 | 1 | 50–200 | 0 | < 300 | < 300 ms | ≥ 1 hit (`scripts/*`) |
| 3 | 1–3 | 1 | 100–300 | 0 | < 400 | < 300 ms | ≥ 1 hit (`*exclusions*`) |
| 4 | 3–6 | 1 | 200–600 | 0 | < 800 | < 300 ms | ≥ 1 hit (`openspec/changes/*`) |
| 5 | 1–2 | 1 | 50–150 | 0 | < 250 | < 200 ms | ≥ 1 hit (`scripts/*`) |
| 6 | 1–2 | 1 | 50–150 | 0 | < 250 | < 200 ms | ≥ 1 hit (`scripts/search-semantic`) |
| 7 | 1–4 | 1 | 100–400 | 0 | < 500 | < 300 ms | ≥ 1 hit (`scripts/retrieval-metrics`) |
| 8 | 1–3 | 1 | 50–200 | 0 | < 300 | < 200 ms | ≥ 1 hit (`evals/*`) |
| 9 | 1–5 | 2 (fallback) | 100–500 | 0 | < 600 | < 1000 ms | ≥ 1 hit |
| 10 | 1 | 1 | 100–400 | 0 | < 500 | < 500 ms | ≥ 1 hit |

## Procedimiento (6.3/6.4)

1. `evals/run-benchmark` recorre `evals/retrieval.json`.
   - **Vía A (skill)**: ejecuta `command` (scripts/ del repo). Si la salida queda vacía y hay `fallback`, lo ejecuta (cuenta como tool call extra).
   - **Vía B (baseline)**: ejecuta `baseline_command` (find/grep/cat naive, multi-segmento).
2. Por corrida registra `scripts/retrieval-metrics record t0X <json>` en `evals/metrics.ndjson`: query_type, tool(via), tokens, relevant, results, latency_ms, tool_calls, dupes, satisfied, skipped.
3. Correctness: hits (paths distintos de la salida que matchean `expect.path_glob`) ≥ `expect.min_hits` → `satisfied:true`.
4. Tarea sin archivos esperados en el repo (`rg --files | rg <glob>` < `min_hits`) → `skipped:true`, continúa sin fallar.
5. Exit 0 con resumen: N tareas, M pares skill/baseline completos.

## Targets (6.5) — `evals/analyze`

| Target | Regla | Límite |
|--------|-------|--------|
| tokens irrelevantes | avg tokens skill ≤ 70% de baseline | ≥ 30% menos |
| llamadas redundantes | avg tool_calls skill ≤ 80% de baseline | ≥ 20% menos |
| duplicados | avg dupes skill ≤ 80% de baseline | ≥ 20% menos |
| task success | % tareas con correctness OK skill ≥ baseline | no menor |

- Output JSON: `{"targets":{...},"summary":{...},"PASS":bool}`; exit 0 todos PASS, 1 alguno falla.
- Datos insuficientes (< 3 pares completos o ndjson vacío): `{"status":"insufficient"}` exit 2.

## Uso

```bash
evals/run-benchmark     # ejecuta corpus, acumula evals/metrics.ndjson
evals/analyze           # valida targets, emite JSON
# re-benchmark limpio:
rm -f evals/metrics.ndjson && evals/run-benchmark && evals/analyze
```
