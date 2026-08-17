# Harder baselines

> Veredicto: SIRVE - CQE gana o empata

CQE se compara contra baselines no-triviales: agente crudo (rg -n / rg --files directos), RepoMap textual (file tree rankeado por overlap léxico) y BM25 puro.

```bash
TMPDIR=$PWD/.tmp CF_TASKS=t1 node evals/scripts/eval-baselines.js   # → evals/reports/baselines-<TS>.json
```

Matriz T1 (32 tasks):

| baseline | correctness | recall@5 | MRR | tokens (mean) |
|----------|-------------|----------|-----|---------------|
| Agente crudo (rg -n) | 0.875 | 0.609 | 0.637 | 281 |
| Agente crudo (rg --files) | 0.594 | 0.406 | 0.453 | 13 |
| RepoMap textual | 1.000 | 0.698 | 0.810 | 52 |
| BM25 puro | 0.844 | 0.667 | 0.732 | 135 |
| **CQE** | **1.000** | **0.833** | **0.939** | 105 |
| CQE+rerank | 1.000 | 0.833 | 0.964 | 105 |

Veredicto: **CQE gana o empata en correctness** en T1/T2/dev (1.000/1.000/0.750). En dev, el agente crudo colapsa: 0.000 de correctness con **4.17M tokens** de contexto (rg -n sobre monorepo), vs 538 de CQE — el optimizer existe precisamente para eso. Dónde pierde: recall@10 contra RepoMap en T1 (0.833 vs 0.932) — el file tree completo captura archivos que el plan de CQE no toca; a cambio CQE entrega 2× más recall@5 con el mismo 1.000 de correctness. El baseline de agente completo (rg+read con tool calls, task success, time-to-solution) queda delegado al change `downstream-agent-eval`.
