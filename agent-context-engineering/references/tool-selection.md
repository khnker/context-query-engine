# Tool Selection

Árbol de decisión completo de herramientas de retrieval con costos típicos en tokens de resultado.

## Tabla de decisión

| Tarea | Tool | Cuándo NO usar | Costo típico |
|-------|------|----------------|--------------|
| Nombre exacto de símbolo | `rg "\bname\b" -l` | Pattern con estructura | ~200 |
| Nombre de archivo | `fd name` | Necesito contenido, no path | ~100 |
| Filename con regex | `rg --files \| rg 'pattern'` | Nombre exacto conocido | ~100 |
| Patrón estructural (if anidado, 2 expresiones) | `ast-grep -p '$A && $B'` | Regex simple basta | ~300 |
| Multi-file rule complex | `semgrep --config ...` | Scope pequeño, regex alcanza | ~500+ |
| Parseo JSON/YAML en pipeline | `jq` / `yq` | Acceso directo al archivo | ~50 |
| Símbolo difuso/semántico | `probe query "concepto"` | Identifier exacto conocido | ~800+ |
| Definición de símbolo | LSP (textDocument/definition) | Solo necesito matches | ~400 |
| Referencias de símbolo | LSP (textDocument/references) | Nada más que rename | ~400 |
| Call hierarchy | LSP (incoming/outgoing calls) | Solo definición | ~400 |
| Conteo/estadística LOC | `tokei` | Necesito snippets | ~300 |
| Ver existencia | `fd -t f name` / `rg -l` | — | ~50 |

## Reglas de uso

1. **Cheapest-first**: resolver con la herramienta de menor costo que satisfaga la pregunta.
2. **Scope siempre**: `rg`/`fd` sin scope = último recurso. Identificar directorio relevante primero (por nombre de archivo o mapa).
3. **Combinar**: `jq`/`yq` se usan para filtrar output de otras tools, no como herramientas standalone de retrieval.
4. **Probe para semántica**: cuando el concepto no es un nombre exacto ("provider fallback", "retry logic"), no regex. Probe indexa por unidades semánticas (funciones/clases) y rankea por relevancia.
5. **LSP para precisión de símbolo**: defs/refs resuelven el símbolo real, no el texto. Usar cuando hay sobrecargas o homónimos.
6. **ast-grep para estructura**: patrones AST anclan contexto (`-p 'if ($C) { $A }'`), evita falsos positivos de regex.

## Árbol

```
¿Nombre exacto conocido?
├─ sí, símbolo → rg scoped
├─ sí, archivo → fd
├─ sí, pero hay homónimos → LSP defs/refs
└─ no
   ├─ ¿Estructura AST conocida? → ast-grep
   ├─ ¿Concepto semántico? → probe
   ├─ ¿Necesito parsear output? → + jq/yq
   └─ ¿Desconocido? → recon (fd/tokei/git ls-files) → lexical (rg) → structural (ast-grep/LSP)
```

## Presupuesto por tool

| Fase | Límite tokens |
|------|---------------|
| jq/yq/fd/verificación | ≤ 200 |
| rg scoped | ≤ 800 |
| ast-grep | ≤ 1200 |
| LSP defs/refs | ≤ 1600 |
| Probe | ≤ 3000 |
| semgrep | ≤ 5000 |
