#!/usr/bin/env node
/*
 * evals/scripts/eval-flood-boost.js — fuse-flood-boost (A3).
 * 4 configs sobre adv(30)+T1(32): baseline | CF_FLOOD_BOOST=0.2 |
 * CF_ADAPTIVE=1 | CF_ADAPTIVE=1+CF_FLOOD_BOOST=0.2.
 * Objetivo: recovery de adv-po-30 (flood rg sobre 'main') sin regresión T1.
 * Artefacto: evals/reports/flood-boost-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const T1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'), 't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function run(t, envs) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[t.repo]);
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: path.join(ROOT, '.tmp'), CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...envs };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, t.cqp], { cwd: repoDir, env, encoding: 'utf8', timeout: 90000 });
  const j = JSON.parse(out.toString());
  return { tokens: j.stats?.tokens_used ?? 0, results: j.results ?? [], latency_ms: Date.now() - t0 };
}

const CONFIGS = {
  baseline: {},
  boost: { CF_FLOOD_BOOST: '0.2' },
  adaptive: { CF_ADAPTIVE: '1' },
  adaptive_boost: { CF_ADAPTIVE: '1', CF_FLOOD_BOOST: '0.2' },
};
const tasks = [...ADV, ...T1];
const acc = Object.fromEntries(Object.keys(CONFIGS).map((c) => [c, { correct: 0, gt: 0, tok: 0 }]));
const perTask = {};
for (const t of tasks) {
  perTask[t.id] = {};
  const ground = groundOf(t);
  for (const [c, envs] of Object.entries(CONFIGS)) {
    const r = run(t, envs);
    const g = gtHits(r.results, ground);
    acc[c].correct += g > 0 ? 1 : 0;
    acc[c].gt += g;
    acc[c].tok += r.tokens;
    perTask[t.id][c] = { gt: g, tokens: r.tokens };
  }
}

const n = tasks.length;
const report = {};
for (const [c, a] of Object.entries(acc)) {
  report[c] = { correctness: +(a.correct / n).toFixed(3), avg_gt: +(a.gt / n).toFixed(3), avg_tokens: Math.round(a.tok / n) };
}
const po30 = perTask['adv-po-30'] ?? null;
const t1n = T1.length;
const t1Correct = {};
for (const c of Object.keys(CONFIGS)) {
  t1Correct[c] = T1.filter((t) => perTask[t.id][c].gt > 0).length / t1n;
}
const verdict = {
  pass: !!po30 && po30.adaptive_boost.gt > 0 && po30.adaptive_boost.gt >= po30.baseline.gt && t1Correct.adaptive_boost === t1Correct.baseline,
  po30: po30, t1_correctness: t1Correct,
  note: 'objetivo: adaptive+boost rescata adv-po-30 (flood rg sobre main) sin regresion T1',
};

const TS = Date.now();
const outPath = path.join(ROOT, 'evals', 'reports', `flood-boost-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify({ date: new Date().toISOString().slice(0, 10), tasks: n, report, verdict, per_task: perTask }, null, 2) + '\n');

for (const [c, r] of Object.entries(report)) {
  console.log(`  ${c.padEnd(14)} correct ${r.correctness}  gt ${r.avg_gt}  tok ${r.avg_tokens}`);
}
console.log(`adv-po-30:`, JSON.stringify(po30));
console.log(`T1 correctness:`, JSON.stringify(t1Correct));
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'}`);
console.log('artefacto:', outPath);