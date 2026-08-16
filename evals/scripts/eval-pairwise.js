#!/usr/bin/env node
/**
 * evals/scripts/eval-pairwise.js — selección por preferencias pairwise (Lero).
 * Para cada task, score por plan = Σ P(plan ≻ otro) (sigmoid(diff·W) del modelo
 * pairwise); selección = argmax. Compara vs cost_only (argmin est_tokens) y
 * oracle_quality (argmax gt_hits): plan_acc, gt_hits medios, tokens, correctness.
 * Veredicto: pairwise.gt_hits >= cost_only.gt_hits y correctness sin degradación.
 * Artefacto: evals/reports/pairwise-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/ml/model/pairwise-model.json'), 'utf8'));
const { tasks } = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/reports/pairs-tasks.json'), 'utf8'));
const W = model.W;
const sig = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

const QTYPE_ORDER = ['definitions', 'references', 'filename', 'implementation', 'pattern', 'concept'];
const FEATS = ['tokens', 'est_tokens', 'latency_ms', 'gt_hits', 'exactness', 'n_results', 'recall5', 'mrr'];

function diffFeats(a, b, qt) {
  return [...QTYPE_ORDER.map((q) => (qt === q ? 1 : 0)), ...FEATS.map((f) => (a[f] ?? 0) - (b[f] ?? 0))];
}
const pWin = (a, b, qt) => sig(diffFeats(a, b, qt).reduce((s, x, i) => s + x * W[i], 0));

const rows = [];
const acc = { n: 0, plan_acc: { pairwise: 0, cost_only: 0 }, gt: { pairwise: 0, cost_only: 0 }, tokens: { pairwise: 0, cost_only: 0 }, correct: { pairwise: 0, cost_only: 0 } };

for (const t of tasks) {
  const ids = ['A', 'B', 'C'];
  const score = {};
  for (const X of ids) {
    score[X] = ids.filter((Y) => Y !== X).reduce((s, Y) => s + pWin(t.plans[X], t.plans[Y], t.query_type), 0);
  }
  const selPair = ids.slice().sort((a, b) => score[b] - score[a])[0];
  const selCost = ids.slice().sort((a, b) => (t.plans[a].est_tokens ?? 1e9) - (t.plans[b].est_tokens ?? 1e9))[0];
  const oracle = ids.slice().sort((a, b) => t.plans[b].gt_hits - t.plans[a].gt_hits || t.plans[a].tokens - t.plans[b].tokens)[0];
  const g = (id) => t.plans[id].gt_hits, toks = (id) => t.plans[id].tokens;
  acc.n += 1;
  if (selPair === oracle) acc.plan_acc.pairwise += 1;
  if (selCost === oracle) acc.plan_acc.cost_only += 1;
  acc.gt.pairwise += g(selPair); acc.gt.cost_only += g(selCost);
  acc.tokens.pairwise += toks(selPair); acc.tokens.cost_only += toks(selCost);
  acc.correct.pairwise += g(selPair) > 0 ? 1 : 0; acc.correct.cost_only += g(selCost) > 0 ? 1 : 0;
  rows.push({ id: t.id, query_type: t.query_type, oracle, sel_pairwise: selPair, sel_cost: selCost,
    score: Object.fromEntries(ids.map((i) => [i, +score[i].toFixed(3)])),
    gt: { pairwise: g(selPair), cost_only: g(selCost) }, tokens: { pairwise: toks(selPair), cost_only: toks(selCost) } });
}

const n = acc.n;
const report = {
  tasks: n,
  plan_acc: { pairwise: acc.plan_acc.pairwise / n, cost_only: acc.plan_acc.cost_only / n },
  avg_gt_hits: { pairwise: acc.gt.pairwise / n, cost_only: acc.gt.cost_only / n },
  avg_tokens: { pairwise: acc.tokens.pairwise / n, cost_only: acc.tokens.cost_only / n },
  correctness: { pairwise: acc.correct.pairwise / n, cost_only: acc.correct.cost_only / n },
  model: { holdout_acc: model.report?.holdout_acc ?? null, balanced_acc: model.report?.balanced_acc ?? null },
};
const okGt = report.avg_gt_hits.pairwise >= report.avg_gt_hits.cost_only;
const okCorrect = report.correctness.pairwise >= report.correctness.cost_only;
const verdict = { pass: okGt && okCorrect, gt: okGt, correctness: okCorrect, threshold: 'pairwise.gt_hits >= cost_only Y correctness sin degradación' };

const TS = Date.now();
const artifact = { ...report, verdict, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `pairwise-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

const f = (x) => x.toFixed(4);
console.log(`tasks: ${n} | model acc ${f(model.report?.holdout_acc ?? 0)} (bal ${f(model.report?.balanced_acc ?? 0)})`);
console.log(`  pairwise  plan_acc ${f(report.plan_acc.pairwise)}  gt ${f(report.avg_gt_hits.pairwise)}  tok ${Math.round(report.avg_tokens.pairwise)}  correct ${f(report.correctness.pairwise)}`);
console.log(`  cost_only plan_acc ${f(report.plan_acc.cost_only)}  gt ${f(report.avg_gt_hits.cost_only)}  tok ${Math.round(report.avg_tokens.cost_only)}  correct ${f(report.correctness.cost_only)}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — gt ${verdict.gt ? '✓' : '✗'} (${f(report.avg_gt_hits.cost_only)}→${f(report.avg_gt_hits.pairwise)}), correctness ${verdict.correctness ? '✓' : '✗'}`);
console.log('artefacto:', outPath);