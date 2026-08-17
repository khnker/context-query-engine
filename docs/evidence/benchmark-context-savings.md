# Benchmark: context savings

> Veredicto: PASS - 61% menos tokens

Métricas duras de tokens y latencia medidas sobre ejecuciones reales (no estimadas). Todo reproducible.

### Test de regresión de métricas (hard)

`npm run bench` mide tiempo y tokens reales de context-query-engine (C) vs baseline raw-fs (A) sobre el repo sintético, con guardas: la suite **falla** si C gasta más tokens que A o supera los umbrales.

| Query | A tokens | C tokens | A lat | C lat |
|-------|----------|----------|-------|-------|
| lex-01 | 655 | 239 | 43 ms | 144 ms |
| dep-01 | 655 | 239 | 67 ms | 295 ms |
| sem-01 | 655 | 239 | 57 ms | 216 ms |
| tst-01 | 504 | 239 | 47 ms | 251 ms |
| **Σ** | **2,469** | **956** | — | — |

→ **61.3% menos tokens**, wall 1.4 s, 4/4 queries correctas en ambas vías.

### Harness T1 — 32 tasks sintéticas, 4 modos

| Modo | Correctitud | Tokens | Latencia | Compresión vs A |
|------|-------------|--------|----------|-----------------|
| A — baseline raw (`grep`/`cat`) | 100% | 139,199 | 978 ms | 1.0× |
| B — `rg`/`fd` | 92.5% | 95 | 108 ms | 637× |
| **C — context-query-engine** | **100%** | **764** | **199 ms** | **104×** |
| D — oracle | 87.5% | 611 | 1,506 ms | 129× |

### Repo real T2 — `polar` (2,129 archivos, 50k+ LOC)

| Modo | Correctitud | Tokens | Latencia | Densidad |
|------|-------------|--------|----------|----------|
| A — baseline | 8/8 | 694,581 | 12,098 ms | 0.1856 |
| B — `rg`/`fd` | 8/8 | 409 | 283 ms | 0.1679 |
| **C — context-query-engine** | **8/8** | **3,403** | **232 ms** | **0.1875** |
| D — oracle | 8/8 | 2,512 | 7,867 ms | 0.1668 |

C corta **204× vs baseline** en el repo real con 98% menos latencia, manteniendo correctitud y la mayor densidad (información útil por token).

Reproducible: `npm run eval` (harness completo) y `npm run bench` (métricas duras con guardas).

---
