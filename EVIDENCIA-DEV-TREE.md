# Evidencia — Test pesado: context-query-engine sobre `/home/nicolas/dev`

Fecha: 2026-08-15. Árbol completo `/home/nicolas/dev` (~24 GB, ~30 proyectos).
Full reporte: `evals/reports/dev-tree-20260815.json`.
Original (workspace): `/home/nicolas/dev/README.md`.

## Dataset

- `evals/datasets/tasks-dev.json` — 14 tasks con ground truth real
  (paths relativos a `/home/nicolas/dev`): dashboard/server.js, dashboard/public/index.html,
  scripts/engram-sync-history.py, polar/graphify-out/graph.json, engine/engine.js,
  engine/mcp-server.js, evals/ml/classify.mjs, scripts/search-code,
  fe-eltarro/package.json, thinkpad-hunter/package.json, open-design/package.json,
  ecosystem.config.js.

## Resultados (CF_MODEL_CMD=`node evals/ml/classify.mjs`)

| Métrica | Heurístico | Reranker | Δ |
|---------|-----------|----------|-----|
| recall@5 | 0.857 (12/14) | 0.786 (11/14) | −0.071 |
| recall@10 | 0.929 (13/14) | 0.857 (12/14) | −0.071 |
| MRR | 0.637 | 0.520 | −0.118 |

## Análisis del Δ (sin regresión real)

- Guards activos (engine.js:322): queries `filename` **no** pasan por rerank → sus rows
  ejecutan código idéntico al heurístico. Diferencias en esas tasks = **no-determinismo
  del orden de fs** (`rg --files`/dedup varía entre runs: r@5 0.75↔0.857, r@10 0.833↔1.0),
  no del modelo.
- Queries `concept`/`symbol` (dev-13 `pm2`, dev-14 `SERVICE_META`): reranker **idéntico**
  al heurístico (0.333=0.333, 1=1) → **neutral, sin degradación**.
- Reranker gana a nivel de pares: held-out (dev + t1) recall@5 1.0, MRR 0.909
  (`evals/ml/train-reranker.py` → `evals/ml/model/reranker-model.json`).

**Verdicto:** reranker = neutral en árbol pesado con guards; sin regresión medible.

## Reproducción

```bash
CF_TASKS=dev CF_MODEL_CMD="node evals/ml/classify.mjs" node evals/scripts/eval-recall.js
# sin modelo:  CF_TASKS=dev node evals/scripts/eval-recall.js
```

## MCP — context-query-engine (opencode)

Registrado en `~/.config/opencode/opencode.jsonc` (type local, requiere restart de
opencode para cargarse). Server: `engine/mcp-server.js` (stdio, JSON-RPC, cero deps).

| Tool | Descripción |
|------|-------------|
| `context_query` | `intent` (CQP `FIND...` → runCQP; natural → runIntent) + constraints {budget, limit, scope} |
| `search_files` | passthrough a `scripts/search-code` (rg): pattern, dir, case_insensitive |
| `read_file` | passthrough a `scripts/extract-context`: path, start_line, end_line |

Escaneo sobre el CWD del proceso opencode. Excluye node_modules/.git/dist/build/
coverage/vendor/target/__pycache__/.next. Cache `engine/.cache.json` TTL 5min.

Verificación: `engine/mcp-test.sh` (init→initialized→tools/list→tools/call, RC=0).

## Ahorros de tokens y tiempo — con datos reales

Mediciones 2026-08-15 sobre `/home/nicolas/dev` (24 GB, 164,063 archivos no ignorados).

### Línea base naive (sin engine)

| Operación | Resultado | Tiempo |
|-----------|-----------|--------|
| Enumerar el árbol completo (`rg --files`, mismos excludes) | 164,063 archivos | 0.23 s |
| grep crudo `"pm2"` (dev-13) | 27 archivos, **133,826,745 B** (~33.5M tokens @4c/tok) | 0.13 s |
| grep crudo `"SERVICE_META"` (dev-14) | 3 archivos, 16,224 B (~4,056 tokens) | 0.16 s |

El grep crudo devuelve **matches sin ordenar ni distilar**: leer los 27 archivos pm2
crudos = 134 MB → ~33.5M tokens de contexto LLM.

### Engine `context-query-engine` (CF_MODEL_CMD=classify.mjs, LIMIT 10)

| Query | Results | Contexto entregado | tokens_used | Latencia |
|-------|---------|-------------------|-------------|----------|
| dev-13 concept "pm2 process monitoring" | 121 | 7,045,675 B (~1.76M tokens) | 1,761,495 | 0.66 s cold / cache_hits warm |
| dev-14 symbol "SERVICE_META" | 9 | 417 B (~104 tokens) | 116 | ~0.2 s cold |

### Ahorro neto

| Métrica | dev-13 (concepto amplio) | dev-14 (símbolo puntual) |
|---------|--------------------------|--------------------------|
| Tokens de contexto LLM | **33.5M → 1.76M = ~19× menos** | **4,056 → 104 = ~39× menos** |
| Bytes a leer | 134 MB → 7 MB | 16 KB → 0.4 KB |
| Output | 27 crudos | 9 **ordenados por relevancia** |
| Costo extra de latencia | +0.53 s vs grep crudo | +0.04 s vs grep crudo |

Además:
- **Cache TTL 5 min** (`engine/.cache.json`): segunda ejecución del mismo query =
  `cache_hits:1, tool_calls:0` → latencia ≈ 0 (solo rerank, 51–83 ms para 121 results).
- El engine entrega **orden + distill** (ranking por relevancia con el reranker real,
  kept/dropped por budget) que el grep crudo no provee.
- Queries `filename` (match exacto): engine mínimo, sin rerank (guard engine.js:322) —
  ahí el ahorro no aplica, el heurístico ya gana.

**Verdicto honesto:** grep crudo es más rápido en frio (+0.04–0.53 s) pero inútil sin
leer los archivos; el ahorro real del engine es **~19–39× menos tokens de contexto LLM**
con ranking incluido. En queries pequeñas/puntuales la ganancia es marginal (dev-14) y en
filename no aplica; en conceptos amplios sobre árbol grande es donde rinde (dev-13).
