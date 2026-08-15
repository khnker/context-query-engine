#!/usr/bin/env node
/**
 * evals/scripts/eval-recall.js — 12.4 recall@k: reranker vs rank heurístico.
 * Toma las tasks reales que cayeron en el split de test (queries-test.jsonl),
 * ejecuta el engine dos veces por query (sin modelo = heurístico; con CF_MODEL_CMD
 * = reranker) y compara recall@k (k=5,10) contra el ground truth (primary/related/tests).
 * Modelo-agnóstico: sirve para el stub actual y para TinyBERT real después.
 * Node.js ESM, stdlib SOLO.
 *
 * Uso: node evals/scripts/eval-recall.js [--k 5,10] [--json]
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
const KS = [5, 10];
const REPO_DIRS = { 't1-basic': 'evals/datasets/repos/t1-basic', 't1-modular': 'evals/datasets/repos/t1-modular', dev: '/home/nicolas/dev' };

function runEngine(cqp, repoDir, modelCmd) {
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson') };
  if (modelCmd) env.CF_MODEL_CMD = modelCmd;
  else delete env.CF_MODEL_CMD;
  const out = execFileSync('node', [ENGINE, cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return parsed.results ?? [];
}

function recallAtK(ranked, ground, k) {
  const top = ranked.slice(0, k);
  const hits = top.filter((f) => ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f))).length;
  return ground.length ? hits / Math.min(k, ground.length) : 1;
}

function mrr(ranked, ground) {
  for (let i = 0; i < ranked.length; i++) {
    if (ground.some((g) => ranked[i] === g || ranked[i].endsWith('/' + g) || g.endsWith('/' + ranked[i]))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

const rows = process.env.CF_TASKS === 'dev'
  ? TASKS.filter((t) => t.repo === 'dev')
  : TEST.filter((r) => byId[r.source]);
if (rows.length === 0) {
  console.error('sin tasks reales en el split de test');
  process.exit(1);
}
const modelCmd = process.env.CF_MODEL_CMD ?? null;

const report = { k: KS, model: modelCmd ?? '(ninguno — comparación heurístico vs heurístico)', rows: [] };
const agg = { heuristic: { r5: [], r10: [], mrr: [] }, rerank: { r5: [], r10: [], mrr: [] } };

for (const r of rows) {
  const task = r.repo ? r : byId[r.source];
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) continue;
  const ground = [...(task.primary ?? []), ...(task.related ?? []), ...(task.tests ?? [])];
  const rankedH = [...new Set(runEngine(task.cqp, repoDir, null).map((x) => x.path))];
  const rankedR = [...new Set(runEngine(task.cqp, repoDir, modelCmd).map((x) => x.path))];
  const h5 = recallAtK(rankedH, ground, 5);
  const h10 = recallAtK(rankedH, ground, 10);
  const r5 = recallAtK(rankedR, ground, 5);
  const r10 = recallAtK(rankedR, ground, 10);
  const mrrH = mrr(rankedH, ground);
  const mrrR = mrr(rankedR, ground);
  agg.heuristic.r5.push(h5);
  agg.heuristic.r10.push(h10);
  agg.heuristic.mrr.push(mrrH);
  agg.rerank.r5.push(r5);
  agg.rerank.r10.push(r10);
  agg.rerank.mrr.push(mrrR);
  report.rows.push({ task: task.id, n_ground: ground.length, heuristic: { r5: h5, r10: h10, mrr: mrrH }, rerank: { r5: r5, r10: r10, mrr: mrrR } });
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
report.summary = {
  tasks: report.rows.length,
  model: modelCmd ?? null,
  heuristic: { recall5: mean(agg.heuristic.r5), recall10: mean(agg.heuristic.r10), mrr: mean(agg.heuristic.mrr) },
  rerank: { recall5: mean(agg.rerank.r5), recall10: mean(agg.rerank.r10), mrr: mean(agg.rerank.mrr) },
};
report.summary.delta5 = report.summary.rerank.recall5 - report.summary.heuristic.recall5;
report.summary.delta10 = report.summary.rerank.recall10 - report.summary.heuristic.recall10;
report.summary.deltaMrr = report.summary.rerank.mrr - report.summary.heuristic.mrr;

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const f = (x) => x.toFixed(3);
  console.log(`tasks: ${report.summary.tasks} | k=5,10 | modelo: ${report.summary.model}`);
  console.log(`  heurístico   r@5 ${f(report.summary.heuristic.recall5)}  r@10 ${f(report.summary.heuristic.recall10)}  mrr ${f(report.summary.heuristic.mrr)}`);
  console.log(`  reranker     r@5 ${f(report.summary.rerank.recall5)}  r@10 ${f(report.summary.rerank.recall10)}  mrr ${f(report.summary.rerank.mrr)}  (Δ5 ${f(report.summary.delta5)}, Δ10 ${f(report.summary.delta10)}, Δmrr ${f(report.summary.deltaMrr)})`);
}
