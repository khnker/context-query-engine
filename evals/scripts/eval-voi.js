#!/usr/bin/env node
/**
 * evals/scripts/eval-voi.js — information-acquisition-voi (B7).
 * Baseline vs CF_VOI=1 (ordenar por VoI + podar ops sin valor esperado) en T1.
 * Métricas: correctness, gt_hits, tokens, latency, pruned, voi_by_op.
 * Veredicto: correctness_voi >= correctness_base && tokens_voi <= tokens_base*1.05.
 * Artefacto: evals/reports/voi-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const REPO_DIRS = { 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'), 't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
const gtHits = (results, ground) => results.filter((r) => {
  const f = (r.path || '').replace(/^\.\//, '');
  return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
}).length;

const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

function run(task, voi) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo]);
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...(voi ? { CF_VOI: '1' } : {}) };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env, encoding: 'utf8', timeout: 60000 });
  const j = JSON.parse(out.toString());
  const ground = groundOf(task);
  return {
    gt_hits: gtHits(j.results ?? [], ground), n_ground: ground.length,
    tokens: j.stats?.tokens_used ?? 0, latency_ms: Date.now() - t0,
    correct: gtHits(j.results ?? [], ground) > 0,
    pruned: j.stats?.voi?.pruned?.length ?? 0,
    voi_by_op: j.stats?.voi?.voi_by_op ?? null,
  };
}

const base = [], voi = [];
for (const t of TASKS) {
  try { base.push(run(t, false)); } catch (e) { base.push({ error: String(e).slice(0, 60) }); }
  try { voi.push(run(t, true)); } catch (e) { voi.push({ error: String(e).slice(0, 60) }); }
}
const ok = (r) => !r.error;
const mean = (a, k) => a.filter(ok).reduce((s, r) => s + (r[k] ?? 0), 0) / Math.max(1, a.filter(ok).length);
const sum = (a, k) => a.filter(ok).reduce((s, r) => s + (r[k] ?? 0), 0);

const agg = (a) => ({
  tasks: a.filter(ok).length, correctness: a.filter(ok).filter((r) => r.correct).length / Math.max(1, a.filter(ok).length),
  gt_hits: mean(a, 'gt_hits'), tokens: mean(a, 'tokens'), latency_ms: mean(a, 'latency_ms'),
  pruned_total: sum(a, 'pruned'),
});
const baseAgg = agg(base), voiAgg = agg(voi);
const prunedOps = new Set();
for (const r of voi) if (r.voi_by_op) for (const k of Object.keys(r.voi_by_op)) prunedOps.add(`${k}:${r.voi_by_op[k]}`);

const verdict = {
  pass: voiAgg.correctness >= baseAgg.correctness && voiAgg.tokens <= baseAgg.tokens * 1.05,
  correctness: { base: baseAgg.correctness, voi: voiAgg.correctness },
  tokens: { base: baseAgg.tokens, voi: voiAgg.tokens },
  details: `pruned_total ${voiAgg.pruned_total} (ops: ${[...prunedOps].slice(0, 8).join(', ') || 'ninguna'})`,
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: TASKS.length, base: baseAgg, voi: voiAgg, verdict, rows: TASKS.map((t, i) => ({ id: t.id, base: base[i], voi: voi[i] })) };
const outPath = path.join(ROOT, 'evals', 'reports', `voi-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

const f = (x) => x.toFixed(3);
console.log(`tasks: ${TASKS.length}`);
console.log(`  base  correct ${f(baseAgg.correctness)}  gt ${f(baseAgg.gt_hits)}  tok ${Math.round(baseAgg.tokens)}  lat ${Math.round(baseAgg.latency_ms)}ms`);
console.log(`  voi   correct ${f(voiAgg.correctness)}  gt ${f(voiAgg.gt_hits)}  tok ${Math.round(voiAgg.tokens)}  lat ${Math.round(voiAgg.latency_ms)}ms  pruned ${voiAgg.pruned_total}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.details}`);
console.log('artefacto:', outPath);