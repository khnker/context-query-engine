#!/usr/bin/env node
/**
 * evals/scripts/eval-pairs.js — dataset de pares de planes (Lero, paso 08).
 * Fuentes: artifact selection-policy (32 T1, sin re-correr) + runs FORCE_PLAN
 * A/B/C sobre dev (14) y adversarial (30). Por par: query_type one-hot + diff
 * de features del plan (tokens, est_tokens, latency, gt_hits, exactness,
 * n_results, recall5, mrr). Label: gana gt_hits mayor; tie → tokens menores.
 * Output: evals/datasets/pairs.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import glob from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const DEV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'), 'utf8'));
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', dev: path.resolve(ROOT, '..'),
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };

const byId = Object.fromEntries(TASKS.map((t) => [t.id, t]));
const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
const qtOf = (cqp) => {
  const m = /FIND\s+(\w+)/.exec(cqp ?? '');
  return m ? m[1] : 'implementation';
};
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function runPlan(task, force) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const tmp = path.join(ROOT, '.tmp');
  const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir,
    env: { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), FORCE_PLAN: force },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  const j = JSON.parse(out.toString());
  return { tokens: j.stats?.tokens_used ?? 0, results: j.results ?? [] };
}

function planFeatures(forceRuns, ground) {
  const feat = {};
  for (const id of ['A', 'B', 'C']) {
    const r = forceRuns[id];
    const hits = gtHits(r.results, ground);
    const rank = r.results.map((x) => (x.path || '').replace(/^\.\//, ''));
    const g5 = rank.slice(0, 5);
    const r5 = ground.length ? g5.filter((f) => ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f))).length / Math.min(5, ground.length) : 1;
    const mrr = rank.reduce((acc, f, i) => acc || (ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)) ? 1 / (i + 1) : 0), 0);
    feat[id] = {
      tokens: r.tokens, est_tokens: r.tokens, latency_ms: 0, gt_hits: hits,
      exactness: hits > 0 ? 1 : 0, n_results: r.results.length, recall5: r5, mrr,
    };
  }
  return feat;
}

const QTYPE_ORDER = ['definitions', 'references', 'filename', 'implementation', 'pattern', 'concept'];
const FEATS = ['tokens', 'est_tokens', 'latency_ms', 'gt_hits', 'exactness', 'n_results', 'recall5', 'mrr'];

const TASKS_FILE = path.join(ROOT, 'evals/reports/pairs-tasks.json');
const existing = fs.existsSync(TASKS_FILE) ? JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).tasks : [];
const done = new Set(existing.map((t) => t.id));
const all = existing;
const saveTasks = () => fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: all }, null, 2));
function pushTask(t) { all.push(t); saveTasks(); }
for (const t of TASKS.filter((x) => x.repo === 't1-basic' || x.repo === 't1-modular')) {
  const sel = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/reports/selection-policy-1786834278335.json'), 'utf8')).perTask
    .find((x) => x.id === t.id);
  if (sel && !done.has(t.id)) pushTask({ id: t.id, query_type: qtOf(t.cqp), plans: sel.plans });
}

for (const t of [...DEV, ...ADV]) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[t.repo] ?? t.repo);
  if (!fs.existsSync(repoDir) || !t.cqp) continue;
  const ground = groundOf(t);
  const runs = {};
  let ok = true;
  for (const id of ['A', 'B', 'C']) {
    try { runs[id] = runPlan(t, id); } catch { ok = false; break; }
  }
  if (ok && !done.has(t.id)) pushTask({ id: t.id, query_type: qtOf(t.cqp), plans: planFeatures(runs, ground) });
}

const pairs = [];
for (const task of all) {
  const ids = ['A', 'B', 'C'];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const X = ids[i], Y = ids[j];
      const a = task.plans[X], b = task.plans[Y];
      const winA = a.gt_hits !== b.gt_hits ? a.gt_hits > b.gt_hits : a.tokens < b.tokens;
      const qth = QTYPE_ORDER.map((q) => (task.query_type === q ? 1 : 0));
      const diff = FEATS.map((f) => (a[f] ?? 0) - (b[f] ?? 0));
      pairs.push({ task: task.id, pair: X + Y, query_type: task.query_type, features: [...qth, ...diff], label: winA ? 1 : 0 });
    }
  }
}

fs.mkdirSync(path.join(ROOT, 'evals/datasets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evals/datasets/pairs.json'), JSON.stringify({ tasks: all.length, pairs, feat_names: [...QTYPE_ORDER, ...FEATS] }, null, 2));
console.log(`tasks: ${all.length} | pairs: ${pairs.length} | queries de dev+adv añadidas: ${all.length - 32}`);
console.log('distribución labels:', pairs.reduce((m, p) => (m[p.label] = (m[p.label] ?? 0) + 1, m), {}));