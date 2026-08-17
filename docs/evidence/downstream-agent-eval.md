# Downstream agent evaluation

> Veredicto: FAIL umbral estricto (matiz: +25pp success)

CQE se evalúa por utilidad para un agente, no solo recall: un retrieval-agent determinista (sin LLM, stdlib SOLO) corre el loop retrieve → inspect → think → refine → verify sobre 8 tareas reales con completion medible (answer contiene GT). Dos modalidades: herramientas crudas (rg -n) vs CQE (engine). Hipótesis falsable: "menos contexto ≠ mejor".

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-downstream.js   # → evals/reports/downstream-<TS>.json
```

| modalidad | task success | tokens (mean) | tool calls | tts |
|-----------|--------------|---------------|-----------|-----|
| Agente crudo (rg -n) | 0.750 | 244 | 2.9 | 6 ms |
| Agente + CQE | **1.000** | 349 | 3.4 | 102 ms |

Veredicto del umbral estricto (CQE ≥ crudo en success Y menos tokens): **FAIL** — CQE no reduce tokens totales (+43%). El matiz importa: la prima de tokens viene de las 2 tareas donde el agente crudo NO TIENE respuesta (rg devuelve 0 líneas, 0 tokens, 0 success) — CQE las resuelve (615/268 tokens). Por tarea resuelta el costo es comparable (349 vs 325). Hallazgo: la hipótesis "menos contexto ≠ mejor" se confirma al revés — la utilidad (task success) gana con mejor selección aun con más contexto; CQE aporta +25pp de task success sin responder peor en ninguna tarea. El costo de latencia (102 ms vs 6 ms) es el precio del optimizer; en flujos batch reales domina el ahorro de turnos fallidos.
