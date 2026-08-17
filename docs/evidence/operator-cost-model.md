# Operator cost model (REJECT)

> Veredicto: REJECT

`CF_LEARNED_COST=1` reemplaza la COST_TABLE estática por costos medidos (p95 tokens / avg latencia por op|query_class, n>=5) desde la telemetría. Ablación T1: correctness 1.000 = 1.000 pero tokens 105 vs 104 → **REJECT**. Los promedios por op no discriminan variantes A/B/C (mismas ops reordenadas → coin-flip: plan_acc 0.9063→0.4375 sin cambio de tokens); la señal de costo relevante es cardinalidad por query. El valor real de costos aprendidos es para elegir entre FAMILIAS de ops (rg 15ms vs index 2-5ms), donde la COST_TABLE ya captura la diferencia — re-test orientado a access paths (context-query-ir) si se quiere.
