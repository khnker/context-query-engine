#!/usr/bin/env node
/**
 * evals/scripts/eval-hybrid.js — matriz de retrieval (change hybrid-retrieval-comparison).
 * Configs: bm25 / hybrid / hybrid_rerank / cqe (baseline) / cqe_rerank.
 * dense = requires-dep (sin librería de embeddings instalada; documentado, no corre).
 * Métricas por modo: correctness (gt_hits>0), recall@5/@10, MRR, tokens, latency.
 * Artefacto: evals/reports/hybrid-<TS>.json + veredicto (hybrid.correctness >= cqe).
 * Node.js ESM, stdlib SOLO.
 *
 * Uso: node evals/scripts/eval-hybrid.js [--limit N]
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

const rerankerModel = path.join(ROOT, 'evals', 'ml', 'model', 'reranker-model.json');
const modelCmd = process.env.CF_MODEL_CMD ?? (fs.existsSync(rerankerModel) ? `node ${path.join(ROOT, 'evals', 'ml', 'classify.mjs')}` : null);
const SEED = Number(process.env.CF_SEED ?? 42);

// 12.2 — matriz: 6/7 configs corren (dense = requires-dep, documentado)
const MODES = [
  { id: 'bm25', env: { CF_RETRIEVAL: 'bm25' }, label: 'BM25 puro' },
  { id: 'hybrid', env: { CF_RETRIEVAL: 'hybrid' }, label: 'CQE+hybrid (BM25+plan)' },
  { id: 'hybrid_rerank', env: { CF_RETRIEVAL: 'hybrid' }, label: 'CQE+hybrid+rerank', needsModel: true },
  { id: 'cqe', env: {}, label: 'CQE (baseline)' },
  { id: 'cqe_rerank', env: {}, label: 'CQE+rerank', needsModel: true },
].filter((m) => !m.needsModel || modelCmd);

const stats = (a) => {
  if (!a.length) return { mean: 0, median: 0, p95: 0 };
  const s = [...a].sort((x, y) => x - y);
  const median = s[Math.floor(s.length / 2)];
  const p95 = s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
  return { mean: a.reduce((x, y) => x + y, 0) / a.length, median, p95 };
};

const runOrder = shuffle([...rows], SEED);
const perMode = Object.fromEntries(MODES.map((m) => [m.id, { correct: 0, r5: [], r10: [], mrr: [], tokens: [], latency: [], gt: [], plans: new Set() }]));

for (const r of runOrder) {
  const task = r.repo ? r : byId[r.source];
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) continue;
  const ground = [...(task.primary ?? []), ...(task.related ?? []), ...(task.tests ?? [])];
  // alternar orden de modos por query para cancelar drift
  const order = MODES.map((m, i) => (runOrder.indexOf(r) + i) % MODES.length);
  for (const mi of order) {
    const m = MODES[mi];
    if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
    const env = {
      ...process.env,
      CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
      ...m.env,
      ...(m.needsModel ? { CF_MODEL_CMD: modelCmd } : {}),
    };
    const t0 = Date.now();
    const parsed = JSON.parse(execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));
    const latencyMs = Date.now() - t0;
    const ranked = [...new Set((parsed.results ?? []).map((x) => x.path))];
    const hits = ground.filter((g) => ranked.some((f) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)));
    const a = perMode[m.id];
    a.correct += hits.length > 0 ? 1 : 0;
    a.r5.push(recallAtK(ranked, ground, 5));
    a.r10.push(recallAtK(ranked, ground, 10));
    a.mrr.push(mrr(ranked, ground));
    a.tokens.push(parsed.stats?.tokens_used ?? 0);
    a.latency.push(latencyMs);
    a.gt.push(hits.length);
    a.plans.add(parsed.plan?.selected ?? '?');
  }
}

const n = runOrder.length;
const configs = {};
for (const m of MODES) {
  const a = perMode[m.id];
  configs[m.id] = {
    label: m.label,
    correctness: a.correct / n,
    recall5: a.r5.reduce((x, y) => x + y, 0) / n,
    recall10: a.r10.reduce((x, y) => x + y, 0) / n,
    mrr: a.mrr.reduce((x, y) => x + y, 0) / n,
    avg_gt_hits: a.gt.reduce((x, y) => x + y, 0) / n,
    tokens: stats(a.tokens),
    latency_ms: stats(a.latency),
    plans: [...a.plans].sort(),
  };
}

const cqe = configs.cqe?.correctness ?? 0;
const hyb = configs.hybrid?.correctness ?? 0;
const verdict = {
  hybrid_correctness_gte_cqe: hyb >= cqe,
  details: `hybrid ${hyb.toFixed(3)} vs cqe ${cqe.toFixed(3)}`,
  dense: 'requires-dep: sin librería de embeddings instalada (stdlib solo) — config documentada, no corrida',
};

const TS = Date.now();
const artifact = {
  date: new Date().toISOString().slice(0, 10),
  tasks: n,
  configs,
  cqe_baseline: 'cqe',
  requires_dep: { dense: verdict.dense },
  verdict,
  matrix: MODES.map((m) => ({
    config: m.id, label: m.label,
    correctness: configs[m.id].correctness, recall5: configs[m.id].recall5,
    recall10: configs[m.id].recall10, mrr: configs[m.id].mrr,
    tokens_mean: configs[m.id].tokens.mean, latency_mean: configs[m.id].latency_ms.mean,
  })),
};
const outPath = path.join(ROOT, 'evals', 'reports', `hybrid-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${n} | modos: ${MODES.map((m) => m.id).join(', ')}`);
for (const m of MODES) {
  const c = configs[m.id];
  console.log(`  ${m.id.padEnd(14)} correct ${c.correctness.toFixed(3)}  r@5 ${c.recall5.toFixed(3)}  r@10 ${c.recall10.toFixed(3)}  mrr ${c.mrr.toFixed(3)}  tok ${Math.round(c.tokens.mean)}  lat ${Math.round(c.latency_ms.mean)}ms  plans [${c.plans.join(',')}]`);
}
console.log(`veredicto: ${verdict.hybrid_correctness_gte_cqe ? 'PASS' : 'FAIL'} — ${verdict.details}`);
console.log('nota:', verdict.dense);
console.log('artefacto:', outPath);
