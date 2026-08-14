# Filesystem Context

Reconocimiento y navegación del filesystem: mapas de proyecto, listado eficiente, exclusiones.

## Listado de archivos

| Necesidad | Comando |
|-----------|---------|
| Nombre de archivo | `fd name` |
| Todos los archivos de un tipo | `fd -e ts` |
| Solo archivos (no dirs) | `fd -t f pattern` |
| Archivos versionados | `git ls-files` |
| Archivos con regex | `rg --files \| rg 'pattern'` |
| Archivos de un directorio | `fd . src/services` |

## Exclusiones (.gitignore-aware)

`fd` y `rg` respetan `.gitignore` por defecto. Excluidos siempre:

```
node_modules/  .git/  dist/  build/  coverage/  vendor/
target/  .next/  __pycache__/  *.min.js  *.lock
```

Verificación: `fd -H` (hidden) solo cuando es intencional. `rg --no-ignore` solo para auditar algo específico ignorado — nunca por defecto.

## Project map

Reconocimiento de shape del repo antes de retrieval profundo (fase recon, ≤2000 tokens):

```bash
fd -t d -d 2 | head -40        # estructura de directorios
tokei -o json | jq '.Total'    # LOC por lenguaje
git ls-files | cut -d/ -f1 | sort -u   # top-level dirs
```

### Señales de shape

- `packages/` → monorepo (multi-espacio de scope)
- `src/` + `tests/` → layout clásico
- `api/` + `web/` → FE/BE separados
- `apps/*` → workspace apps

## Scope

1. Determinar directorio relevante con el map.
2. `rg` scoped: `rg pattern src/services` (nunca `rg pattern .` al inicio).
3. Ampliar scope solo si 0 resultados relevantes.

## Tokei

`tokei` reporta LOC reales por lenguaje (ignora comentarios/blank). Útil para:

- Estimar tamaño del repo (¿es codebase grande? ¿requiere Probe?)
- Identificar lenguaje dominante
- Detectar archivos sospechosos (¿un .ts de 5000 líneas?)

```bash
tokei                                   # resumen por lenguaje
tokei src -o json | jq '.Total.code'    # LOC de un dir
```
