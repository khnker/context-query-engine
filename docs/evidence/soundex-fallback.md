# Soundex Fallback (B17) — SÍ SIRVE (typos)

> Veredicto: SIRVE - recall 0->1.0

Segunda pasada fonética cuando la fusión devuelve **0 filas** (typos en el target): Soundex 4-char propio (stdlib, cero deps) sobre identificadores del repo, con part-matching para identifiers camelCase/snake_case. Opt-in `CF_SOUNDEX=1` (default off); umbral `CF_SOUNDEX_THRESHOLD` (default `0.8` — prefix-match de 3+ chars del código fonético). Corpus: índice bm25 (`.bm25-index.json`) con paths reales por token; fallback walk de paths; nunca crash.

La evidencia recuperada se etiqueta explícitamente como **similar, no exacta**: cada row lleva `similar: true`, `phonetic_score`, `phonetic_of`, `phonetic_target`, `match_type: 'soundex'` (evidence_tier 2, certainty 0.4) y `stats.soundex.note = "contenido similar, no el buscado"`.

Dataset `evals/datasets/soundex.json` (7 typos reales T1 + 2 control FP, `eval-soundex.js`):

| task | typo | gt_hits OFF | gt_hits ON | FP |
|------|------|------------|------------|----|
| sx-01 | retryWithFallbak | 0 | 1 | — |
| sx-02 | DEFAULT_TIMOUT_MS | 0 | 1 | — |
| sx-03 | get_provider_confg | 0 | 3 | — |
| sx-04 | HttpHndler | 0 | 3 | — |
| sx-05 | ProviderRuter | 0 | 2 | — |
| sx-06 | fallbak.test.ts | 0 | 1 | — |
| sx-07 | settngs.yaml | 0 | 1 | — |
| sx-fp-01/02 | inventados | 0 | 0 | 0 |

Veredicto: **PASS** — recall OFF 0 → ON 1.0 (ganancia +1.0), tasa de falsos positivos 0 con umbral default, latencia +80ms solo en el camino de 0 resultados.
