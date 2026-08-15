#!/usr/bin/env node
/**
 * evals/scripts/eval-cardinality-error.js — eval de validación para
 * adaptive-query-processing y uncertainty-aware-cost.
 * Corre el engine una vez por task (scope CF_TASKS=t1|dev|TEST), lee statistics.ndjson
 * y calcula por (operator, predicate_class): est vs actual (candidates/tokens/latency),
 * MAPE, y "reopt opportunities" (|est-actual|/est > 2 → candidato a re-optimización).
 * Output: evals/reports/cardinality-error.json + tabla console.
 * Uso: node evals/scripts/eval-cardinality-error.js [--limit N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STATS = path.join(ROOT, 'engine', 'statistics.ndjson');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const EXTRA = path.join(ROOT, 'evals/datasets/tasks-dev.json');
if (fs.existsSync(EXTRA)) TASKS.push(...JSON.parse(fs.readFileSync(EXTRA, 'utf8')));
const TEST = fs.readFileSync(path.join(ROOT, 'evals/datasets/queries-test.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const byId = Object.fromEntries(TASKS.map((t) => [t.id, t]));
const REPO_DIRS = { 't1-basic': 'evals/datasets/repos/t1-basic', 't1-modular': 'evals/datasets/repos/t1-modular', dev: '/home/nicolas/dev' };

const SCOPE = process.env.CF_TASKS ?? '';
let rows = SCOPE === 'dev'
  ? TASKS.filter((t) => t.repo === 'dev')
  : SCOPE === 't1'
    ? TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular')
    : TEST.filter((r) => byId[r.source]);
if (process.argv.includes('--limit')) rows = rows.slice(0, Number(process.argv[process.argv.indexOf('--limit') + 1]));

if (fs.existsSync(STATS)) fs.rmSync(STATS);
for (const r of rows) {
  const task = r.repo ? r : byId[r.source];
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) continue;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  try {
    execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env: { ...process.env, CF_STATS_FILE: STATS }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  } catch { /* timeout/crash: se omite, el registro stats queda parcial */ }
}

const recs = fs.existsSync(STATS) ? fs.readFileSync(STATS, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const byKey = {};
for (const r of recs) {
  const est = r.estimated, act = r.actual;
  if (!est || !act || typeof est.candidates !== 'number' || typeof act.candidates !== 'number') continue;
  const key = `${r.operator}|${r.queryClass}`;
  (byKey[key] ??= []).push({ est, act });
}
const perOp = [];
for (const [key, list] of Object.entries(byKey)) {
  const errs = list.map(({ est, act }) => est.candidates === 0 ? (act.candidates === 0 ? 0 : 1) : Math.abs(est.candidates - act.candidates) / est.candidates);
  const tokErrs = list.map(({ est, act }) => est.tokens === 0 ? (act.tokens === 0 ? 0 : 1) : Math.abs(est.tokens - act.tokens) / est.tokens);
  const mape = errs.reduce((a, b) => a + b, 0) / errs.length;
  const tokMape = tokErrs.reduce((a, b) => a + b, 0) / tokErrs.length;
  const opportunities = list.filter(({ est, act }) => est.candidates > 0 && Math.abs(est.candidates - act.candidates) / est.candidates > 2).length;
  perOp.push({ operator: key.split('|')[0], predicate_class: key.split('|')[1], samples: list.length, mape_candidates: mape, mape_tokens: tokMape, reopt_opportunities: opportunities });
}
perOp.sort((a, b) => b.mape_candidates - a.mape_candidates);
const report = { tasks: rows.length, records: recs.length, per_operator: perOp, total_reopt_opportunities: perOp.reduce((a, b) => a + b.reopt_opportunities, 0), scope: SCOPE || 'TEST' };
fs.mkdirSync(path.join(ROOT, 'evals/reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evals/reports/cardinality-error.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`tasks ${report.tasks} | records ${report.records} | scope ${report.scope}`);
for (const o of perOp) {
  console.log(`  ${o.operator}/${o.predicate_class}: MAPE cand ${(o.mape_candidates * 100).toFixed(0)}% tok ${(o.mape_tokens * 100).toFixed(0)}% reopt ${o.reopt_opportunities}/${o.samples}`);
}
