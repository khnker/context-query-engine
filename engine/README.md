# engine — CQL (Context Query Language) + Query Interpreter

Node.js ESM, **stdlib SOLO** (package.json `"type": "module"`, sin dependencias nuevas).

## cql.js — parser CQL → logical query plan (tasks 10.1/10.2)

`node engine/cql.js "<query>"` → imprime el logical plan JSON. Exporta `parseCQL(input)` (lanza `Error` en input inválido).

### Cláusulas (case-insensitive, orden flexible)

| Cláusula | Valores | Default | Qué produce en el plan |
|---|---|---|---|
| `FIND <target>` | implementation, definitions, references, usages, filename, pattern | implementation | `query_type` |
| `OF <kind> [<name>]` | kind: concept, symbol, file, function, class, constant · name: string entre comillas o bareword (**obligatorio**) | symbol | `target.kind` + `target.name` |
| `AND FOLLOW <relations>` | references, callers, callees, imports, dependents (lista por comas u otro AND) | — | `relations[]` |
| `AND INCLUDE <inclusions>` | tests, config, docs, generated (lista por comas u otro AND) | — | `inclusions[]` |
| `LIMIT <n>` | entero ≥ 1 | 20 | `limit` |
| `BUDGET <n>` | niveles {2000, 8000, 20000, 30000} — se redondea al nivel **inferior** más cercano (5000→2000, 15000→8000, 25000→20000, >30000→30000) | 8000 | `budget` |

### Ejemplo completo parseado

```
node engine/cql.js 'FIND implementation OF concept "provider fallback" AND FOLLOW references AND INCLUDE tests LIMIT 8000'
```

```json
{"query_type":"implementation","target":{"kind":"concept","name":"provider fallback"},"relations":["references"],"inclusions":["tests"],"limit":8000,"budget":8000,"confidence":0.95,"raw":"FIND implementation OF concept \"provider fallback\" AND FOLLOW references AND INCLUDE tests LIMIT 8000"}
```

### Errores

Input inválido → mensaje descriptivo en **stderr + exit 1** (ej. `FIND missing`, `invalid LIMIT: abc`, `invalid BUDGET: 500x`).

## interpreter.js — heurísticas intención → query_type (task 11.1)

`node engine/interpreter.js "<texto>"` → `{query_type, confidence, matched, name?}`. Sin ML, regex puro.

| query_type | Patrones | score base |
|---|---|---|
| definitions | define, dónde está definid, declara, where is…defin | 0.8 |
| references | usos, referencias, quién usa, callers, who calls, dónde se usa, references | 0.8 |
| implementation | implementa, implementation, implementación, cómo funciona, how does | 0.75 |
| filename | archivo, filename, file…llamad, dónde está el archivo | 0.8 |
| pattern | patrón, pattern, estructura, código que hace, keywords if/try/catch | 0.6 |
| concept | concepto, subsystem, módulo que, qué hace, concept | 0.6 |
| *(default)* | sin match | implementation 0.3 |

Reglas de confidence:

- **2+ keywords de la misma familia** → 0.95.
- **Combinación ambigua** (varias familias con 1 hit c/u) → la familia de mayor score, confidence 0.5.
- 1 sola familia → score base de la familia.
- `name` se extrae si es detectable: string entre comillas → camelCase/PascalCase → tras "de/el/la".

## ⚠️ Nota: empty results

Si el plan (CQL) o la query_type (interpreter) **no produce resultados**, el reporte downstream DEBE indicar **qué query type falló** — no reportar genéricamente "sin resultados". Ej.: `query_type=references → 0 resultados` (el consumidor puede sugerir cambiar de familia de query).
