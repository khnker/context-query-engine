#!/usr/bin/env node
/**
 * evals/scripts/eval-disagreement.js — retriever-disagreement (cambio v1.7).
 * Hipótesis: el desacuerdo entre fuentes de retrieval (lexical/structural/semantic/
 * graph) correlaciona con P(GT missing) → señal de activación de adquisición
 * adicional sin entrenar modelo.
 * Por query: engine con CF_DISAGREEMENT_FILE → snapshot {agreement_rate,
 * rank_dispersion, top1_top2_margin, candidate_density, per_source}.
 * Análisis: median-split high/low agreement → P(gt_miss|low) vs P(gt_miss|high).
 * Verdict 2.1: P(gt_miss|low) > P(gt_miss|high) con n≥8 por bucket.
 * Uso: node evals/scripts/eval-disagreement.js [--adv] [--limit N]
 *   (CF_TASKS=t1 default; CF_TASKS=dev → dev tasks)
 * Artefacto: evals/reports/disagreement-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const DEV = fs.existsSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'), 'utf8')) : [];
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', dev: path.resolve(ROOT, '..'),
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };

const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;
const WITH_ADV = process.argv.includes('--adv');

let tasks;
if (process.env.CF_TASKS === 'dev') {
  tasks = DEV;
} else {
  tasks = TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
  if (WITH_ADV) tasks = tasks.concat(ADV.filter((t) => ['huge-fanout', 'monorepo', 'polyglot', 'duplicate-implementations', 'zero-results'].includes(t.category)));
}
if (LIMIT) tasks = tasks.slice(0, LIMIT);

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

function run(task, i) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const snapFile = path.join(tmp, `.disag-${i}.ndjson`);
  fs.rmSync(snapFile, { force: true });
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
    CF_DISAGREEMENT_FILE: snapFile, CF_DISAGREE_ALL: '1' };
  const t0 = Date.now();
  let out;
  try {
    out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  } catch (e) {
    return { id: task.id, error: String(e.message || e).slice(0, 80) };
  }
  const j = JSON.parse(out.toString());
  let snap = null;
  try {
    const lines = fs.readFileSync(snapFile, 'utf8').split('\n').filter(Boolean);
    snap = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch { /* sin snapshot */ }
  const ground = groundOf(task);
  return {
    id: task.id, group: task.category || (task.repo.startsWith('t1') ? 't1' : 'dev'),
    gt_hits: gtHits(j.results ?? [], ground), n_ground: ground.length,
    tokens: j.stats?.tokens_used ?? 0, plan: j.plan?.selected ?? null,
    agreement_rate: snap?.agreement_rate ?? null, margin: snap?.top1_top2_margin ?? null,
    density: snap?.candidate_density ?? null,
    n_sources: snap?.sources ?? null, n_pool: snap?.n_pool ?? null,
  };
}

const rows = [];
for (let i = 0; i < tasks.length; i++) {
  const r = run(tasks[i], i);
  if (r) rows.push(r);
}

const withAgr = rows.filter((r) => r.agreement_rate != null && r.error == null);
const noSignal = rows.filter((r) => r.agreement_rate == null && r.error == null);
const sorted = [...withAgr].sort((a, b) => a.agreement_rate - b.agreement_rate);
const med = sorted.length ? sorted[Math.floor(sorted.length / 2)].agreement_rate : null;
const low = sorted.filter((r) => r.agreement_rate < med);
const high = sorted.filter((r) => r.agreement_rate >= med);
const miss = (arr) => arr.filter((r) => r.gt_hits === 0).length / Math.max(1, arr.length);
const pMissLow = miss(low), pMissHigh = miss(high);
const bucketOk = low.length >= 8 && high.length >= 8;

// correlación: gt_miss por bin de agreement (deciles visuales)
const bins = [0, 0.25, 0.5, 0.75, 1.01].map((x, i, a) => {
  const lo = x, hi = a[i + 1];
  const inBin = hi ? withAgr.filter((r) => r.agreement_rate >= lo && r.agreement_rate < hi) : [];
  return hi ? { range: `${lo.toFixed(2)}-${hi.toFixed(2)}`, n: inBin.length, miss_rate: inBin.length ? miss(inBin) : null } : null;
}).filter(Boolean);

const verdict = {
  pass: bucketOk && pMissLow > pMissHigh,
  p_miss_low: +pMissLow.toFixed(3), p_miss_high: +pMissHigh.toFixed(3),
  difference: +(pMissLow - pMissHigh).toFixed(3), median_agreement: med,
  n_low: low.length, n_high: high.length, buckets_ok: bucketOk,
  hypothesis: 'P(gt_miss | low agreement) > P(gt_miss | high agreement)',
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: rows.length,
  with_snapshot: withAgr.length, no_signal: noSignal.length, no_signal_miss: noSignal.filter((r) => r.gt_hits === 0).length,
  verdict, bins, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `disagreement-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${rows.length} | con snapshot: ${withAgr.length} | median agreement: ${med}`);
console.log('bins (agreement → miss rate):');
for (const b of bins) console.log(`  [${b.range}]  n=${b.n}  miss=${b.miss_rate == null ? 'n/a' : b.miss_rate.toFixed(3)}`);
console.log(`low  (<med): n=${low.length}  P(gt_miss)=${pMissLow.toFixed(3)}`);
console.log(`high (>=med): n=${high.length}  P(gt_miss)=${pMissHigh.toFixed(3)}`);
console.log(`veredicto: ${verdict.pass ? 'PASS — hipótesis sostenida' : 'FAIL — no sostenida'} (Δ ${(pMissLow - pMissHigh).toFixed(3)}, buckets_ok=${bucketOk})`);
for (const r of rows.filter((r) => r.error)) console.log(`  ERROR ${r.id}: ${r.error}`);
console.log('artefacto:', outPath);