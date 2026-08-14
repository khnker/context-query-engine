#!/usr/bin/env node
/**
 * engine/optimizer.js — Cost-Based Optimizer (task 12).
 * 12.1 planes físicos candidatos por query_type
 * 12.2 cost model: cost = w1*tokens + w2*latency_ms + w3*tool_calls − w4*relevance
 * 12.3 selección: plan con menor costo estimado
 * 12.4 telemetría NDJSON (engine/telemetry.ndjson)
 * 12.5 learned mappings desde telemetría
 * Node.js ESM, stdlib SOLO.
 *
 * Uso CLI:
 *   node engine/optimizer.js '{"query_type":"definitions","target":{"kind":"symbol","name":"parseConfig"}}'
 *   node engine/optimizer.js --record '{"query_type":"definitions","tool":"search-code","tokens":200,"latency_ms":15,"results":5,"relevant":3,"satisfied":true,"cache_hit":false}'
 *   node engine/optimizer.js --learned definitions
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGINE_DIR = fileURLToPath(new URL('.', import.meta.url));
const TELEMETRY = path.join(ENGINE_DIR, 'telemetry.ndjson');

// 12.2 — tabla de costos por tool (estimaciones por op)
const COST_TABLE = {
  'search-code':      { tokens: 200, latency_ms: 15,  tool_calls: 1, relevance: 0.8  },
  'search-structure': { tokens: 300, latency_ms: 20,  tool_calls: 1, relevance: 0.9  },
  'search-semantic':  { tokens: 800, latency_ms: 150, tool_calls: 1, relevance: 0.7  },
  'assemble-context': { tokens: 50,  latency_ms: 5,   tool_calls: 1, relevance: 0.5  },
  'rg-files':         { tokens: 100, latency_ms: 10,  tool_calls: 1, relevance: 0.85 },
};

// pesos default, ajustables por env CF_W1..CF_W4
function weights() {
  return {
    w1: Number(process.env.CF_W1 ?? 0.01),
    w2: Number(process.env.CF_W2 ?? 0.001),
    w3: Number(process.env.CF_W3 ?? 1),
    w4: Number(process.env.CF_W4 ?? 10),
  };
}

function makeOp(tool, args) {
  return { tool, args: [...args], ...COST_TABLE[tool] };
}

function normalizeType(qt) {
  const t = String(qt ?? '').toLowerCase();
  if (t === 'filename') return 'filename';
  if (t === 'concept') return 'concept';
  if (t === 'pattern') return 'pattern';
  return 'definitions'; // identifier | definitions | references | usages | implementation
}

// 12.1 — planes físicos candidatos por query_type
function plansFor(queryType, target = {}) {
  const name = target.name ?? '';
  switch (normalizeType(queryType)) {
    case 'filename':
      return [
        { id: 'A', ops: [makeOp('rg-files', [name])] },
        { id: 'B', ops: [makeOp('rg-files', [name]), makeOp('search-code', [name])] },
      ];
    case 'concept':
      return [
        { id: 'A', ops: [makeOp('search-semantic', [name])] },
        { id: 'B', ops: [makeOp('search-code', [name]), makeOp('assemble-context', [])] },
        { id: 'C', ops: [makeOp('search-semantic', [name]), makeOp('search-code', [name])] },
      ];
    case 'pattern':
      return [
        { id: 'A', ops: [makeOp('search-structure', [name])] },
        { id: 'B', ops: [makeOp('search-code', [name]), makeOp('search-structure', [name])] },
      ];
    default:
      return [
        { id: 'A', ops: [makeOp('search-code', [name])] },
        { id: 'B', ops: [makeOp('search-code', [name]), makeOp('search-structure', [name])] },
        { id: 'C', ops: [makeOp('search-semantic', [name]), makeOp('search-code', [name])] },
      ];
  }
}

// 12.2 — cost model: cost = w1*tokens + w2*latency_ms + w3*tool_calls − w4*relevance (suma por op)
function planCost(ops, w) {
  let cost = 0;
  for (const op of ops) {
    cost += w.w1 * op.tokens + w.w2 * op.latency_ms + w.w3 * op.tool_calls - w.w4 * op.relevance;
  }
  return cost;
}

// 12.4 — telemetría: append NDJSON a engine/telemetry.ndjson
export function recordExecution(queryType, tool, metrics = {}) {
  fs.mkdirSync(path.dirname(TELEMETRY), { recursive: true });
  const rec = { ts: new Date().toISOString(), query_type: queryType, tool, ...metrics };
  fs.appendFileSync(TELEMETRY, JSON.stringify(rec) + '\n');
  return rec;
}

// 12.5 — learned mapping: mejor success rate por (query_type, tool) con >=3 registros
export function learnedMapping(queryType) {
  let lines = [];
  try {
    lines = fs.readFileSync(TELEMETRY, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return null; } // sin telemetría → evidencia insuficiente

  const perTool = {};
  for (const r of lines) {
    if (r.query_type !== queryType) continue;
    (perTool[r.tool] ??= []).push(r);
  }

  let best = null;
  for (const [tool, list] of Object.entries(perTool)) {
    if (list.length < 3) continue; // evidencia insuficiente → policy default manda
    const satisfied = list.filter((r) => r.satisfied).length;
    const successRate = satisfied / list.length;
    const avgTokens = list.reduce((a, r) => a + (r.tokens ?? 0), 0) / list.length;
    if (!best || successRate > best.successRate || (successRate === best.successRate && avgTokens < best.avgTokens)) {
      best = { tool, successRate, avgTokens, records: list.length };
    }
  }
  return best; // null si evidencia <3
}

// 12 — optimizar: candidatos + cost model + selección + learned override
export function optimize(logicalPlan = {}) {
  const queryType = logicalPlan.query_type ?? 'implementation';
  const target = logicalPlan.target ?? {};
  const name = target.name ?? '';
  const w = weights();

  const plans = plansFor(queryType, target).map((p) => ({
    id: p.id,
    ops: p.ops,
    cost: planCost(p.ops, w),
  }));

  // 12.3 — selección: menor costo estimado
  let selected = plans.reduce((a, b) => (b.cost < a.cost ? b : a));
  let reason = `plan ${selected.id}: menor costo estimado (${selected.cost.toFixed(3)}) para query_type "${queryType}"`;

  // 12.5 — learned mapping sobreescribe la opción default si hay evidencia (>=3 registros)
  // Si el tool aprendido ya está en el plan → se prioriza al frente (sin duplicar);
  // si no está → reemplaza la primera op (default).
  const learned = learnedMapping(queryType);
  if (learned && COST_TABLE[learned.tool] && learned.tool !== selected.ops[0].tool) {
    const oldTool = selected.ops[0].tool;
    if (selected.ops.some((o) => o.tool === learned.tool)) {
      const others = selected.ops.filter((o) => o.tool !== learned.tool);
      selected.ops = [makeOp(learned.tool, [name]), ...others.map((o) => makeOp(o.tool, [name]))];
      reason += ` | learned: ${learned.tool} priorizado sobre ${oldTool} (success_rate=${learned.successRate.toFixed(2)}, records=${learned.records})`;
    } else {
      selected.ops[0] = makeOp(learned.tool, [name]);
      reason += ` | learned: ${learned.tool} sobreescribe ${oldTool} (success_rate=${learned.successRate.toFixed(2)}, records=${learned.records})`;
    }
    selected.cost = planCost(selected.ops, w);
  }

  return { selected: selected.id, plans, reason };
}

// --- CLI ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--record') {
      const j = JSON.parse(args[1] ?? '{}');
      const { query_type, tool, ...metrics } = j;
      process.stdout.write(JSON.stringify({ ok: true, recorded: recordExecution(query_type, tool, metrics) }) + '\n');
    } else if (args[0] === '--learned') {
      process.stdout.write(JSON.stringify(learnedMapping(args[1])) + '\n');
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
