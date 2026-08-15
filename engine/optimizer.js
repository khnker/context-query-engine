#!/usr/bin/env node
/**
 * engine/optimizer.js — Cost-Based Optimizer (change optimizer-advanced).
 * D12 statistics store: agrega telemetría por (tool, predicate_class)
 * D13 cardinality estimator: est_candidates por op, refinado post-ejecución
 * D15 plan rewriting: reorden barato/selectivo primero (restricción topológica)
 * D16 cost/quality split: utility = quality / cost
 * Node.js ESM, stdlib SOLO.
 *
 * Uso CLI:
 *   node engine/optimizer.js '{"query_type":"definitions","target":{"kind":"symbol","name":"parseConfig"}}'
 *   node engine/optimizer.js --record '{"query_type":"definitions","tool":"search-code","tokens":200,"latency_ms":15,"results":5,"relevant":3,"satisfied":true,"cache_hit":false}'
 *   node engine/optimizer.js --learned definitions
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load, confidence, estimateCandidates as statsEstimate } from './statistics.js';

const ENGINE_DIR = fileURLToPath(new URL('.', import.meta.url));
const TELEMETRY = path.join(ENGINE_DIR, 'telemetry.ndjson');

// costos base por tool (D16: base_cost + base_relevance; cardinalidad se estima aparte)
const COST_TABLE = {
  'search-code':      { tokens: 200, latency_ms: 15,  tool_calls: 1, relevance: 0.8  },
  'search-structure': { tokens: 300, latency_ms: 20,  tool_calls: 1, relevance: 0.9  },
  'search-semantic':  { tokens: 800, latency_ms: 150, tool_calls: 1, relevance: 0.7  },
  'assemble-context': { tokens: 50,  latency_ms: 5,   tool_calls: 1, relevance: 0.5  },
  'rg-files':         { tokens: 100, latency_ms: 10,  tool_calls: 1, relevance: 0.85 },
  'follow':           { tokens: 300, latency_ms: 25,  tool_calls: 1, relevance: 0.6  },
  'include':          { tokens: 200, latency_ms: 20,  tool_calls: 1, relevance: 0.4  },
  'git-log':          { tokens: 300, latency_ms: 150, tool_calls: 1, relevance: 0.6  },
  'bm25':             { tokens: 120, latency_ms: 60,  tool_calls: 1, relevance: 0.45 },
};

// D13 — cardinalidad default por clase de predicado (sin stats)
const CARD_DEFAULTS = { identifier: 5, filename: 3, pattern: 20, concept: 100, symbol: 15, repo_map: 1 };

// D16 — CostModel: w1·tokens + w2·latency + w3·tool_calls (env CF_COST_1..3)
function costWeights() {
  return {
    w1: Number(process.env.CF_COST_1 ?? 0.01),
    w2: Number(process.env.CF_COST_2 ?? 0.001),
    w3: Number(process.env.CF_COST_3 ?? 1),
  };
}

// D16 — QualityModel: q1·relevance + q2·coverage + q3·confidence (env CF_QUALITY_1..3)
function qualityWeights() {
  return {
    q1: Number(process.env.CF_QUALITY_1 ?? 10),
    q2: Number(process.env.CF_QUALITY_2 ?? 5),
    q3: Number(process.env.CF_QUALITY_3 ?? 1),
  };
}

// D13 — clase de predicado derivada de query_type + target.kind
export function predicateClass(queryType, target = {}) {
  const t = String(queryType ?? '').toLowerCase();
  const kind = String(target.kind ?? '').toLowerCase();
  if (t === 'filename' || kind === 'file') return 'filename';
  if (t === 'concept') return 'concept';
  if (t === 'pattern') return 'pattern';
  if (t === 'repo_map') return 'repo_map';
  if (t === 'symbol' || ['symbol', 'function', 'class', 'constant'].includes(kind)) return 'symbol';
  return 'identifier'; // definitions | references | usages | implementation
}

// D12 — statistics store: agrega telemetría por (tool, predicate_class)
export function statsStore() {
  let lines = [];
  try {
    lines = fs.readFileSync(TELEMETRY, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return new Map(); }
  const byKey = new Map();
  for (const r of lines) {
    const pc = r.predicate_class ?? r.query_type ?? 'identifier';
    const key = `${r.tool}|${pc}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const store = new Map();
  for (const [key, list] of byKey) {
    if (list.length < 3) continue; // evidencia insuficiente → policy default manda
    const satisfied = list.filter((r) => r.satisfied).length;
    const tokensSorted = [...list].sort((a, b) => (a.tokens ?? 0) - (b.tokens ?? 0));
    const p95 = tokensSorted[Math.floor(tokensSorted.length * 0.95)] ?? tokensSorted[tokensSorted.length - 1];
    store.set(key, {
      avg_candidates: list.reduce((a, r) => a + (r.results ?? 0), 0) / list.length,
      p95_tokens: p95 ? (p95.tokens ?? 0) : 0,
      avg_latency_ms: list.reduce((a, r) => a + (r.latency_ms ?? 0), 0) / list.length,
      success_rate: satisfied / list.length,
      records: list.length,
    });
  }
  return store;
}

// D13 — estimación de cardinalidad por clase de predicado (promedio ponderado por records)
export function estimateCandidates(predClass, store) {
  let sum = 0, n = 0;
  for (const [key, s] of store) {
    if (key.endsWith(`|${predClass}`)) { sum += s.avg_candidates * s.records; n += s.records; }
  }
  if (n > 0) return sum / n;
  return CARD_DEFAULTS[predClass] ?? 20;
}

// D12 — telemetría: append NDJSON a engine/telemetry.ndjson (incluye predicate_class)
export function recordExecution(queryType, tool, metrics = {}, predClass = queryType) {
  fs.mkdirSync(path.dirname(TELEMETRY), { recursive: true });
  const rec = { ts: new Date().toISOString(), query_type: queryType, predicate_class: predClass, tool, ...metrics };
  fs.appendFileSync(TELEMETRY, JSON.stringify(rec) + '\n');
  return rec;
}

// Deprecado (change optimizer-statistics): la lógica de aprendizaje pasó a statistics.js
// (confidence blend). Se mantiene como export por compatibilidad.
export function learnedMapping() {
  return load();
}

function normalizeType(qt) {
  const t = String(qt ?? '').toLowerCase();
  if (t === 'filename') return 'filename';
  if (t === 'concept') return 'concept';
  if (t === 'pattern') return 'pattern';
  return 'definitions'; // identifier | definitions | references | usages | implementation
}

// 12.1 — planes físicos candidatos por query_type (+ FOLLOW/INCLUDE del logical plan)
function plansFor(queryType, target = {}, relations = [], inclusions = []) {
  const name = target.name ?? '';
  const kw = String(name).split(/\s+/)[0] || name;
  let base;
  const useConcept = normalizeType(queryType) === 'concept' || target.kind === 'concept';
  switch (useConcept ? 'concept' : normalizeType(queryType)) {
    case 'filename':
      base = [
        { id: 'A', ops: [{ tool: 'rg-files', args: [name] }] },
        { id: 'B', ops: [{ tool: 'rg-files', args: [name] }, { tool: 'search-code', args: [name] }] },
      ];
      break;
    case 'concept':
      base = [
        { id: 'A', ops: [{ tool: 'search-semantic', args: [name] }] },
        { id: 'B', ops: [{ tool: 'search-code', args: [kw] }, { tool: 'assemble-context', args: [] }] },
        { id: 'C', ops: [{ tool: 'search-semantic', args: [name] }, { tool: 'search-code', args: [kw] }] },
      ];
      break;
    case 'pattern':
      base = [
        { id: 'A', ops: [{ tool: 'search-structure', args: [name] }] },
        { id: 'B', ops: [{ tool: 'search-code', args: [name] }, { tool: 'search-structure', args: [name] }] },
      ];
      break;
    default:
      base = [
        { id: 'A', ops: [{ tool: 'search-code', args: [name] }] },
        { id: 'B', ops: [{ tool: 'search-code', args: [name] }, { tool: 'search-structure', args: [name] }] },
        { id: 'C', ops: [{ tool: 'search-semantic', args: [name] }, { tool: 'search-code', args: [name] }] },
      ];
  }
  // D14 — relations/inclusions del logical plan ya NO se descartan
  const tail = [];
  if (relations.length) tail.push({ tool: 'follow', args: [], relations });
  if (inclusions.length) tail.push({ tool: 'include', args: [], inclusions });
  // D33 — git-log: concept con semántica de historia (nivel 6 de evidencia)
  if (target.kind === 'concept' && /recent|change|histor|modif|diff|log/i.test(target.name)) {
    const pathTok = (target.name.split(/\s+/).find((w) => w.includes('.'))) || null;
    tail.push({ tool: 'git-log', args: pathTok ? [pathTok] : [], keyword: pathTok ? null : target.name });
  }
  return base.map((p) => ({ id: p.id, ops: [...p.ops, ...tail] }));
}

function makeOp(tool, args, est) {
  const base = COST_TABLE[tool] ?? { tokens: 200, latency_ms: 15, tool_calls: 1, relevance: 0.8 };
  return { tool, args: [...args], ...base, est_candidates: est };
}

// D16 — costo por op: base + penalización por cardinalidad estimada
function opCost(op, cw) {
  const tokens = (op.tokens ?? 200) + 0.05 * (op.est_candidates ?? 1);
  return cw.w1 * tokens + cw.w2 * (op.latency_ms ?? 15) + cw.w3 * (op.tool_calls ?? 1);
}

function planCost(ops, cw) {
  return ops.reduce((a, op) => a + opCost(op, cw), 0);
}

// D16 — calidad por plan: relevance + coverage + confidence
function planQuality(ops, qw, confidence) {
  const relevance = ops.reduce((a, op) => a + (op.relevance ?? 0), 0);
  const coverage = ops.length;
  return qw.q1 * relevance + qw.q2 * coverage + qw.q3 * (confidence ?? 0.5);
}

// D15 — reescritura: SEARCH barato/selectivo primero; FOLLOW/INCLUDE/fusión tras SEARCH
function rewritePlan(ops) {
  const search = [];
  const tail = [];
  for (const op of ops) {
    if (op.tool === 'follow' || op.tool === 'include' || op.tool === 'git-log' || op.tool === 'assemble-context') tail.push(op);
    else search.push(op);
  }
  search.sort((a, b) =>
    (a.tokens ?? 0) + 0.05 * (a.est_candidates ?? 1) - ((b.tokens ?? 0) + 0.05 * (b.est_candidates ?? 1)));
  return [...search, ...tail];
}

// 12 — optimizar: candidatos + estimator + rewriting + utility = quality / cost
// D15b — reordenamiento por éxito aprendido: stats[`${tool}|${queryType}`] con
// n>20 y successRate>=0.8 → mueve la tool de mejor successRate al frente de los SEARCH,
// respetando topología (FOLLOW/INCLUDE/assemble-context quedan después del primer SEARCH).
const SEARCH_TOOLS = new Set(['search-code', 'search-structure', 'search-semantic', 'rg-files']);

function reorderBySuccess(ops, stats, queryType) {
  const idx = ops.map((op, i) => (SEARCH_TOOLS.has(op.tool) ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 2) return ops;
  const eligible = idx.filter((i) => {
    const s = stats.get(`${ops[i].tool}|${queryType}`);
    return s && s.n > 20 && s.successRate >= 0.8;
  });
  if (eligible.length < 2) return ops;
  let best = eligible[0];
  for (let i = 1; i < eligible.length; i++) {
    if (stats.get(`${ops[eligible[i]].tool}|${queryType}`).successRate > stats.get(`${ops[best].tool}|${queryType}`).successRate) {
      best = eligible[i];
    }
  }
  if (best === idx[0]) return ops;
  const next = [...ops];
  [next[idx[0]], next[best]] = [next[best], next[idx[0]]];
  return next;
}

// 13.6 — cost model aprendido opcional: CF_MODEL_CMD sirve 'estimate-cardinality'
// (evals/ml/classify.mjs). Con memo por (tool|queryClass|scope|est) para no
// spawnear por cada variante de plan. Fallo/ausencia → null → heurístico.
const cardCache = new Map();
function modelEstimate(tool, queryClass, scope, heur) {
  const cmd = process.env.CF_MODEL_CMD;
  if (!cmd) return null;
  const key = `${tool}|${queryClass}|${scope}|${heur}`;
  if (cardCache.has(key)) return cardCache.get(key);
  const [bin, ...args] = cmd.split(/\s+/);
  let out = null;
  try {
    const raw = execFileSync(bin, [...args, 'estimate-cardinality', JSON.stringify({
      operator: tool, queryClass, scope, est_candidates: heur,
    })], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const r = JSON.parse(raw);
    if (r && Number.isFinite(r.candidates) && r.candidates >= 0) out = Math.round(r.candidates);
  } catch { /* modelo ausente/roto → heurístico */ }
  cardCache.set(key, out);
  return out;
}

