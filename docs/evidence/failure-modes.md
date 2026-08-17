# Cuándo NO usar context-query-engine

> Veredicto: SIRVE - regla de oro rg vs CQE

Evaluación de failure modes (24 queries triviales, 6 categorías: exact-filename, exact-symbol, single-file, one-shot, tiny-repo, trivial-regex; repos t1-basic/t1-modular/polar). Artefacto: `evals/reports/failure-modes-<TS>.json`, reproducir con `TMPDIR=$PWD/.tmp node evals/scripts/eval-failure-modes.js`.

| categoría | raw correctness | cqe correctness | raw lat | cqe lat |
|-----------|-----------------|-----------------|---------|---------|
| exact-filename | 0.25 | 1.00 | 66ms | 102ms |
| exact-symbol | 0.25 | 1.00 | 67ms | 123ms |
| single-file | 0.25 | 1.00 | 68ms | 123ms |
| one-shot | 0.50 | 1.00 | 71ms | 125ms |
| tiny-repo | 0.00 | 1.00 | 17ms | 113ms |
| trivial-regex | 0.50 | 1.00 | 17ms | 115ms |

Hallazgos (24 queries, lose_rate 0.000 — CQE nunca pierde correctness en estos casos):

- **Correctness**: CQE gana en TODAS las categorías. El raw `rg -n` por palabras pierde queries de nombre de archivo (rg busca contenido, no rutas) y se contamina en repos grandes (dumps/coverage lo desbordan).
- **Dónde SÍ gana rg**: solo en **latencia en repos pequeños**. Lookup de archivo/símbolo exacto en t1-basic/t1-modular: rg 8-18ms vs CQE 95-149ms → **rg ~6-10x más rápido**. Para un one-shot puntual de un nombre único en un repo chico, `rg` directo es la opción.
- **Dónde NO puede competir rg**: tokens. En polar, rg content-scan devuelve ~16.7M tokens (líneas de dumps SQL/coverage) vs CQE 10-292. Overhead de pipeline CQE: +36-98ms por query (spawn+optimizer+fusión), compensado con creces en repos medianos/grandes.

Regla de oro: **búsqueda de archivo por nombre exacto en repos pequeños → rg es 6-10x más rápido en latencia (pero sin garantía de correctness). En repos ≥ mediana o con queries mixtas filename+contenido → CQE domina en correctness y tokens.**
