#!/usr/bin/env node
/**
 * evals/scripts/eval-quality.js — Context Quality por nivel de presupuesto.
 * Para cada budget del engine (2k/8k/20k/30k) y cada task real (GT primary/related/
 * tests), ejecuta el engine y mide la calidad del contexto ensamblado:
 *   total_tokens     = tokens entregados (stats.tokens_used)
 *   useful_tokens    = Σ token_estimate de resultados en GT
 *   wrong_tokens     = total − useful
 *   density          = useful / total  (Information Density)
 *   file_precision   = |GT ∩ delivered| / |delivered|
 *   file_recall      = |GT ∩ delivered| / |GT|
 * Presupuesto forzado vía env CF_BUDGET (engine.js effectiveBudget).
 * Uso: CF_TASKS=dev node evals/scripts/eval-quality.js [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const EXTRA_TASKS = path.join(ROOT, 'evals/datasets/tasks-dev.json');
if (fs.existsSync(EXTRA_TASKS)) {
  TASKS.push(...JSON.parse(fs.readFileSync(EXTRA_TASKS, 'utf8')));
}
const TEST = fs
  .readFileSync(path.join(ROOT, 'evals/datasets/queries-test.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const byId = Object.fromEntries(TASKS.map((t) => [t.id, t]));
const REPO_DIRS = { 't1-basic': 'evals/datasets/repos/t1-basic', 't1-modular': 'evals/datasets/repos/t1-modular', dev: '/home/nicolas/dev' };
const BUDGETS = [2000, 8000, 20000, 30000];

function runEngine(cqp, repoDir, budget) {
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), CF_BUDGET: String(budget) };
  delete env.CF_MODEL_CMD;
  const out = execFileSync('node', [ENGINE, cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return { results: parsed.results ?? [], tokens_used: parsed.stats?.tokens_used ?? 0 };
}

const hits = (delivered, ground) => delivered.filter((f) => ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)));

const rows = process.env.CF_TASKS === 'dev'
  ? TASKS.filter((t) => t.repo === 'dev')
  : TEST.filter((r) => byId[r.source]);
if (rows.length === 0) {
  console.error('sin tasks con ground truth');
  process.exit(1);
}

const budgets = {};
for (const b of BUDGETS) {
  budgets[b] = { tasks: 0, total_tokens: 0, useful_tokens: 0, wrong_tokens: 0, density: [], file_precision: [], file_recall: [] };
}

const rowsOut = [];
for (const r of rows) {
  const task = r.repo ? r : byId[r.source];
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) continue;
  const ground = [...(task.primary ?? []), ...(task.related ?? []), ...(task.tests ?? [])];
  const perBudget = {};
  for (const b of BUDGETS) {
    const { results, tokens_used } = runEngine(task.cqp, repoDir, b);
    const delivered = results.map((x) => x.path);
    const gt = hits(delivered, ground);
    const useful = results.filter((x, i) => gt.includes(delivered[i])).reduce((a, x) => a + (x.token_estimate ?? 0), 0);
    const total = tokens_used > 0 ? tokens_used : results.reduce((a, x) => a + (x.token_estimate ?? 0), 0);
    const m = {
      total_tokens: total,
      useful_tokens: useful,
      wrong_tokens: Math.max(0, total - useful),
      density: total > 0 ? useful / total : 0,
      file_precision: delivered.length ? gt.length / delivered.length : 0,
      file_recall: ground.length ? Math.min(1, gt.length / ground.length) : 0,
      n_results: delivered.length,
    };
    perBudget[b] = m;
    const agg = budgets[b];
    agg.tasks += 1;
    agg.total_tokens += m.total_tokens;
    agg.useful_tokens += m.useful_tokens;
    agg.wrong_tokens += m.wrong_tokens;
    agg.density.push(m.density);
    agg.file_precision.push(m.file_precision);
    agg.file_recall.push(m.file_recall);
  }
  rowsOut.push({ task: task.id, budget: perBudget });
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const report = { budgets: {}, rows: rowsOut };
const p50 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
for (const [b, agg] of Object.entries(budgets)) {
  if (!agg.tasks) continue;
  const totals = rowsOut.map((r) => r.budget[b].total_tokens);
  report.budgets[b] = {
    tasks: agg.tasks,
    total_tokens: agg.total_tokens,
    useful_tokens: agg.useful_tokens,
    wrong_tokens: agg.wrong_tokens,
    median_total_tokens: p50(totals),
    exceeding_budget: totals.filter((t) => t > Number(b)).length,
    avg_density: mean(agg.density),
    avg_file_precision: mean(agg.file_precision),
    avg_file_recall: mean(agg.file_recall),
  };
}

const outFile = path.join(ROOT, 'evals/reports/quality-budget.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const f = (x) => x.toFixed(3);
  console.log(`quality por budget | tasks: ${rowsOut.length} | -> ${outFile}`);
  for (const [b, rpt] of Object.entries(report.budgets)) {
    console.log(`  budget ${String(b).padStart(5)} | total ${String(rpt.total_tokens).padStart(9)} tok | median ${String(rpt.median_total_tokens).padStart(8)} | >budget ${String(rpt.exceeding_budget).padStart(3)}/${rpt.tasks} | density ${f(rpt.avg_density)} | p@file ${f(rpt.avg_file_precision)} | r@file ${f(rpt.avg_file_recall)}`);
  }
}
