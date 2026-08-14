# Retrieval Policy

Política inicial de selección de estrategia de retrieval. Fuente: spec `context-engineering` (Retrieval Strategy Selection). Se sobreescribe con lo aprendido por Execution Statistics (grupo 12).

## Política inicial: query-type → tool

| Query type | Tool primaria | Fallback |
|------------|---------------|----------|
| identifier | `rg "\bname\b"` (scoped) | ast-grep patrón de nombre |
| filename | `fd name` | `rg --files \| rg name` |
| pattern/estructura | ast-grep `-p '$A && $B'` | rg con regex multiline |
| symbol defs/refs | LSP (probe AST) | rg + parseo manual |
| subsystem/concepto | Probe (semántico) | rg amplio + project map |
| comportamiento/cambio | Git (log/diff) + LSP | rg en diffs |

## Fallback chains

1. identifier: `rg scoped` → `ast-grep` → `rg global`
2. filename: `fd` → `rg --files` → `git ls-files`
3. pattern: `ast-grep` → `rg multiline` → `semgrep` (si aplica)
4. symbol: `LSP defs` → `LSP refs` → `rg global` + `LSP call hierarchy`
5. concepto: `Probe` → `rg amplio` + `fd` map → `LSP` sobre candidatos
6. desconocido: `recon` (fd/tokei/git ls-files) → `lexical` (rg) → `structural` (ast-grep/LSP)

## Estrategia seleccionada

Regla de oro: la herramienta más barata que resuelva la pregunta. Costo típico: fd < jq/yq < rg < ast-grep < LSP < semgrep < Probe (ver tool-selection.md).

## Registro de estrategia

Tras cada retrieval registrar (para métricas y aprendizaje del optimizer):

```json
{
  "query_type": "identifier",
  "tool": "rg",
  "scope": "src/services",
  "results": 3,
  "relevant": 2,
  "tokens": 450,
  "latency_ms": 12,
  "satisfied": true
}
```

## Cuándo escalar nivel

- 0 resultados → subir un nivel de escalación (ampliar scope, luego otra tool)
- >20 resultados con pocos relevantes → refinar pattern (anclar)
- Concepto no capturable por regex → Probe
- Presupuesto excedido → detener, reportar parcial

## Ajustes empíricos (grupo 8)

Revisión de política inicial con evals (`evals/metrics.ndjson`, t01-t10):

| Query type | Política | Evals (skill vs baseline avg) | Decisión |
|------------|----------|-------------------------------|----------|
| identifier | rg scoped → ast-grep → rg global | 208 vs 3308 (ratio 0.06), 1 tool call | Confirmada; fallback nunca necesario |
| filename | fd → rg --files → git ls-files | 32 vs 102 (ratio 0.32), 1 call | Confirmada |
| pattern | ast-grep → rg multiline → semgrep | 178 vs 380 (ratio 0.47), 1 call | Confirmada |
| concept | Probe → rg amplio + fd map → LSP | 2329 vs 3014 (ratio 0.77), 2 calls | Confirmada |
| symbol | LSP defs → refs → rg global | 535 vs 460 (ratio 1.16) — única regresión | Revisar: fallback chain no supera baseline |
| repo_map | recon (fd/tokei/git ls-files) | 97 vs 19 (ratio 5.11), 1 vs 5 resultados | **Revisión**: fallback chain más eficiente fue la del baseline (3 calls baratas, sin preámbulo). Ajuste: repo_map = `fd` plano, sin envoltura |

Fallback chains validadas: identifier/filename/pattern promedian 1 tool call → fallbacks casi nunca se alcanzan; mantener orden actual. Escalar symbol: probar rg scoped primero (más barato que LSP) antes de LSP defs.
