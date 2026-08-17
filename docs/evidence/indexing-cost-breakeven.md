# Indexing cost & break-even

> Veredicto: medicion - N_break_even < 1.3

Medición (`evals/scripts/eval-indexing.js`, tasks 3.1-3.5 del change `indexing-cost-breakeven`): T_index = build BM25 cold (median 3 runs, proceso fresh, index lazy per-process en `engine/bm25.js`, cap 1000 files/256KB); T_incremental = rebuild full por proceso (impl actual no tiene índice incremental — touch 5 files no reduce coste); RAM = rss tras build; T_query cold/warm = `engine.js` sobre el cqp representativo del repo (warm = cache persistido en `engine/.cache.json`, `cache_hits=1`); baseline = `rg -n --no-ignore -g !node_modules` (median 3). Artefacto: `evals/reports/indexing-cost-*.json`.

| repo | files | bytes | T_index (med) | RAM pico | T_incremental | T_query cold | T_query warm | rg baseline | N_break_even |
|---|---|---|---|---|---|---|---|---|---|
| t1-basic | 9 | 3.3KB | 2ms | 45.9MB | 2ms | 132ms | 77ms | 6ms | 0 |
| t1-modular | 11 | 1.8KB | 2ms | 45.7MB | 2ms | 128ms | 80ms | 7ms | 0 |
| polar | 1000 (cap) | 11.4MB | 418ms | 141.6MB | 408ms | 150ms | 93ms | 712ms | 0.7 |
| dev | 1000 (cap) | 17.9MB | 924ms | 181.2MB | 920ms | 383ms | 100ms | 822ms | 1.3 |

- **N_break_even = T_index / (baseline − T_query_warm)**; denominador ≤ 0 → N=0 (el setup nunca se amortiza).
- **Regla (3.5):** repos con N_break_even > 100 → *usar rg para workloads < N queries*. Ningún repo del stack excede el umbral.
- t1-*: N=0 — CQE warm (~80ms de overhead node+engine) es más caro por query que rg (~6ms); en repos chicos conviene rg directo (CQE agrega latencia sin ahorro de setup, que es trivial).
- polar/dev: N<1.3 — el index build (~0.4-0.9s) se paga con la primera query (rg tarda 0.7-0.8s por query). Alternativa BM25-only cold (reindexa por proceso cada query): N≈1 — CQE evita re-indexar, quiebre inmediato.
- T_incremental == T_index: la impl actual reindexa full por proceso; tarea derivada = índice incremental persistente si T_index > 1s en repos grandes.