// expected-utility-cost — CF_UTILITY=1: selección por utilidad esperada
// EU = P(correct|plan)·value − tokens·Wt − latency·Wl − (1−P)·failure_penalty·Wf
// P(correct) desde varianceTokens del estimator (7.2): var pequeña → confianza alta.
function euConfig() {
  return {
    value: Number(process.env.CF_UTIL_VALUE ?? 1000),
    wt: Number(process.env.CF_UTIL_WT ?? 0.02),
    wl: Number(process.env.CF_UTIL_WL ?? 0.002),
    penalty: Number(process.env.CF_UTIL_PENALTY ?? 500),
    wf: Number(process.env.CF_UTIL_WF ?? 0.5),
  };
}

function planPCorrect(ops, queryType, stats) {
  // P(correct) desde varianceTokens del estimator, promediada sobre los ops del
  // plan (no solo el primario): si todos los ops son estables → confianza alta.
  let wsum = 0, nw = 0;
  for (const op of ops) {
    const e = stats.get(`${op.tool}|${queryType}`);
    if (!e || e.n < 5) continue;
    const varNorm = e.varianceTokens / (1 + (e.p50Tokens || 1) ** 2);
    wsum += 1 / (1 + varNorm);
    nw += 1;
  }
  if (!nw) return 0.8; // sin evidencia → prior
  return Math.max(0.1, Math.min(0.99, wsum / nw));
}

