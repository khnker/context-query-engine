#!/usr/bin/env node
/**
 * evals/scripts/eval-soundex.js — soundex-fallback (B17).
 * Gate: CF_SOUNDEX=1 → tras fusión, si 0 filas y query_type ∈
 * {definitions,references,implementation,filename,symbol}, segunda pasada
 * fonética sobre el target contra identificadores del repo.
 * Dataset: evals/datasets/soundex.json (7 typos reales T1 + 2 control FP).
 * Métricas: recall OFF vs ON (gt_hits), fp_rate (control: 0 resultados con ON),
 * tokens, latencia. Verdict: PASS si recall_gain > 0 Y fp_rate === 0.
 * Artefacto: evals/reports/soundex-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/soundex.json'), 'utf8'));
const REPO_DIRS = {
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'),
  polar: '/home/nicolas/dev/polar',
};

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function run(task, soundex) {
  const repoDir = path.resolve(REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const tmp = path.join(repoDir, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
    ...(soundex ? { CF_SOUNDEX: '1' } : {}) };
  const t0 = Date.now();
  try {
    const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
    const j = JSON.parse(out.toString());
    return { id: task.id, category: task.category, repo: task.repo,
      gt_hits: gtHits(j.results ?? [], groundOf(task)), n_results: (j.results ?? []).length,
      soundex_triggered: j.stats?.soundex?.triggered === true,
      tokens: j.stats?.tokens_used ?? 0, latency_ms: Date.now() - t0, error: null };
  } catch (e) {
    return { id: task.id, category: task.category, repo: task.repo, gt_hits: 0, n_results: 0,
      soundex_triggered: false, tokens: 0, latency_ms: Date.now() - t0, error: String(e.message ?? e) };
  }
}

const off = [];
const on = [];
for (const t of TASKS) {
  const a = run(t, false);
  const b = run(t, true);
  if (a) off.push({ ...a, symbol: t.symbol });
  if (b) on.push({ ...b, symbol: t.symbol });
}

const agg = (arr, key) => arr.length ? arr.reduce((s, r) => s + (r[key] ?? 0), 0) / arr.length : 0;
const recall = (arr) => arr.filter((r) => r.gt_hits > 0).length / Math.max(1, arr.filter((r) => r.category === 'typo').length);
const fpTasks = on.filter((r) => r.category === 'fp');
const fpRate = fpTasks.length ? fpTasks.filter((r) => r.n_results === 0 && r.gt_hits === 0).length / fpTasks.length : 0;
const typoOn = on.filter((r) => r.category === 'typo');
const typoOff = off.filter((r) => r.category === 'typo');
const recallOff = typoOff.filter((r) => r.gt_hits > 0).length / Math.max(1, typoOff.length);
const recallOn = typoOn.filter((r) => r.gt_hits > 0).length / Math.max(1, typoOn.length);
const recallGain = recallOn - recallOff;

const report = {
  date: new Date().toISOString().slice(0, 10),
  tasks: TASKS.length,
  recall: { off: recallOff, on: recallOn, gain: recallGain },
  fp_rate: fpRate,
  avg_tokens: { off: agg(off, 'tokens'), on: agg(on, 'tokens') },
  avg_latency_ms: { off: agg(off, 'latency_ms'), on: agg(on, 'latency_ms') },
  soundex_triggered_on: on.filter((r) => r.soundex_triggered).length,
  details: { off, on },
};
const verdict = { pass: recallGain > 0 && fpRate === 1, note: 'recall_gain>0 && fp_rate(0 FP)==1' };
const TS = Date.now();
const outPath = path.join(ROOT, 'evals', 'reports', `soundex-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify({ ...report, verdict }, null, 2) + '\n');

console.log(JSON.stringify({ ...report, verdict }, null, 2));
console.log(`ARTEFACTO: ${outPath}`);
