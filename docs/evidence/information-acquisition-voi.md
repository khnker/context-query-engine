# Information Acquisition / VoI (B7) — SÍ SIRVE (mecanismo, parity)

> Veredicto: SIRVE (parity)

Retrieval como acción con valor esperado: `VoI(op) = P_new·rel·value − tokens·WT − latency·WL` (`engine/voi.js`). `CF_VOI=1` ordena las ops del plan por VoI desc y poda las de VoI ≤ 0 (abstención por VoI — el análogo plan-level del abstain).

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-voi.js   # → evals/reports/voi-<TS>.json
```

T1 (32): parity exacta — correctness 1.000 = 1.000, tokens 105 = 105, pruned 0 (todas las ops tienen VoI positiva; la poda se activa con successRate bajo + op cara, p.ej. search-semantic 800tok). Confirma el patrón: con señal estática por op el mecanismo no discrimina en T1; el valor real está en P_new por query (puente a adaptive-query-execution B8).