function planEU(ops, p, cfg) {
  const tokens = ops.reduce((a, o) => a + (o.tokens ?? 0), 0);
  const latency = ops.reduce((a, o) => a + (o.latency_ms ?? 0), 0);
  return p * cfg.value - tokens * cfg.wt - latency * cfg.wl - (1 - p) * cfg.penalty * cfg.wf;
}

export function optimize(logicalPlan = {}) {
  const queryType = logicalPlan.query_type ?? 'implementation';
  const target = logicalPlan.target ?? {};
  const name = target.name ?? '';
  const predClass = predicateClass(queryType, target);
  const store = statsStore(); // telemetría D12 legacy (se conserva)
  const stats = load();       // aprendizaje por confianza (optimizer-statistics)
  const cw = costWeights();
  const qw = qualityWeights();
  const confidence = logicalPlan.confidence ?? 0.5;
  const euMode = process.env.CF_UTILITY === '1';
  const euCfg = euConfig();

  const plans = plansFor(queryType, target, logicalPlan.relations ?? [], logicalPlan.inclusions ?? [])
    .flatMap((p) => {
      const ops = p.ops.map((op) => {
        const heur = statsEstimate(queryType, logicalPlan.scope ?? '', stats, op.tool);
        const mEst = modelEstimate(op.tool, queryType, logicalPlan.scope ?? '', heur);
        const m = makeOp(op.tool, op.args ?? [name], mEst ?? heur);
        if (op.relations) m.relations = op.relations;
        if (op.inclusions) m.inclusions = op.inclusions;
        return m;
      });
      // D15b — reordenar SEARCH ops por éxito aprendido (solo con evidencia sólida)
      const reordered = reorderBySuccess(ops, stats, queryType);
      const rewritten = rewritePlan(reordered);
      const variants = [reordered, rewritten];
      return variants.map((v, i) => {
        const cost = planCost(v, cw);
        const quality = planQuality(v, qw, confidence);
        const pc = euMode ? planPCorrect(v, queryType, stats) : null;
        return {
          id: p.id + (i ? 'r' : ''),
          ops: v,
          cost,
          quality,
          utility: cost > 0 ? quality / cost : Number.POSITIVE_INFINITY,
          eu: pc !== null ? planEU(v, pc, euCfg) : null,
          p_correct: pc,
        };
      });
    });

  // expected-utility-cost — selección por EU (CF_UTILITY=1) vs cost/quality (default)
  const selected = euMode
    ? plans.reduce((a, b) => (b.eu > a.eu ? b : a))
    : plans.reduce((a, b) => (b.utility > a.utility ? b : a));
  const reason = euMode
    ? `plan ${selected.id}: EU ${selected.eu.toFixed(1)} (P ${selected.p_correct.toFixed(2)}·${euCfg.value} − ${selected.cost.toFixed(2)}) para query_type "${queryType}" pred_class "${predClass}"`
    : `plan ${selected.id}: utility ${selected.utility.toFixed(3)} ` +
      `(quality ${selected.quality.toFixed(2)} / cost ${selected.cost.toFixed(3)}) ` +
      `para query_type "${queryType}" pred_class "${predClass}"`;

  return { selected: selected.id, plans, reason, pred_class: predClass };
}

// --- CLI ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--record') {
      const j = JSON.parse(args[1] ?? '{}');
      const { query_type, tool, predicate_class, ...metrics } = j;
      process.stdout.write(JSON.stringify({ ok: true, recorded: recordExecution(query_type, tool, metrics, predicate_class ?? query_type) }) + '\n');
    } else if (args[0] === '--learned') {
      const pc = predicateClass(args[1]);
      const store = statsStore();
      let best = null;
      for (const [key, s] of store) {
        if (!key.endsWith(`|${pc}`)) continue;
        const tool = key.split('|')[0];
        if (!best || s.success_rate > best.success_rate || (s.success_rate === best.success_rate && s.p95_tokens < best.p95_tokens)) {
          best = { tool, ...s };
        }
      }
      process.stdout.write(JSON.stringify(best) + '\n');
    } else if (args[0]) {
      process.stdout.write(JSON.stringify(optimize(JSON.parse(args[0]))) + '\n');
    } else {
      throw new Error('uso: node engine/optimizer.js <logicalPlanJSON> | --record <recordJSON> | --learned <queryType>');
    }
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(1);
  }
}
