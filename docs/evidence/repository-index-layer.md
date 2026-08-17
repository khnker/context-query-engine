# Repository Index Layer

> Veredicto: SIRVE

Capas de acceso a los repositorios materializadas (SQLite+FTS5, node:sqlite, zero deps) bajo `engine/index-layer/`. El índice produce **evidencia tipada**, no search results: `{source, entity, path, span, certainty, index_version, cost{latency_ms, tokens}}` — determinista (symbol/dependency: certainty 1.0) o probabilística (lexical: 0.9).

```bash
node engine/index-layer/index.js index <repo>         # build incremental (manifiesto sha256)
node engine/index-layer/index.js query <repo> symbol retryWithFallback
node engine/index-layer/index.js query <repo> lexical fallback
node engine/index-layer/index.js freshness <repo>    # snapshot | dirty_scope → use_index | reindex
```

Componentes: store (SQLite WAL + FTS5, `.cqe/catalog.db`), manifest (diff sha256/mtime/size), extractores de símbolos/deps por lenguaje (TS/JS/Python regex), indexer incremental (1 archivo tocado → 1 reindexado), watcher (fs.watch recursive + debounce + coalescing a `FileChangeEvent`), freshness model (nunca evidencia vieja silenciosa — decide reindex o live-disk).

| repo | build | reuse | incr (1 f) |
|------|-------|-------|------------|
| t1-basic | 54ms | 58ms | 58ms (1) |
| polar | 134ms | 123ms | 130ms (1) |

Watcher roundtrip 259ms; queries < 50ms. Este es el access layer del planner: los índices se convierten en **access paths** que el optimizer puede elegir (change `context-query-ir`), en vez de rg/search sobre filesystem crudo. Detalle v1: symbols por regex (sin tree-sitter); differencial vs Frigg/cqs = el planner/retrieval queda en CQE, aquí solo el catálogo materializado.
