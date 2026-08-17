#!/usr/bin/env node
/**
 * evals/scripts/eval-hint.js — B12 learned-plan-steering.
 * Mide el hint (CF_HINT=1) como capa posterior vs el optimizer determinista vs
 * el oráculo FORCE_PLAN A/B/C sobre T1(32).
 * Métricas: plan_acc, gt_hits, tokens, override_rate (frecuencia real de override).
 * Verdict: gt_hits(hint) >= gt_hits(default).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, '.cache', 'engine');
const STATS = path.join(ROOT, '.tmp', 'hint-stats.ndjson');
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

function run(query, repoDir, { force, hint }) {
  fs.rmSync(CACHE, { force: true });
  const tmp = path.join(ROOT, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: STATS,
    ...(force ? { FORCE_PLAN: force } : {}), ...(hint ? { CF_HINT: '1' } : {}) };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, query], { cwd: repoDir, env, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const j = JSON.parse(out.toString());
  return { latency_ms: Date.now() - t0, tokens: j.stats?.tokens_used ?? 0, results: j.results ?? [], selected: j.plan?.selected };
}

const acc = {
  n: 0,
  plan_acc: { def: 0, hint: 0 },
  gt: { def: 0, hint: 0 },
  tokens: { def: 0, hint: 0, oracle: 0 },
  overrides: 0,
};
const records = [];
for (const t of TASKS) {
  const repoDir = REPO_DIRS[t.repo];
  if (!repoDir) continue;
  const forced = {};
  for (const id of ['A', 'B', 'C']) forced[id] = run(t.cqp, repoDir, { force: id });
  const def = run(t.cqp, repoDir, {});
  const hint = run(t.cqp, repoDir, { hint: true });
  const oracle = Object.keys(forced).sort((a, b) =>
    forced[a].tokens - forced[b].tokens || gtHits(forced[b].results, groundOf(t)) - gtHits(forced[a].results, groundOf(t)))[0];
  const ground = groundOf(t);
  const gd = gtHits(def.results, ground), gh = gtHits(hint.results, ground);
  acc.n += 1;
  if (def.selected === oracle) acc.plan_acc.def += 1;
  if (hint.selected === oracle) acc.plan_acc.hint += 1;
  if (hint.selected !== def.selected) acc.overrides += 1;
  acc.gt.def += gd;
  acc.gt.hint += gh;
  acc.tokens.def += def.tokens;
  acc.tokens.hint += hint.tokens;
  acc.tokens.oracle += forced[oracle].tokens;
  records.push({
    id: t.id,
    selected: { def: def.selected, hint: hint.selected, oracle },
    gt: { def: gd, hint: gh },
    tokens: { def: def.tokens, hint: hint.tokens, oracle: forced[oracle].tokens },
  });
}

const n = acc.n;
const report = {
  date: new Date().toISOString().slice(0, 10),
  tasks: n,
  threshold: Number(process.env.CF_HINT_THRESHOLD ?? 0.35),
  plan_accuracy: { default: acc.plan_acc.def / n, hint: acc.plan_acc.hint / n },
  avg_gt_hits: { default: acc.gt.def / n, hint: acc.gt.hint / n },
  avg_tokens: { default: acc.tokens.def / n, hint: acc.tokens.hint / n, oracle: acc.tokens.oracle / n },
  override_rate: acc.overrides / n,
};
const verdict = {
  pass: report.avg_gt_hits.hint >= report.avg_gt_hits.default,
  delta_gt: report.avg_gt_hits.hint - report.avg_gt_hits.default,
  note: 'hint = capa posterior (CF_HINT=1), umbral de confianza default 0.35; override = hint cambió la selección vs default',
};

const TS = Date.now();
const outPath = path.join(ROOT, 'evals', 'reports', `hint-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify({ ...report, verdict, records }, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));