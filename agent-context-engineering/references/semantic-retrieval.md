# Semantic Retrieval

Retrieval basado en estructura y semántica: Probe (AST-aware) y LSP (lenguaje-aware). Para conceptos que un regex no captura.

## Probe

Motor de retrieval semántico (zeroentropy-ai). Indexa código por **unidades semánticas** (funciones, clases, exports) no por líneas.

### Cuándo

- Concepto difuso: "provider fallback", "retry logic", "error handling central"
- El nombre exacto se desconoce o varía
- El regex produce ruido (matches en comentarios, strings)

### Uso

```bash
probe query "concepto"          # buscar por relevancia semántica
probe query "concepto" --limit 10
```

### Características

- AST-aware: entiende estructura real del código (no texto plano)
- Ranking por relevancia al query, no por orden de aparición
- Respeta presupuestos: cada resultado trae snippet + file:line
- Se combina con FTS para recall amplio + reranking

### Presupuesto

- Por defecto nivel M (8000 tokens). Subir a L solo si el concepto abarca múltiples módulos.
- Cada resultado: snippet corto (función/export) — densidad alta.

## LSP

Language Server Protocol: resolución precisa de símbolos. Disponible vía cliente LSP (VS Code, Neovim, etc.).

### Definiciones (textDocument/definition)

- Dónde está declarado un símbolo
- Útil para desambiguar homónimos (sobrecargas, namespaces)
- Un salto, costo bajo

### Referencias (textDocument/references)

- Todos los usos de un símbolo
- Esencial para auditar impacto de un cambio (rename, firma)
- Costo medio

### Call hierarchy (incoming/outgoing calls)

- Quién llama a X (incoming) y qué llama X (outgoing)
- Costo alto — solo cuando la pregunta es sobre flujo, no existencia

### Cuándo cada una

| Pregunta | LSP call |
|----------|----------|
| ¿Dónde se define X? | definition |
| ¿Qué usa X? | references |
| ¿Quién llama a X? | incoming calls |
| ¿Qué hace X (a quién llama)? | outgoing calls |
| ¿X es sobrecarga? | definition + refs |

## Combinación

Probe genera candidatos → LSP confirma definiciones/referencias → rg/ast-grep para contexto textual. Orden típico en escalación nivel 3+:

```
probe query "concepto" → candidatos
lsp definition por candidato → confirmación
lsp references → impacto
rg snippet → contexto exacto
```

## Política de escalación LSP/Probe

Escalación según nivel de incertidumbre y presupuesto. Probe descubre candidatos, LSP confirma símbolos, y el presupuesto es el tope.

### Niveles

| Nivel | Condición | Acción |
|-------|-----------|--------|
| 3 | Concepto difuso (comportamiento, no nombre exacto) | `search-semantic` / `probe query` primero |
| 3+ | Probe devuelve candidatos ambiguos | `probe` → `lsp definition` por candidato para confirmar |
| 4 | Repo desconocido, sin contexto previo | recon (project-map / search-structure) + `probe query` |
| 5 | Presupuesto agotado o resultados no concluyentes | Detener; reportar hallazgos parciales |

### Orden recomendado

```
nivel 3:   probe query "concepto" → candidatos
           si ambiguo → lsp definition por candidato
nivel 4:   recon estructura → probe query → lsp definition/references
nivel 5:   detener, reportar parciales
```

### Reglas

- Probe es la puerta de entrada para concepto difuso; no empezar por LSP sin saber qué símbolo buscar.
- LSP definition confirma, no descubre: desambigua candidatos de Probe.
- Nivel 5 es terminal: sin presupuesto no se escala a más herramientas.

## Política de escalación LSP/Probe

Escalación según nivel de incertidumbre y presupuesto. Probe descubre candidatos, LSP confirma símbolos, el presupuesto es el tope.

### Niveles

| Nivel | Condición | Acción |
|-------|-----------|--------|
| 3 | Concepto difuso (comportamiento, no nombre exacto) | `search-semantic` / `probe query` primero |
| 3+ | Probe devuelve candidatos ambiguos | `probe` → `lsp definition` por candidato para confirmar |
| 4 | Repo desconocido, sin contexto previo | recon (project-map / search-structure) + `probe query` |
| 5 | Presupuesto agotado o resultados no concluyentes | Detener; reportar hallazgos parciales |

### Orden recomendado

```
nivel 3:   probe query "concepto" → candidatos
           si ambiguo → lsp definition por candidato
nivel 4:   recon estructura → probe query → lsp definition/references
nivel 5:   detener, reportar parciales
```

### Reglas

- Probe es la puerta de entrada para concepto difuso; no empezar por LSP sin saber qué símbolo buscar.
- LSP definition confirma, no descubre: desambigua candidatos de Probe.
- Nivel 5 es terminal: sin presupuesto no se escala a más herramientas.
