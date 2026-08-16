#!/usr/bin/env node
/*
 * evals/scripts/eval-quality-policy.js — quality-aware selection (change 06)
 * Simulación OFFLINE de escalación sobre el artefacto congelado
 * selection-policy-<TS>.json (32 tasks, planes A/B/C forzados).
 *
 * Política: corre planes en orden de costo estimado (est_tokens asc); tras cada
 * plan, si señal de calidad observada < θ → escala al siguiente (tokens se suman,
 * gt_hits/r5 = max; el pool FUSIONADO produce al menos el mejor de los corridos).
 * Señales: exactness (runtime-observable sin GT) | gt_hits (techo, requiere GT).
 * Frontera objetivo (task 6.2): gt ≥ 0.9×oracle_quality CON tokens ≤ 2.0×cost_only.
 * Artefacto: evals/reports/quality-policy-<TS>.json
 * Uso: node evals/scripts/eval-quality-policy.js [--in evals/reports/selection-policy-<TS>.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = process.argv.includes('--in')
  ? path.join(ROOT, process.argv[process.argv.indexOf('--in') + 1])
  : fs.readdirSync(path.join(ROOT, 'evals/reports')).map((f) => path.join(ROOT, 'evals/reports', f))
      .filter((f) => /selection-policy-.*\.json$/.test(f)).sort().pop();
const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const TASKS = data.perTask;

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const summarize = (agg) => ({
  avg_tokens: +mean(agg.tokens).toFixed(1),
  avg_gt_hits: +mean(agg.gt).toFixed(3),
  coverage: +mean(agg.cov).toFixed(3),
  recall5: +mean(agg.r5).toFixed(3),
});
const orderByEst = (t) => Object.entries(t.plans).sort((a, b) => a[1].est_tokens - b[1].est_tokens);

function runPolicy(policyFn) {
  const agg = { tokens: [], gt: [], cov: [], r5: [] };
  let escalations = 0;
  const detail = [];
  for (const t of TASKS) {
    const r = policyFn(t);
    agg.tokens.push(r.tokens); agg.gt.push(r.gt);
    agg.cov.push(r.gt > 0 ? 1 : 0); agg.r5.push(r.r5);
    if (r.plansRun > 1) { escalations += 1; detail.push({ id: t.id, plans_run: r.plansRun, chosen: r.chosen }); }
  }
  return { ...summarize(agg), escalations, escalations_detail: detail.slice(0, 12) };
}

const costOnly = runPolicy((t) => {
  const [id, p] = orderByEst(t)[0];
  return { tokens: p.tokens, gt: p.gt_hits, r5: p.recall5, plansRun: 1, chosen: id };
});
const oracleQuality = runPolicy((t) => {
  const [id, p] = Object.entries(t.plans).sort((a, b) => b[1].gt_hits - a[1].gt_hits || a[1].tokens - b[1].tokens)[0];
  return { tokens: p.tokens, gt: p.gt_hits, r5: p.recall5, plansRun: 1, chosen: id };
});

function escalation(theta, signal) {
  return runPolicy((t) => {
    let tok = 0, gt = 0, r5 = 0, plansRun = 0, chosen = null;
    for (const [id, p] of orderByEst(t)) {
      tok += p.tokens; gt = Math.max(gt, p.gt_hits); r5 = Math.max(r5, p.recall5);
      plansRun += 1; chosen = id;
      const sig = signal === 'exactness' ? p.exactness : signal === 'n_results' ? p.n_results : p.gt_hits;
      if (sig >= theta) break;
    }
    return { tokens: tok, gt, r5, plansRun, chosen };
  });
}

const sweepExactness = [0, 0.5, 0.7, 0.8, 0.9, 1.0].map((θ) => ({ theta: θ, signal: 'exactness', ...escalation(θ, 'exactness') }));
const sweepGt = [0, 1, 2, 3, 4, 5].map((θ) => ({ theta: θ, signal: 'gt_hits', ...escalation(θ, 'gt_hits') }));
const sweepN = [0, 1, 2, 3, 4, 5].map((θ) => ({ theta: θ, signal: 'n_results', ...escalation(θ, 'n_results') }));

// 6.2 — frontera: mejor política exactness con gt ≥ 0.9×oracle CON tokens ≤ 2.0×cost_only
const targetGt = oracleQuality.avg_gt_hits * 0.9;
const tokenCap = costOnly.avg_tokens * 2.0;
const candidates = sweepExactness.filter((p) => p.avg_gt_hits >= targetGt && p.avg_tokens <= tokenCap)
  .sort((a, b) => b.avg_gt_hits - a.avg_gt_hits);
const best = candidates[0] ?? null;
const verdict = {
  pass: best !== null,
  target: { gt_hits_90pct_oracle: +targetGt.toFixed(3), tokens_cap_2x_cost_only: +tokenCap.toFixed(1) },
  best_policy: best,
  frontier: sweepExactness.map((p) => ({ theta: p.theta, tokens: p.avg_tokens, gt_hits: p.avg_gt_hits, escalations: p.escalations })),
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), source: SRC, tasks: TASKS.length, cost_only: costOnly, oracle_quality: oracleQuality, sweep_exactness: sweepExactness, sweep_gt_hits: sweepGt, sweep_n_results: sweepN, verdict };
const outPath = path.join(ROOT, 'evals', 'reports', `quality-policy-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

const row = (p) => `θ=${String(p.theta).padEnd(4)} tok ${String(Math.round(p.avg_tokens)).padEnd(6)} gt ${p.avg_gt_hits.toFixed(3)} cov ${p.coverage.toFixed(3)} r5 ${p.recall5.toFixed(3)} escal ${p.escalations}`;
console.log(`tasks: ${TASKS.length} | fuente: ${SRC}`);
console.log(`cost_only      ${row({ theta: '-', ...costOnly })}`);
console.log(`oracle_quality ${row({ theta: '-', ...oracleQuality })}`);
console.log('--- sweep exactness ---');
for (const p of sweepExactness) console.log('  ', row(p));
console.log('--- sweep gt_hits (techo) ---');
for (const p of sweepGt) console.log('  ', row(p));
console.log('--- sweep n_results ---');
for (const p of sweepN) console.log('  ', row(p));
if (best) {
  console.log(`MEJOR POLÍTICA: exactness θ=${best.theta} → gt ${best.avg_gt_hits} (target ${targetGt.toFixed(3)}) @ tokens ${best.avg_tokens} (cap ${tokenCap.toFixed(1)})`);
  console.log('escalaciones:', best.escalations_detail.map((e) => `${e.id}→${e.chosen}(${e.plans_run})`).join(' '));
} else {
  console.log(`veredicto FAIL — ninguna política exactness alcanza gt ${targetGt.toFixed(3)} con tokens ≤ ${tokenCap.toFixed(1)}`);
}
console.log('artefacto:', outPath);