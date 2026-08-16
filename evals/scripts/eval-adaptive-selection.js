#!/usr/bin/env node
/**
 * evals/scripts/eval-adaptive-selection.js — adaptive-plan-selection (05).
 * Baseline (default) vs CF_ADAPTIVE=1 sobre adversarial (30) + T1 (32).
 * Hipótesis: belief state → adquisición pre-fuse recupera flood cases
 * (adv-po-30 'main') y no degrada correctness en T1.
 * Uso: node evals/scripts/eval-adaptive-selection.js [--limit N]
 * Artefacto: evals/reports/adaptive-selection-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8')).filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;

const tasks = [...TASKS, ...ADV];
const list = LIMIT ? tasks.slice(0, LIMIT) : tasks;
const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

function run(task, adaptive) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
    ...(adaptive ? { CF_ADAPTIVE: '1' } : {}) };
  const t0 = Date.now();
  let j;
  try {
    j = JSON.parse(execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString());
  } catch (e) {
    return { id: task.id, error: String(e.message || e).slice(0, 80) };
  }
  return {
    id: task.id, group: task.category || 't1',
    gt_hits: gtHits(j.results ?? [], groundOf(task)),
    tokens: j.stats?.tokens_used ?? 0, latency_ms: Date.now() - t0,
    plan: j.plan?.selected ?? null,
    adaptive: j.stats?.adaptive ?? null,
    belief: j.stats?.belief ?? null,
  };
}

const rows = [];
for (const t of list) {
  const b = run(t, false);
  const a = run(t, true);
  if (b && a) rows.push({ ...b, mode_adaptive: a });
}

const agg = { baseline: { correct: 0, gt: 0, tok: 0 }, adaptive: { correct: 0, gt: 0, tok: 0 } };
const recovered = [];
for (const r of rows) {
  const a = r.mode_adaptive;
  agg.baseline.correct += r.gt_hits > 0 ? 1 : 0;
  agg.baseline.gt += r.gt_hits; agg.baseline.tok += r.tokens;
  agg.adaptive.correct += a.gt_hits > 0 ? 1 : 0;
  agg.adaptive.gt += a.gt_hits; agg.adaptive.tok += a.tokens;
  if (a.gt_hits > r.gt_hits && (a.adaptive?.actions?.length ?? 0) > 0) recovered.push({ id: r.id, baseline: r.gt_hits, adaptive: a.gt_hits, actions: a.adaptive.actions });
}
const n = rows.length;
const report = {
  date: new Date().toISOString().slice(0, 10), tasks: n,
  baseline: { correctness: agg.baseline.correct / n, gt_hits_mean: +(agg.baseline.gt / n).toFixed(3), tokens_mean: Math.round(agg.baseline.tok / n) },
  adaptive: { correctness: agg.adaptive.correct / n, gt_hits_mean: +(agg.adaptive.gt / n).toFixed(3), tokens_mean: Math.round(agg.adaptive.tok / n) },
  recovered, flood_actions: rows.filter((r) => r.mode_adaptive.adaptive?.flood).length,
};

const okCorrectness = report.adaptive.correctness >= report.baseline.correctness;
const okRecovery = recovered.length >= 1;
const verdict = { pass: okCorrectness && okRecovery, correctness_ok: okCorrectness, recovery_ok: okRecovery, recovered_n: recovered.length };

const TS = Date.now();
const artifact = { ...report, verdict, rows: rows.map((r) => ({ ...r, mode_adaptive: { gt_hits: r.mode_adaptive.gt_hits, tokens: r.mode_adaptive.tokens, adaptive: r.mode_adaptive.adaptive } })) };
const outPath = path.join(ROOT, 'evals', 'reports', `adaptive-selection-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

const f3 = (x) => x.toFixed(3);
console.log(`tasks: ${n}`);
console.log(`  baseline  correct ${f3(report.baseline.correctness)}  gt ${report.baseline.gt_hits_mean}  tok ${report.baseline.tokens_mean}`);
console.log(`  adaptive  correct ${f3(report.adaptive.correctness)}  gt ${report.adaptive.gt_hits_mean}  tok ${report.adaptive.tokens_mean}  flood ${report.flood_actions}`);
console.log(`recovered: ${recovered.length}`);
for (const r of recovered) console.log(`  ${r.id}  gt ${r.baseline}->${r.adaptive}  actions [${r.actions.join(',')}]`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — correctness ${okCorrectness ? '✓' : '✗'} (${f3(report.baseline.correctness)}->${f3(report.adaptive.correctness)}), recovery ${okRecovery ? '✓' : '✗'} (${recovered.length})`);
console.log('artefacto:', outPath);