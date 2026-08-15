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
