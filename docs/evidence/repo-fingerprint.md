# Repo fingerprint consistency (máxima transversal)

> Veredicto: SIRVE

Máxima: **todo artefacto que derive de archivos declara su dependencia del estado del repo** — si el fingerprint cambia, se invalida o se marca stale; nunca evidencia vieja silenciosa.

Fingerprint barato (`repoFingerprint`, engine/index-layer/manifest.js): sha256 de la lista ordenada `path|size|mtimeMs` (walk+stat, sin leer contenido). mtime+size para el scan completo; sha256 de contenido solo sobre archivos cambiados.

| Artefacto | Acción al cambiar el repo |
|-----------|---------------------------|
| Cache engine (`.cache.json`) | Key con fingerprint: entrada filtrada en loadCache → miss determinista (activo si `CF_FINGERPRINT=1` o existe catálogo `.cqe/`) |
| BM25 persistido (`.bm25-index.json`) | `loadPersisted` valida fingerprint → rebuild (además de mtime+size) |
| statistics.ndjson | Cada record lleva `repo_fp` (setFingerprint por runPlan) → provenance para modelos |
| Índice catalog (SQLite) | Manifest sha256 + freshness snapshot/dirty_scope (ya existía) |

Verificado (eval-fingerprint.js): cache cold 0 → warm 1 → **touch → 0 (invalidada)** → 1 (repoblada); BM25 rebuild por fingerprint; stats con repo_fp. Bugs que esto elimina: cache con TTL 5min devolviendo evidencia vieja, stale-catálogo sin rebuild, drift de stats sin provenance. Modelos aprendidos: tagging con fingerprint de entrenamiento queda como refinamiento (runtime staleness check).
