#!/usr/bin/env node
/**
 * evals/scripts/eval-rrf.js — Typed Rank Fusion (B1).
 * baseline (score_final) vs CF_RRF=1+CF_RRF_RANK=1 (RRF multi-fuente, pesos
 * por query_type) sobre T1(32)+adv(30). Métricas correctness/gt/r5/mrr/tokens.
 * Veredicto: correctness ≥ baseline && (r5 ≥ baseline || mrr ≥ baseline).
 * Artefacto: evals/reports/rrf-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const T1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

const tasks = [...T1, ...ADV];
const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}
function recallAtK(ranked, ground, k) {
  const top = ranked.slice(0, k);
  const hits = top.filter((f) => ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f))).length;
  return ground.length ? hits / Math.min(k, ground.length) : 1;
}
function mrr(ranked, ground) {
  for (let i = 0; i < ranked.length; i++) {
    if (ground.some((g) => ranked[i] === g || ranked[i].endsWith('/' + g) || g.endsWith('/' + ranked[i]))) return 1 / (i + 1);
  }
  return 0;
}

function run(task, rrf) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
    ...(rrf ? { CF_RRF: '1', CF_RRF_RANK: '1' } : {}) };
  const t0 = Date.now();
  try {
    const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
    const j = JSON.parse(out.toString());
    const ground = groundOf(task);
    const ranked = [...new Set((j.results ?? []).map((x) => x.path))];
    return { id: task.id, repo: task.repo, gt_hits: gtHits(j.results ?? [], ground), r5: recallAtK(ranked, ground, 5),
      mrr: mrr(ranked, ground), tokens: j.stats?.tokens_used ?? 0, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { id: task.id, repo: task.repo, error: String(e.message || e).slice(0, 80) };
  }
}

const rows = [];
for (const t of tasks) {
  const base = run(t, false);
  const rrf = run(t, true);
  if (base && rrf) rows.push({ id: t.id, base, rrf });
}
const n = rows.length;
const agg = (sel) => ({
  correctness: rows.filter((r) => (r[sel].gt_hits ?? -1) > 0).length / n,
  gt: rows.reduce((a, r) => a + (r[sel].gt_hits ?? 0), 0) / n,
  r5: rows.reduce((a, r) => a + (r[sel].r5 ?? 0), 0) / n,
  mrr: rows.reduce((a, r) => a + (r[sel].mrr ?? 0), 0) / n,
  tokens: rows.reduce((a, r) => a + (r[sel].tokens ?? 0), 0) / n,
});
const b = agg('base'), f = agg('rrf');
const verdict = {
  pass: f.correctness >= b.correctness && (f.r5 >= b.r5 || f.mrr >= b.mrr),
  correctness: { base: b.correctness, rrf: f.correctness },
  r5: { base: b.r5, rrf: f.r5 }, mrr: { base: b.mrr, rrf: f.mrr },
  gt: { base: b.gt, rrf: f.gt }, tokens: { base: b.tokens, rrf: f.tokens },
};
const TS = Date.now();
const outPath = path.join(ROOT, 'evals', 'reports', `rrf-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify({ date: new Date().toISOString().slice(0, 10), tasks: n, verdict, rows }, null, 2) + '\n');

const f3 = (x) => x.toFixed(3);
console.log(`tasks: ${n}`);
console.log(`  baseline  correct ${f3(b.correctness)}  r@5 ${f3(b.r5)}  mrr ${f3(b.mrr)}  gt ${f3(b.gt)}  tok ${Math.round(b.tokens)}`);
console.log(`  rrf       correct ${f3(f.correctness)}  r@5 ${f3(f.r5)}  mrr ${f3(f.mrr)}  gt ${f3(f.gt)}  tok ${Math.round(f.tokens)}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — correct ${f3(b.correctness)}→${f3(f.correctness)}, r5 ${f3(b.r5)}→${f3(f.r5)}, mrr ${f3(b.mrr)}→${f3(f.mrr)}`);
console.log('artefacto:', outPath);