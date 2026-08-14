---
name: context-engineering
description: retrieval eficiente de contexto en codebases grandes: árbol de decisión de herramientas (rg/fd/ast-grep/LSP/Probe), presupuestos de tokens, escalación, anti-patterns
triggers:
  - búsqueda de símbolos/funciones/clases en el código
  - entender cómo funciona un subsystem
  - análisis de un repo grande antes de implementar
negatives:
  - tareas de escritura de código (usar coding skills)
  - conversaciones generales
---

# Context Engineering

Retrieval de contexto en codebases grandes con costo mínimo: elegir la herramienta correcta, respetar presupuestos de tokens, escalar solo cuando hace falta.

## Activación

Aplicar cuando la tarea requiere entender código existente:

- Buscar definición de un símbolo (función, clase, constante)
- Rastrear flujo: quién llama a X, qué llama X
- Mapear un módulo o subsystem antes de tocar código
- Auditar impacto de un cambio (callers de un símbolo)

No aplicar a tareas de escritura desde cero ni conversación general.

## Árbol de decisión de retrieval

1. **Identifier exacto** → `rg "\bname\b"` con scope del directorio relevante
2. **Filename** → `fd name`
3. **Pattern/estructura** → `ast-grep -p '$A && $B'`
4. **Símbolo + callers** → LSP (definiciones/referencias/call hierarchy)
5. **Subsystem o concepto difuso** → Probe (semántico, AST-aware)
6. **Desconocido** → recon (`fd` project map) → lexical (rg amplio) → structural (ast-grep/LSP)

Regla: la herramienta más barata que resuelva la pregunta gana. Subir al siguiente nivel solo si el nivel actual no satisface.

## Escalación (niveles 0-6)

| Nivel | Condición | Acción |
|-------|-----------|--------|
| 0 | Nada encontrado | Ampliar scope (directorio → repo) |
| 1 | Resultados ruidosos | Refinar pattern (anclar, word boundary) |
| 2 | Candidato ambiguo | LSP definición para desambiguar |
| 3 | Concepto difuso | Probe semántico |
| 4 | Repo desconocido | Recon completo (map + tokei) |
| 5 | Presupuesto excedido | Detener, reportar resultados parciales |
| 6 | Fallo total | Reportar query type y contexto parcial |

## Presupuestos de tokens

| Nivel | Presupuesto | Uso |
|-------|-------------|-----|
| S | 2000 | Snippet puntual, verificación de existencia |
| M | 8000 | Función + callers directos |
| L | 20000 | Subsystem completo |
| XL | 30000 | Análisis repo completo |

Early termination: detener cuando el resultado satisface la pregunta. Nunca exceder presupuesto sin justificación (reportar por qué).

## Anti-patterns prohibidos

- `rg pattern .` global cuando existe scope identificable
- `cat` de archivos grandes sin grep/read parcial previo
- Re-leer archivos ya leídos en la sesión
- Leer directorios completos (sin `-t f`/glob)
- Búsquedas idénticas repetidas (usar dedup/cache)
- Ignorar .gitignore/node_modules/dist
- Pegar bloques de código enteros al contexto sin filtrar
