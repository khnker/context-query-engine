# Context Deduplication

Dedup intra-sesión: evitar re-ejecutar búsquedas y re-insertar resultados repetidos. Requisito spec `context-engineering` (Result Fusion, dedup cross-tool).

## Cache de sesión

Clave = hash de `(query, scope, tool, options)`.

```
sha256("rg|provider fallback|src/|word") → { results, tokens, ts }
```

- Hit → reusar resultados, costo ~0 tokens.
- Miss → ejecutar, almacenar.
- TTL: toda la sesión (no expira dentro de una conversación).

## Fusion cross-tool

El mismo `file:line` apareciendo en resultados de 2+ tools (rg + ast-grep + LSP) se fusiona en **un solo ítem** con lista de matches:

```json
{
  "file": "src/provider/fallback.ts",
  "line": 42,
  "matches": ["rg", "ast-grep", "lsp"],
  "snippet": "..."
}
```

## Reglas

1. **Búsqueda idéntica** en ≤ 5 turnos → reusar cache, no re-ejecutar.
2. **Búsqueda con scope más amplio** que una previa → ampliar resultados con cache + delta, no re-ejecutar completa.
3. **Resultado repetido** en contexto → no re-insertar; referenciar `file:line` ya citado.
4. **Misma query, mismo tool, scope distinto** → cache separado (scope es parte de la clave).
5. **Lecturas**: archivo ya leído en sesión → no re-leer completo; leer solo líneas nuevas (offset).

## Anti-patterns

- `rg` global repetido 3x con distinto casing — cache matchea normalizando lowercase.
- Pegar el mismo snippet de archivo 2 veces — reusar referencia.
- Re-correr benchmark de evals en la misma sesión — usar resultados cacheados salvo flag de fuerza.
