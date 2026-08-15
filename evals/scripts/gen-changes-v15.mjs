#!/usr/bin/env node
// Genera proposal.md / tasks.md / specs/<id>/spec.md para los 11 changes v1.5 (revisión hostil 22 puntos)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CH = path.join(ROOT, 'openspec/changes');

const C = {
  'planner-isolation-benchmark': {
    proposal: `# Planner Isolation Benchmark (review 1)

La review hostil: "tu benchmark mide retrieval, no optimization". El regret actual
(0.6886→0.6655) mezcla mejora de herramientas de retrieval con mejora del optimizer.

Objetivo: aislar la contribución del optimizer fijando los retrieval operators y
variando SOLO el planner: first-match / heuristic / cost-based / learned / oracle.
Medir optimizer regret sin que las mejoras vengan de mejores herramientas.

Resultado T1 (2026-08-15): mismos ops forzados A/B/C — first-match regret 0.455,
heuristic/learned 0; plan_acc first-match 0.5 vs heuristic/learned 0.875; gt_recall 1.0
todos. El planner decide 45.5% de los tokens sin cambiar un solo operador.`,
    tasks: `## Tasks — planner isolation

- [x] 1.1 Harness: correr planes A/B/C con retrieval ops FIJOS (mismo executor) y planners first-match/heuristic/cost/learned/oracle sobre T1/T2/dev
- [x] 1.2 Métrica: optimizer regret por planner (tokens actuales vs oracle), plan accuracy
- [x] 1.3 Baseline: regret heuristic y learned documentado (actual: 0.6655 learned / 0.6886 heuristic)
- [x] 1.4 Umbral de adopción: learned ≤ heuristic en regret Y correctness ≥ baseline en T1 completo (cumplido: 0 = 0, gt_recall 1.0)
- [ ] 1.5 Artefacto: evals/reports/planner-isolation-<TS>.json + sección en report.md del reproduce.sh`,
    spec: `# Planner Isolation Benchmark

## ADDED Requirements

### Requirement: el benchmark debe aislar la contribución del planner del resto del pipeline

El harness ejecuta los mismos retrieval operators (fijos) bajo distintos planners
(first-match, heuristic, cost-based, learned, oracle) y reporta regret y plan
accuracy por planner, sobre T1, T2 y dev.

#### Scenario: ablation de planners sobre T1

Dado el manifest T1 con retrieval ops congelados, cuando el harness corre los 5
planners sobre las 32 queries, entonces produce regret/accuracy por planner en
evals/reports/planner-isolation-<TS>.json.

#### Scenario: veredicto de adopción

Dado el reporte generado, cuando regret(learned) ≤ regret(heuristic) y
correctness(learned) ≥ baseline en T1 completo, entonces el veredicto es PASS.
`,
  },
  'harder-baselines': {
    proposal: `# Harder Baselines (review 2)

"rg es un baseline demasiado fácil de derrotar": rg devuelve texto, CQE interpreta+filtra+
fusiona+rankea+budgetea. Baselines reales: rg/fd (existe), BM25/FTS5, RepoMap, AST
retrieval, hybrid lexical/semantic, graph retrieval, y el competidor real: un agente
moderno con tools vs agente + CQE.`,
    tasks: `## Tasks — baselines difíciles

- [ ] 2.1 Inventario de baselines implementables sin deps nuevas (rg/fd ya existe; BM25 simple en node; RepoMap textual)
- [ ] 2.2 Harness multi-baseline sobre T1/T2/dev: tokens, latencia, correctness, recall@k, MRR por baseline
- [ ] 2.3 Baseline agente: correr agente con tools crudas (rg + read) vs agente + CQE sobre suite de tareas (reusar downstream-agent-eval)
- [ ] 2.4 Matriz de resultados en README + evals/reports/baselines-<TS>.json
- [ ] 2.5 Umbral: CQE debe ganar o empatar en correctness en tareas complejas; se documenta dónde pierde`,
    spec: `# Harder Baselines

## ADDED Requirements

### Requirement: el benchmark debe incluir baselines no-triviales de retrieval

Además de rg/fd, el harness corre BM25/FTS5, RepoMap textual, hybrid lexical/semantic
y un agente con herramientas crudas, midiendo tokens, latencia, correctness y recall@k
por baseline sobre T1, T2 y dev.

#### Scenario: matriz de baselines

Dado el harness multi-baseline, cuando corre sobre el manifest T1, entonces produce
una matriz comparativa (tokens/latencia/correctness/MRR) por baseline en
evals/reports/baselines-<TS>.json.

#### Scenario: comparación agente+crudo vs agente+CQE

Dado un agente ejecutando la suite de tareas de downstream-agent-eval, cuando se
compara herramientas crudas (rg+read) contra CQE, entonces se reportan tool calls,
tokens de contexto, task success y time-to-solution por modalidad.
`,
  },
  'indexing-cost-breakeven': {
    proposal: `# Indexing Cost & Break-even (review 3)

"¿Cuánto costó indexar?": T_index, T_incremental_index, RAM, disk, CPU, T_query.
Métrica clave: N_break_even = indexing_cost / (baseline per-query − CQE per-query).
Si CQE indexa 4 min y ahorra 20ms/query, necesita N queries para pagar el setup.
Ese número debe ser un resultado, no una excusa.`,
    tasks: `## Tasks — costos de indexación

- [ ] 3.1 Harness de medición: T_index, T_incremental (cambio de N archivos), RAM pico, disk, CPU por repo (t1-*, polar, dev)
- [ ] 3.2 T_query cold/warm con los mismos números por repo
- [ ] 3.3 Cálculo de N_break_even por repo contra baseline rg/fd y BM25
- [ ] 3.4 Artefacto: evals/reports/indexing-cost-<TS>.json + tabla en README
- [ ] 3.5 Umbral: documentar para qué N de queries CQE paga su setup; si N > umbral (100) en repos medianos → tarea de reducción`,
    spec: `# Indexing Cost & Break-even

## ADDED Requirements

### Requirement: el proyecto debe publicar sus costos de construcción y break-even

Se mide tiempo de indexación (full e incremental), RAM pico, disk y CPU por repo, y
se calcula N_break_even = indexing_cost / (costo por query baseline − costo por query
CQE), documentado en README.

#### Scenario: medición de recursos

Dado un repo del manifest (t1-*, polar, dev), cuando el harness mide indexación y
queries, entonces produce T_index, T_incremental, RAM/disk/CPU y N_break_even en
evals/reports/indexing-cost-<TS>.json.

#### Scenario: decisión de uso

Dado el reporte de break-even, cuando N_break_even supera el umbral documentado,
entonces el README debe indicar explícitamente "usar rg para workloads menores a N
queries".
`,
  },
  'failure-modes-where-cqe-loses': {
    proposal: `# Failure Modes: dónde CQE pierde (review 4)

Un proyecto serio demuestra dónde NO usarlo: exact filename, exact symbol, single-file
lookup, tiny repository, one-shot query → rg > CQE. La pregunta interesante es
Repository size × Query complexity × Query repetition → break-even.`,
    tasks: `## Tasks — failure modes

- [ ] 4.1 Dataset de queries "regresive" (filename exacto, símbolo exacto, single-file, tiny repo, one-shot)
- [ ] 4.2 Comparar rg/fd vs CQE en ese dataset: tokens, latencia, correctness
- [ ] 4.3 Cuantificar el overhead de CQE en casos triviales (setup, pipeline) y el umbral donde rg gana
- [ ] 4.4 Sección README "Cuándo NO usar context-query-engine" con los números
- [ ] 4.5 Umbral: si CQE pierde en >30% de los casos triviales, mitigar (ruta directa filename)`,
    spec: `# Failure Modes

## ADDED Requirements

### Requirement: documentar empíricamente los casos donde CQE pierde contra baselines simples

Se construye un dataset de queries regresivas (filename exacto, símbolo exacto,
single-file, repos pequeños, one-shot) y se mide dónde rg/fd supera a CQE en tokens,
latencia o correctness.

#### Scenario: dataset regresivo

Dado el dataset de failure modes, cuando se compara rg/fd vs CQE, entonces se produce
una tabla de resultados por categoría en evals/reports/failure-modes-<TS>.json.

#### Scenario: sección de contraindicación

Dado el reporte, cuando existen categorías donde rg gana consistentemente, entonces
el README debe listarlas explícitamente con los números.
`,
  },
  'downstream-agent-eval': {
    proposal: `# Downstream Agent Evaluation (review 5/15/16/17)

Escalera: retrieval correctness → context usefulness → task completion. El agente real
hace query→retrieve→think→inspect→modify→test→retrieve-again. Métricas: total tool calls,
context tokens, task success, time-to-solution, task success/token (y /dollar, /second).
Hipótesis a escribir explícitamente: "better selected context → less unnecessary context
→ same or better task performance" (NO "less context → better").`,
    tasks: `## Tasks — downstream eval

- [ ] 5.1 Suite de tareas de agente (5-10 tareas reales con completion medible, 2 anotadores)
- [ ] 5.2 Harness de agente: loop multi-turno (retrieve→think→inspect→modify→test) con conteo de tool calls, tokens de contexto, time-to-solution
- [ ] 5.3 Métricas downstream: task success, success/token, success/segundo (y /dólar estimado con costos LLM)
- [ ] 5.4 Comparación: agente + tools crudas vs agente + CQE (enlazado con harder-baselines 2.3)
- [ ] 5.5 Hipótesis escrita en README: "menos contexto ≠ mejor"; correcta = mejor selección SIN degradar task performance
- [ ] 5.6 Umbral: CQE ≥ crudo en task success, con menos tokens totales`,
    spec: `# Downstream Agent Evaluation

## ADDED Requirements

### Requirement: evaluar CQE por utilidad para el agente, no solo por recall

La suite de tareas mide la escalera correctness → usefulness → task completion con
loop de agente multi-turno real: tool calls, tokens de contexto, task success y
time-to-solution, comparando agente+crudo vs agente+CQE.

#### Scenario: suite de tareas

Dado el harness de agente multi-turno, cuando corre las 5-10 tareas de la suite en
modalidad cruda y CQE, entonces produce task success, tokens totales y time-to-solution
por modalidad en evals/reports/downstream-<TS>.json.

#### Scenario: hipótesis falsable

Dado el reporte downstream, cuando CQE reduce tokens pero NO mantiene o mejora task
success, entonces el veredicto es FAIL: "menos contexto" sin mantener utilidad no es
una victoria.
`,
  },
  'abstain-no-answer': {
    proposal: `# ABSTAIN: no-answer como resultado legítimo (review 6)

Un retrieval engine puede caer en search→weak match→retrieve→hallucinate relevance.
Necesita ABSTAIN como salida legítima: query→confidence→(high: retrieve | low: abstain).
Métricas: false positive retrieval, false negative retrieval, abstention precision,
coverage. Benchmarks recientes de agent retrieval encuentran calibración pobre en
escenarios sin gold answer.`,
    tasks: `## Tasks — abstain

- [ ] 6.1 Dataset no-gold: queries sin respuesta correcta en el repo (20-30 queries)
- [ ] 6.2 Señal de confianza: score agregado del plan (relevance, hits, tokens) → umbral de abstention
- [ ] 6.3 Modo ABSTAIN en engine (resultado {abstained:true, reason}) sin romper determinismo
- [ ] 6.4 Métricas: FP/FN retrieval, abstention precision, coverage sobre el dataset no-gold + gold
- [ ] 6.5 Umbral: abstention precision ≥ 0.7 con coverage ≥ 0.8 (el abstain solo cuando hay que abstener)`,
    spec: `# ABSTAIN / No-Answer

## ADDED Requirements

### Requirement: el engine debe poder ABSTAIN cuando no hay respuesta razonable

Ante queries sin gold answer en el repo, el engine devuelve {abstained:true} en vez de
resultados débiles, basado en una señal de confianza del plan. Se miden FP/FN retrieval,
abstention precision y coverage.

#### Scenario: dataset no-gold

Dado el dataset de queries sin respuesta, cuando el engine corre con abstention
activada, entonces produce la tasa de abstention correcta (coverage) y abstention
precision ≥ 0.7 en evals/reports/abstain-<TS>.json.

#### Scenario: no regresión en queries gold

Dado el dataset gold existente, cuando la abstention está activada, entonces las
queries con respuesta real NO deben abstener (coverage ≥ 0.8).
`,
  },
  'expected-utility-cost': {
    proposal: `# Expected Utility Cost Model (review 7/8)

Cost = W1·tokens + W2·latency + W3·tool_calls es un comienzo, pero no modela
uncertainty, information gain, redundancy ni downstream usefulness. Plan A (1000 tok,
95% conf) puede ser mejor que B (700 tok, 40%) si B fuerza una segunda ronda de
retrieval (3000 tok). Costo real = expected_total_cost, no immediate_cost.
Utility = P(correct)·value − token_cost − latency_cost − failure_cost.`,
    tasks: `## Tasks — expected utility

- [ ] 7.1 Función utility: P(correct|plan)·value − tokens·Wt − latency·Wl − failure_penalty·Wf (parámetros configurables)
- [ ] 7.2 Señal de incertidumbre: varianza del cardinality estimator (ya existe varianceTokens) → confianza del plan
- [ ] 7.3 Ablación en eval-optimizer: selección con utility vs selección actual (cost/quality) → regret y tokens en T1
- [ ] 7.4 Métrica expected_total_cost: simular segunda ronda si plan de baja confianza (harness downstream 5.2)
- [ ] 7.5 Umbral: utility no degrada correctness en T1 y reduce regret ≥ 10% relativo`,
    spec: `# Expected Utility Cost Model

## ADDED Requirements

### Requirement: el plan selector debe optimizar utilidad esperada, no costo inmediato

El optimizer incorpora P(correct|plan) (desde variance/confianza del estimator),
valores de contexto correcto/incorrecto y penalización de fallo, y la selección se
evalúa por regret y por expected_total_cost (incluyendo segundas rondas).

#### Scenario: ablación utility vs cost/quality

Dado eval-optimizer sobre T1, cuando se compara selección por utility contra la
selección actual, entonces se reporta regret, tokens y correctness por selector en
evals/reports/utility-<TS>.json.

#### Scenario: incertidumbre en la selección

Dado dos planes de costo similar pero confianza distinta (vía varianceTokens), cuando
el optimizer selecciona, entonces el plan de mayor confianza es preferido ceteris
paribus.
`,
  },
  'distribution-shift-testing': {
    proposal: `# Distribution Shift del Cost Model (review 9)

MAPE 1.418→0.498 es interesante pero: ¿train y test sobre la misma distribución?
Learned cardinality estimators sufren con cambios de correlación, skew y domain size.
Split exigido: train repos A/B → validation C/D → test E/F (repos distintos, lenguajes
distintos, distribuciones de query distintas).`,
    tasks: `## Tasks — distribution shift

- [ ] 9.1 Split por repo: train (t1-basic), val (t1-modular), test (polar + dev) — repos NO vistos por el cost model
- [ ] 9.2 Re-entrenar cost model solo con train; medir MAPE/P95/regret en val y test (fuera de distribución)
- [ ] 9.3 Registrar shift: MAPE_in vs MAPE_out; documentar degradación esperada
- [ ] 9.4 Hipótesis de lenguaje: entrenar solo TS, testear en repos Python (t1-modular) — ¿generaliza el cardinality?
- [ ] 9.5 Umbral: MAPE_out ≤ 2× MAPE_in; si no, tarea de regularización/feature engineering`,
    spec: `# Distribution Shift Testing

## ADDED Requirements

### Requirement: el cost model debe evaluarse en repositorios no vistos

El entrenamiento y la evaluación del cost model se separan por repositorio:
train en A/B, validation en C/D, test en E/F (incluyendo lenguajes y distribuciones
de query distintas), reportando MAPE, error P95 y regret dentro y fuera de distribución.

#### Scenario: split por repo

Dado el dataset de cardinalidad, cuando se entrena solo con t1-basic y se evalúa en
polar y dev, entonces se produce MAPE_in vs MAPE_out y regret fuera de distribución en
evals/reports/distribution-shift-<TS>.json.

#### Scenario: generalización de lenguaje

Dado el cost model entrenado solo en TypeScript, cuando se evalúa en repos Python
(t1-modular), entonces se documenta la degradación de MAPE entre lenguajes.
`,
  },
  'adversarial-workloads': {
    proposal: `# Adversarial Workload Generation (review 10)

Queries diseñadas para romper heurísticas: high-frequency symbol, ambiguous identifier,
huge fan-out, zero results, deep dependency chain, duplicate implementations, generated
code, vendor code, monorepo, polyglot. Métricas: plan regret, token explosion, false
confidence, latency. Un optimizer no se valida con queries "bonitas".`,
    tasks: `## Tasks — adversarial

- [ ] 10.1 Dataset adversarial: 10 categorías × 3 queries (30 queries) sobre repos existentes (polar + t1)
- [ ] 10.2 Harness: correr reproduce.sh sobre el dataset adversarial → regret, tokens, latencia, correctness por categoría
- [ ] 10.3 Detección de token explosion (>5× mediana de tokens del modo) y false confidence (alta confianza + fallo)
- [ ] 10.4 Artefacto: evals/reports/adversarial-<TS>.json + tabla por categoría
- [ ] 10.5 Umbral: correctness adversarial ≥ 0.8; token explosion 0 casos en queries sin match real`,
    spec: `# Adversarial Workloads

## ADDED Requirements

### Requirement: el benchmark debe incluir queries adversariales por categoría

10 categorías (high-frequency symbol, ambiguous identifier, huge fan-out, zero results,
deep dependency chain, duplicate implementations, generated code, vendor code, monorepo,
polyglot) × 3 queries, midiendo regret, token explosion, false confidence y latencia.

#### Scenario: dataset adversarial

Dado el dataset de 30 queries adversariales, cuando corre el pipeline reproducible,
entonces se produce un reporte por categoría con correctness, regret y token explosion
en evals/reports/adversarial-<TS>.json.

#### Scenario: umbral de correctness

Dado el reporte adversarial, cuando correctness < 0.8 en alguna categoría, entonces se
crea una tarea de mitigación para esa categoría específica.
`,
  },
  'model-choice-ablation': {
    proposal: `# Model Choice Ablation (review 13)

TinyBERT puede ser una distracción: si un ridge (actual), XGBoost, LightGBM o MLP gana
en latency/accuracy/memory, usar el modelo pequeño. Para señales estructuradas del
optimizer un transformer puede ser innecesariamente complejo. Tesis a demostrar:
learned signal → better plan → better context → better agent outcome (la familia de
modelo es secundaria).`,
    tasks: `## Tasks — model ablation

- [ ] 11.1 Línea base: rendimiento actual del ridge hashed-ngram (reranker + intent classifier): accuracy, MAPE, latency, RAM
- [ ] 11.2 Alternativas: MLP pequeño (numpy) y XGBoost/LightGBM si disponibles; benchmark en mismo split por repo (9.x)
- [ ] 11.3 Matriz: modelo × (accuracy, MAPE, p95 latency, RSS, ram) sobre datasets fijos
- [ ] 11.4 Decisión documentada: elegir mejor modelo por trade-off; TinyBERT solo si gana claramente o por requisito (11.10)
- [ ] 11.5 Umbral: el modelo elegido debe superar o igualar al ridge en accuracy/MAPE Y latency < 50ms`,
    spec: `# Model Choice Ablation

## ADDED Requirements

### Requirement: la elección de modelo de scoring debe ser empírica, no arquitectónica

Se comparan ridge (actual), MLP pequeño y XGBoost/LightGBM (si disponibles) en
accuracy/MAPE, latency p95, RSS y RAM sobre splits por repo fijos, y se documenta la
decisión. TinyBERT se adopta solo si gana el trade-off.

#### Scenario: matriz de modelos

Dado el split por repo de distribution-shift-testing, cuando se entrena y evalúa cada
familia de modelo, entonces se produce la matriz modelo × (accuracy, MAPE, p95 latency,
RSS, RAM) en evals/reports/model-choice-<TS>.json.

#### Scenario: decisión de adopción

Dado la matriz, cuando un modelo supera al ridge en accuracy/MAPE con latency < 50ms,
entonces se adopta y se actualiza el artifact del modelo; si no, se mantiene el ridge.
`,
  },
  'hybrid-retrieval-comparison': {
    proposal: `# Hybrid Retrieval Comparison (review 14)

Ataque inevitable: "¿por qué no BM25 + embeddings + reranker?". Respuesta experimental,
no retórica. Matriz: BM25, dense, hybrid, hybrid+rerank, CQE, CQE+hybrid, CQE+rerank.
Tesis fuerte posible: CQE ≠ retrieval algorithm; CQE = optimizer ABOVE retrieval
algorithms. Ese sería un resultado más interesante.`,
    tasks: `## Tasks — hybrid comparison

- [ ] 12.1 Inventario de implementaciones posibles sin deps nuevas (BM25 propio en node; dense vía embeddings si existe librería — sino marcar como requires-dep)
- [ ] 12.2 Matriz de experimentos: BM25 / dense / hybrid / hybrid+rerank / CQE / CQE+hybrid / CQE+rerank sobre T1/T2/dev
- [ ] 12.3 Métricas comunes: tokens, latencia, correctness, recall@k, MRR
- [ ] 12.4 Verificar la tesis "CQE = optimizer above retrieval": correr CQE con BM25 como op de retrieval de bajo nivel vs rg
- [ ] 12.5 Artefacto: evals/reports/hybrid-<TS>.json + sección README "CQE vs hybrid retrieval"
- [ ] 12.6 Umbral: CQE+hybrid no puede degradar correctness; si BM25 puro gana en un tipo de query, incorporarlo como op`,
    spec: `# Hybrid Retrieval Comparison

## ADDED Requirements

### Requirement: comparar CQE contra retrieval híbrido experimentalmente

La matriz BM25 / dense / hybrid / hybrid+reranker / CQE / CQE+hybrid / CQE+reranker
corre sobre T1, T2 y dev con métricas comunes (tokens, latencia, correctness, recall@k,
MRR), y se evalúa la tesis de CQE como optimizer por encima de algoritmos de retrieval.

#### Scenario: matriz de retrieval

Dado el harness multi-retrieval, cuando corre las 7 configuraciones sobre los
manifests, entonces produce la matriz comparativa en evals/reports/hybrid-<TS>.json.

#### Scenario: CQE sobre BM25

Dado CQE con un op de retrieval basado en BM25, cuando se compara contra CQE+rg,
entonces se documenta si el optimizer selecciona planes equivalentes (CQE = optimizer
independiente del algoritmo de retrieval subyacente).
`,
  },
};

let ok = 0;
for (const [id, files] of Object.entries(C)) {
  const dir = path.join(CH, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'proposal.md'), files.proposal);
  fs.writeFileSync(path.join(dir, 'tasks.md'), files.tasks);
  const sp = path.join(dir, 'specs', id, 'spec.md');
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, files.spec);
  ok++;
}
console.log('generados: ' + ok + '/11');
