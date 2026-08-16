#!/usr/bin/env node
/**
 * evals/scripts/eval-bypass.js — cheap-query-bypass.
 * Gate: CF_BYPASS=1 → filename inequívoco + repo < CF_BYPASS_MAX_FILES(500) →
 * rg-files + fuse directo, sin optimize().
 * Datasets: failure-modes (24: exact-filename/tiny-repo = clase trivial) + T1 (32, no-regresión).
 * Métricas: correctness, tokens, latencia, bypass_rate. Verdict: correctness igual Y
 * latencia <= baseline en la clase trivial, sin regresión en T1.
 * Artefacto: evals/reports/bypass-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const FAIL = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/failure-modes.json'), 'utf8'));
const T1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const REPO_DIRS = { 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'), polar: '/home/nicolas/dev/polar' };
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

function run(task, bypass) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
    ...(bypass ? { CF_BYPASS: '1' } : {}) };
  const t0 = Date.now();
  try {
    const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
    const j = JSON.parse(out.toString());
    return { id: task.id, repo: task.repo, category: task.category ?? 't1',
      gt_hits: gtHits(j.results ?? [], groundOf(task)), tokens: j.stats?.tokens_used ?? 0,
      latency_ms: Date.now() - t0, bypassed: j.stats?.bypassed === true, error: null };
  } catch (e) {
    return { id: task.id, repo: task.repo, category: task.category ?? 't1', gt_hits: 0, tokens: 0,
      latency_ms: Date.now() - t0, bypassed: false, error: String(e.message || e).slice(0, 60) };
  }
}

function agg(rows) {
  const n = rows.length || 1;
  return {
    correctness: rows.filter((r) => r.gt_hits > 0).length / rows.length,
    gt_hits: rows.reduce((a, r) => a + r.gt_hits, 0) / rows.length,
    tokens: rows.reduce((a, r) => a + r.tokens, 0) / n,
    latency_ms: rows.reduce((a, r) => a + r.latency_ms, 0) / n,
  };
}

const failList = LIMIT ? FAIL.slice(0, LIMIT) : FAIL;
const t1List = LIMIT ? [] : T1; // T1 completo solo sin --limit
const base = { fail: [], t1: [] }, byp = { fail: [], t1: [] };
for (const t of failList) {
  const b = run(t, false), p = run(t, true);
  if (b && p) { base.fail.push(b); byp.fail.push(p); }
}
for (const t of t1List) {
  const b = run(t, false), p = run(t, true);
  if (b && p) { base.t1.push(b); byp.t1.push(p); }
}

const aBase = agg(base.fail), aByp = agg(byp.fail);
const t1Base = agg(base.t1), t1Byp = agg(byp.t1);
const bypassRate = byp.fail.filter((r) => r.bypassed).length / Math.max(1, byp.fail.length);
const verdict = {
  trivial_correctness_ok: aByp.correctness === aBase.correctness,
  trivial_latency_ok: aByp.latency_ms <= aBase.latency_ms,
  t1_no_regression: t1List.length ? t1Byp.correctness === t1Base.correctness && t1Byp.tokens <= t1Base.tokens * 1.05 : null,
  pass: aByp.correctness === aBase.correctness && aByp.latency_ms <= aBase.latency_ms && (t1List.length ? t1Byp.correctness === t1Base.correctness : true),
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), trivial_tasks: failList.length,
  t1_tasks: t1List.length, bypass_rate: bypassRate,
  trivial: { baseline: aBase, bypass: aByp }, t1: { baseline: t1Base, bypass: t1Byp }, verdict,
  rows: byp.fail.map((p) => ({ id: p.id, bypassed: p.bypassed, gt: p.gt_hits, latency: p.latency_ms })) };
const outPath = path.join(ROOT, 'evals', 'reports', `bypass-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

const f = (x) => x.toFixed(3);
console.log(`trivial (${failList.length}): baseline correct ${f(aBase.correctness)} lat ${Math.round(aBase.latency_ms)}ms tok ${Math.round(aBase.tokens)} | bypass correct ${f(aByp.correctness)} lat ${Math.round(aByp.latency_ms)}ms tok ${Math.round(aByp.tokens)} | rate ${bypassRate.toFixed(2)}`);
if (t1List.length) console.log(`T1 (${t1List.length}): baseline correct ${f(t1Base.correctness)} tok ${Math.round(t1Base.tokens)} | bypass correct ${f(t1Byp.correctness)} tok ${Math.round(t1Byp.tokens)}`);
console.log(`verdict: ${verdict.pass ? 'PASS' : 'FAIL'} — correct ${verdict.trivial_correctness_ok} lat ${verdict.trivial_latency_ok}${t1List.length ? ' t1 ' + verdict.t1_no_regression : ''}`);
for (const r of byp.fail.filter((r) => !r.bypassed)) console.log(`  NO-BYPASS ${r.id} (${r.category})`);
console.log('artefacto:', outPath);