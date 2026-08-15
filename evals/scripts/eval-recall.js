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

const CF_SCOPE = process.env.CF_TASKS ?? '';
const rows = CF_SCOPE === 'dev'
  ? TASKS.filter((t) => t.repo === 'dev')
  : CF_SCOPE === 't1'
    ? TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular')
    : TEST.filter((r) => byId[r.source]);
if (process.argv.includes('--limit')) {
  rows.length = Math.min(rows.length, Number(process.argv[process.argv.indexOf('--limit') + 1]));
}
if (rows.length === 0) {
  console.error('sin tasks reales en el split de test');
  process.exit(1);
}
const modelCmd = process.env.CF_MODEL_CMD ?? null;
const RUNS = Math.max(1, Number(process.env.CF_RUNS ?? 1));
const WARMUP = Math.max(0, Number(process.env.CF_WARMUP ?? 0));
const SEED = Number(process.env.CF_SEED ?? 42);
const RAW_OUT = process.env.CF_RAW_OUT ?? null;
const rawStream = RAW_OUT ? fs.createWriteStream(RAW_OUT, { flags: 'a' }) : null;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, seed) {
  const rnd = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const report = { k: KS, model: modelCmd ?? '(ninguno — comparación heurístico vs heurístico)', rows: [] };
const agg = { heuristic: { r5: [], r10: [], mrr: [] }, rerank: { r5: [], r10: [], mrr: [] } };

const runOrder = shuffle([...rows], SEED);
for (const r of runOrder) {
  const task = r.repo ? r : byId[r.source];
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) continue;
  const ground = [...(task.primary ?? []), ...(task.related ?? []), ...(task.tests ?? [])];
  for (let run = 0; run < RUNS + WARMUP; run++) {
    const isWarmup = run < WARMUP;
    const modes = run % 2 === 0 ? [null, modelCmd] : [modelCmd, null];
    for (const mc of modes) {
      if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
      const t0 = Date.now();
      const parsed = JSON.parse(execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env: { ...process.env, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...(mc ? { CF_MODEL_CMD: mc } : {}) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));
      const latencyMs = Date.now() - t0;
      const ranked = [...new Set((parsed.results ?? []).map((x) => x.path))];
      const hits = ground.filter((g) => ranked.some((f) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)));
      const mode = mc ? 'rerank' : 'heuristic';
      const k5 = recallAtK(ranked, ground, 5);
      const k10 = recallAtK(ranked, ground, 10);
      const m = mrr(ranked, ground);
      if (!isWarmup) {
        agg[mode].r5.push(k5);
        agg[mode].r10.push(k10);
        agg[mode].mrr.push(m);
      }
      const row = { query_id: task.id, query: task.query ?? task.cqp, mode, run: isWarmup ? `warmup-${run}` : run - WARMUP, tokens: parsed.stats?.tokens_used ?? 0, latency_ms: latencyMs, correct: hits.length > 0, gt_hits: hits.length, n_ground: ground.length, recall5: k5, recall10: k10, mrr: m, selected_plan: parsed.plan?.selected ?? null };
      if (!isWarmup) report.rows.push({ ...row, task: task.id });
      if (rawStream) rawStream.write(JSON.stringify(row) + '\n');
    }
  }
}
if (rawStream) rawStream.end();

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
