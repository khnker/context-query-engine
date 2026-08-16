#!/usr/bin/env node
/**
 * evals/scripts/eval-adaptive-exec.js — B8 adaptive-query-execution.
 * Baseline vs CF_ADAPTIVE_EXEC=1 sobre T1(32) + adversarial(30): replan
 * mid-execution (reordenar resto por VoI con stats actualizadas; pruned → skip)
 * + upsert por path en adquisición (fix A3). Métricas: correctness/gt_hits/
 * tokens/latency/replanned/pruned. Veredicto: parity correctness && tokens ≤
 * 1.05×base && latency ≤ 1.5×base.
 * Artefacto: evals/reports/adaptive-exec-<TS>.json
 * Node.js ESM, stdlib SOLO. Uso: node evals/scripts/eval-adaptive-exec.js [--limit N]
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
const REPO_DIRS = { polar: '/home/nicolas/dev/polar',
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;

const scope = process.env.CF_TASKS ?? 'all';
const tasks = scope === 't1' ? TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular')
  : scope === 'adv' ? ADV
  : TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular').concat(ADV);
const list = LIMIT ? tasks.slice(0, LIMIT) : tasks;
const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);

function run(task, adaptive) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: path.join(ROOT, '.tmp'),
    CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
    ...(adaptive ? { CF_ADAPTIVE_EXEC: '1' } : {}) };
  const t0 = Date.now();
  try {
    const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
    const j = JSON.parse(out.toString());
    const ground = groundOf(task);
    const hits = j.results.filter((r) => {
      const f = (r.path || '').replace(/^\.\//, '');
      return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
    }).length;
    return { id: task.id, hits: Math.min(1, hits), gt: hits, tokens: j.stats?.tokens_used ?? 0,
      latency: Date.now() - t0, replanned: j.stats?.replanned ?? null, pruned: j.stats?.voi?.pruned?.length ?? 0 };
  } catch (e) {
    return { id: task.id, error: String(e.message || e).slice(0, 80) };
  }
}

const base = [], adapt = [];
for (const [ti, t] of list.entries()) {
  if (ti % 10 === 0) console.error(`progress ${ti}/${list.length}`);

  const b = run(t, false);
  const a = run(t, true);
  if (b && a && !b.error && !a.error) { base.push(b); adapt.push(a); }
  else if (b?.error) console.error('ERR base', t.id, b.error);
  else if (a?.error) console.error('ERR adapt', t.id, a.error);
}
const agg = (arr) => ({
  n: arr.length,
  correctness: arr.filter((r) => r.hits > 0).length / arr.length,
  gt: arr.reduce((x, r) => x + r.gt, 0) / arr.length,
  tokens: arr.reduce((x, r) => x + r.tokens, 0) / arr.length,
  latency: arr.reduce((x, r) => x + r.latency, 0) / arr.length,
  replanned: arr.filter((r) => r.replanned).length,
  pruned: arr.reduce((x, r) => x + r.pruned, 0),
});
const A = agg(base), B = agg(adapt);
const verdict = {
  pass: B.correctness >= A.correctness && B.tokens <= A.tokens * 1.05 && B.latency <= A.latency * 1.5,
  correctness: { base: A.correctness, adaptive: B.correctness },
  tokens: { base: Math.round(A.tokens), adaptive: Math.round(B.tokens) },
  latency: { base: Math.round(A.latency), adaptive: Math.round(B.latency) },
  replanned: B.replanned, pruned: B.pruned,
};
const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: A.n, baseline: A, adaptive: B, verdict,
  replan_examples: adapt.filter((r) => r.replanned).slice(0, 5).map((r) => ({ id: r.id, replanned: r.replanned })) };
const outPath = path.join(ROOT, 'evals', 'reports', `adaptive-exec-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${A.n}`);
console.log(`  baseline  correct ${A.correctness.toFixed(3)}  gt ${A.gt.toFixed(2)}  tok ${Math.round(A.tokens)}  lat ${Math.round(A.latency)}ms`);
console.log(`  adaptive  correct ${B.correctness.toFixed(3)}  gt ${B.gt.toFixed(2)}  tok ${Math.round(B.tokens)}  lat ${Math.round(B.latency)}ms  replanned ${B.replanned}  pruned ${B.pruned}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'}`);
console.log('artefacto:', outPath);