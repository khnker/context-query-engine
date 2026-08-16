#!/usr/bin/env node
/*
 * evals/scripts/eval-pairwise-runtime.js — pairwise-runtime (A1).
 * Selección runtime CF_PAIRWISE=1 (features pre-ejecución; post-hoc = 0) vs
 * default cost/quality vs oráculo FORCE_PLAN A/B/C sobre T1(32).
 * Métricas: plan_acc, gt_hits, avg_tokens, correctness.
 * Veredicto: pairwise gt_hits >= default gt_hits (la señal sobrevive la
 * falta de features post-hoc). Artefacto evals/reports/pairwise-runtime-<TS>.json
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STATS = path.join(ROOT, 'engine', 'statistics.ndjson');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const REPO_DIRS = {
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'),
};

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function run(query, repoDir, { force, pairwise }) {
  fs.rmSync(CACHE, { force: true });
  const tmp = path.join(ROOT, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: STATS,
    ...(force ? { FORCE_PLAN: force } : {}), ...(pairwise ? { CF_PAIRWISE: '1' } : {}) };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, query], { cwd: repoDir, env, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const j = JSON.parse(out.toString());
  return { latency_ms: Date.now() - t0, tokens: j.stats?.tokens_used ?? 0, results: j.results ?? [], selected: j.plan?.selected };
}

const acc = { n: 0, plan_acc: { def: 0, pw: 0 }, gt: { def: 0, pw: 0 }, tokens: { def: 0, pw: 0, oracle: 0 }, correct: { def: 0, pw: 0 } };
const records = [];
for (const t of TASKS) {
  const repoDir = REPO_DIRS[t.repo];
  if (!repoDir) continue;
  const forced = {};
  for (const id of ['A', 'B', 'C']) forced[id] = run(t.cqp, repoDir, { force: id });
  const def = run(t.cqp, repoDir, {});
  const pw = run(t.cqp, repoDir, { pairwise: true });
  const oracle = Object.keys(forced).sort((a, b) =>
    forced[a].tokens - forced[b].tokens || gtHits(forced[b].results, groundOf(t)) - gtHits(forced[a].results, groundOf(t)))[0];
  const ground = groundOf(t);
  const gd = gtHits(def.results, ground), gp = gtHits(pw.results, ground);
  acc.n += 1;
  if (def.selected === oracle) acc.plan_acc.def += 1;
  if (pw.selected === oracle) acc.plan_acc.pw += 1;
  acc.gt.def += gd; acc.gt.pw += gp;
  acc.tokens.def += def.tokens; acc.tokens.pw += pw.tokens; acc.tokens.oracle += forced[oracle].tokens;
  acc.correct.def += gd > 0 ? 1 : 0; acc.correct.pw += gp > 0 ? 1 : 0;
  records.push({ id: t.id, selected_def: def.selected, selected_pw: pw.selected, oracle, gt: { def: gd, pw: gp } });
}

const n = acc.n;
const report = {
  date: new Date().toISOString().slice(0, 10), tasks: n,
  plan_accuracy: { default: acc.plan_acc.def / n, pairwise: acc.plan_acc.pw / n },
  avg_gt_hits: { default: acc.gt.def / n, pairwise: acc.gt.pw / n },
  avg_tokens: { default: acc.tokens.def / n, pairwise: acc.tokens.pw / n, oracle: acc.tokens.oracle / n },
  correctness: { default: acc.correct.def / n, pairwise: acc.correct.pw / n },
};
const verdict = { pass: report.avg_gt_hits.pairwise >= report.avg_gt_hits.default,
  delta_gt: report.avg_gt_hits.pairwise - report.avg_gt_hits.default,
  note: 'runtime features pre-ejecucion; post-hoc (gt_hits/exactness/n_results/recall5/mrr) = 0' };

const TS = Date.now();
const outPath = path.join(ROOT, 'evals', 'reports', `pairwise-runtime-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify({ ...report, verdict, records }, null, 2) + '\n');

console.log(`tasks: ${n}`);
console.log(`  default   plan_acc ${report.plan_accuracy.default.toFixed(3)}  gt ${report.avg_gt_hits.default.toFixed(3)}  tok ${Math.round(report.avg_tokens.default)}  correct ${report.correctness.default.toFixed(3)}`);
console.log(`  pairwise  plan_acc ${report.plan_accuracy.pairwise.toFixed(3)}  gt ${report.avg_gt_hits.pairwise.toFixed(3)}  tok ${Math.round(report.avg_tokens.pairwise)}  correct ${report.correctness.pairwise.toFixed(3)}`);
console.log(`  oracle    tok ${Math.round(report.avg_tokens.oracle)}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — Δgt ${verdict.delta_gt.toFixed(3)} (${verdict.note})`);
console.log('artefacto:', outPath);