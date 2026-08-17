# Generated Code Default Policy (B14) — OFF default (medición empírica)

> Veredicto: SIRVE - OFF default

Código generado (`dist/`, `build/`, `vendor/`, etc.) está **excluido por defecto** (BAD_PATH_LIST en assemble-context + SKIP_DIRS del índice + rg respeta .gitignore). Decisión basada en medición, no dogma: matriz `eval-generated-code.js` sobre tasks generated-code (adversarial gc-19/20/21) + control T1 (32 tasks), configs OFF / `CF_INCLUDE_GENERATED=1` / ON + `CF_SEARCH_NO_IGNORE=1`.

| Config | GC recall | GC tokens/q | Control tokens/q | Control rows/q |
|--------|-----------|-------------|------------------|----------------|
| OFF (default) | 0.667 | 16.7 | 104.9 | 6.7 |
| ON solo | 0.667 | 16.7 | 104.6 | 6.7 |
| ON + NO_IGNORE | **1.000** | 30.0 | 104.9 | 6.7 |

Fallos sin señal bajo query de filenames en root (`package.json`, `package-lock.json`) ya se resuelven OFF; el único gain real es `main.js` en `api-polar/dist/` (bundle Angular), inalcanzable sin `--no-ignore`. `CF_INCLUDE_GENERATED` solo relaja assemble-context — **es inerte sin `CF_SEARCH_NO_IGNORE`** (los globs de búsqueda siguen excluyendo dist/). Política final: **OFF default** (contexto limpio); queries sobre artifacts usan opt-in doble `CF_INCLUDE_GENERATED=1 CF_SEARCH_NO_IGNORE=1`. Provenance B14 3.1: rows con path generado (segmento dist|build|vendor|generated|coverage) marcan `provenance.generated: true` en su packet (evidence.js `toPacket`).
