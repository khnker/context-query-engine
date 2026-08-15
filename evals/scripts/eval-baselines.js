#!/usr/bin/env node
/**
 * evals/scripts/eval-baselines.js — baselines difíciles (change harder-baselines).
 * Compara CQE contra baselines no-triviales: rg crudo, rg-files, BM25 (bm25.js),
 * RepoMap textual (file tree) y CQE+rerank, sobre T1/T2/dev.
 * Métricas: correctness (gt_hits>0), recall@5/@10, MRR, tokens, latencia.
 * Artefacto: evals/reports/baselines-<TS>.json + veredicto (2.5: CQE ≥ baselines).
 * Node.js ESM, stdlib SOLO.
 *
 * Uso: node evals/scripts/eval-baselines.js [--limit N]
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
const tokenize = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

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

// 2.1/2.2 — baselines: rg crudo, rg-files, RepoMap textual, BM25, CQE, CQE+rerank
const BASELINES = [
  { id: 'raw_rg', label: 'Agente crudo (rg -n, top10)' },
  { id: 'raw_files', label: 'Agente crudo (rg --files)' },
  { id: 'repomap', label: 'RepoMap textual (file tree)' },
  { id: 'bm25', label: 'BM25 puro' },
  { id: 'cqe', label: 'CQE (baseline)' },
  { id: 'cqe_rerank', label: 'CQE+rerank', needsModel: true },
].filter((b) => !b.needsModel || modelCmd);

const stats = (a) => {
  if (!a.length) return { mean: 0, median: 0, p95: 0 };
  const s = [...a].sort((x, y) => x - y);
  return { mean: a.reduce((x, y) => x + y, 0) / a.length, median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] };
};

function runRaw(cwd, query) {
  // baselines crudos: herramientas directas sin optimizer ni fusión
  const words = tokenize(query);
  const rgArgs = ['-n', '--no-ignore', '-g', '!node_modules', ...words.flatMap((w) => ['-e', w])];
  let rgOut = '';
  try {
    rgOut = execFileSync('rg', rgArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    rgOut = e.stdout ?? '';
  }
  const files = [];
  try {
    files.push(...execFileSync('rg', ['--files', '--no-ignore', '-g', '!node_modules', '.'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean));
  } catch { /* sin archivos */ }
  return { rgOut, files };
}

const runOrder = shuffle([...rows], SEED);
const perMode = Object.fromEntries(BASELINES.map((b) => [b.id, { correct: 0, r5: [], r10: [], mrr: [], tokens: [], latency: [], gt: [] }]));

for (const r of runOrder) {
  const task = r.repo ? r : byId[r.source];
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) continue;
  const ground = [...(task.primary ?? []), ...(task.related ?? []), ...(task.tests ?? [])];
  const cqp = task.cqp;

  const base = { rgOut: '', files: [] };
  if (BASELINES.some((b) => ['raw_rg', 'raw_files', 'repomap'].includes(b.id))) {
    const raw = runRaw(repoDir, task.query ?? cqp);
    base.rgOut = raw.rgOut;
    base.files = raw.files;
  }

  const order = BASELINES.map((b, i) => (runOrder.indexOf(r) + i) % BASELINES.length);
  for (const bi of order) {
    const b = BASELINES[bi];
    const a = perMode[b.id];
    const t0 = Date.now();
    let ranked = [];
    let tokens = 0;
    switch (b.id) {
      case 'raw_rg': {
        const rows = base.rgOut.split('\n').filter(Boolean).map((l) => l.split(':')[0]).filter((p) => !p.includes('node_modules'));
        ranked = [...new Set(rows)].slice(0, 10);
        tokens = Math.ceil(base.rgOut.length / 4);
        break;
      }
      case 'raw_files': {
        const q = tokenize(task.query ?? cqp);
        ranked = base.files.filter((p) => q.some((w) => p.toLowerCase().includes(w))).slice(0, 10);
        tokens = Math.ceil(ranked.join('\n').length / 4);
        break;
      }
      case 'repomap': {
        // RepoMap textual: file tree completo acotado a 500 paths (contexto naive del agente)
        const words = tokenize(task.query ?? cqp);
        const scored = base.files.map((p) => ({ p, s: tokenize(p).filter((w) => words.includes(w)).length }));
        ranked = scored.sort((x, y) => y.s - x.s).slice(0, 500).map((x) => x.p);
        tokens = Math.ceil(ranked.join('\n').length / 4);
        break;
      }
      case 'bm25':
      case 'cqe':
      case 'cqe_rerank': {
        if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
        const env = {
          ...process.env,
          CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
          ...(b.id === 'bm25' ? { CF_RETRIEVAL: 'bm25' } : {}),
          ...(b.id === 'cqe_rerank' ? { CF_MODEL_CMD: modelCmd } : {}),
        };
        const parsed = JSON.parse(execFileSync('node', [ENGINE, cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));
        ranked = [...new Set((parsed.results ?? []).map((x) => x.path))];
        tokens = parsed.stats?.tokens_used ?? 0;
        break;
      }
    }
    const latencyMs = Date.now() - t0;
    const hits = ground.filter((g) => ranked.some((f) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)));
    a.correct += hits.length > 0 ? 1 : 0;
    a.r5.push(recallAtK(ranked, ground, 5));
    a.r10.push(recallAtK(ranked, ground, 10));
    a.mrr.push(mrr(ranked, ground));
    a.tokens.push(tokens);
    a.latency.push(latencyMs);
    a.gt.push(hits.length);
  }
}

const n = runOrder.length;
const configs = {};
for (const b of BASELINES) {
  const a = perMode[b.id];
  configs[b.id] = {
    label: b.label,
    correctness: a.correct / n,
    recall5: a.r5.reduce((x, y) => x + y, 0) / n,
    recall10: a.r10.reduce((x, y) => x + y, 0) / n,
    mrr: a.mrr.reduce((x, y) => x + y, 0) / n,
    avg_gt_hits: a.gt.reduce((x, y) => x + y, 0) / n,
    tokens: stats(a.tokens),
    latency_ms: stats(a.latency),
  };
}

// 2.5 — umbral: CQE gana o empata en correctness; se documenta dónde pierde
const losses = [];
const cqeC = configs.cqe.correctness;
for (const b of BASELINES) {
  if (b.id === 'cqe') continue;
  if (configs[b.id].correctness > cqeC + 1e-9) losses.push(`${b.id} ${configs[b.id].correctness.toFixed(3)} > cqe ${cqeC.toFixed(3)}`);
}
const verdict = {
  cqe_wins_or_ties: losses.length === 0,
  losses: losses.length ? losses : 'ninguna — CQE gana o empata en correctness',
  details: `cqe ${cqeC.toFixed(3)}; mejor baseline: ${Object.entries(configs).filter(([k]) => k !== 'cqe').sort((x, y) => y[1].correctness - x[1].correctness)[0][1].label} ${Object.entries(configs).filter(([k]) => k !== 'cqe').sort((x, y) => y[1].correctness - x[1].correctness)[0][1].correctness.toFixed(3)}`,
};

const TS = Date.now();
const artifact = {
  date: new Date().toISOString().slice(0, 10),
  tasks: n,
  configs,
  verdict,
  matrix: BASELINES.map((b) => ({
    baseline: b.id, label: b.label,
    correctness: configs[b.id].correctness, recall5: configs[b.id].recall5,
    recall10: configs[b.id].recall10, mrr: configs[b.id].mrr,
    tokens_mean: configs[b.id].tokens.mean, latency_mean: configs[b.id].latency_ms.mean,
  })),
};
const outPath = path.join(ROOT, 'evals', 'reports', `baselines-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${n} | baselines: ${BASELINES.map((b) => b.id).join(', ')}`);
for (const b of BASELINES) {
  const c = configs[b.id];
  console.log(`  ${b.id.padEnd(10)} correct ${c.correctness.toFixed(3)}  r@5 ${c.recall5.toFixed(3)}  r@10 ${c.recall10.toFixed(3)}  mrr ${c.mrr.toFixed(3)}  tok ${Math.round(c.tokens.mean)}  lat ${Math.round(c.latency_ms.mean)}ms`);
}
console.log(`veredicto: ${verdict.cqe_wins_or_ties ? 'PASS' : 'FAIL'} — ${verdict.details}`);
console.log('artefacto:', outPath);
