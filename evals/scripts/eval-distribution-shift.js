#!/usr/bin/env node
/**
 * evals/scripts/eval-distribution-shift.js — distribution-shift-testing (change 9).
 * El cost model (ridge cardinality) se entrena SOLO con el repo train (t1-basic, TS)
 * y se evalúa en repos NO vistos: val (t1-modular, Python) y test (dev workspace).
 * Métricas: MAPE/P50/P95 (ML vs baseline heurístico), shift MAPE_in vs MAPE_out,
 * hipótesis de lenguaje (TS→Python), y regret del plan selector OOD (FORCE_PLAN A/B/C
 * oracle vs selección heurística vs aprendida con el modelo OOD).
 * Ridge resuelto en node (eliminación gaussiana, stdlib) — features espejo de
 * classify.mjs estimate-cardinality (solo flags definidos, log1p est, expm1 clip 20).
 * Artefacto: evals/reports/distribution-shift-<TS>.json + modelo OOD en
 * evals/reports/ood-cardinality-model.json (consumible vía CF_CARD_MODEL).
 * Node.js ESM, stdlib SOLO.
 *
 * Uso: node evals/scripts/eval-distribution-shift.js [--limit N]  (N = tasks del grupo test)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STATS_DIR = path.join(ROOT, 'engine');
const REPO_DIRS = { 't1-basic': 'evals/datasets/repos/t1-basic', 't1-modular': 'evals/datasets/repos/t1-modular', dev: '/home/nicolas/dev' };
const CLASSIFY = path.join(ROOT, 'evals', 'ml', 'classify.mjs');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const EXTRA = path.join(ROOT, 'evals/datasets/tasks-dev.json');
if (fs.existsSync(EXTRA)) TASKS.push(...JSON.parse(fs.readFileSync(EXTRA, 'utf8')));
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 6;

// 9.1 — split por repo: train t1-basic (TS), val t1-modular (Python), test dev (no visto)
const GROUPS = {
  train: { repo: 't1-basic', lang: 'TypeScript', label: 'train (t1-basic, TS)', limit: Infinity },
  val: { repo: 't1-modular', lang: 'Python', label: 'val (t1-modular, Python)', limit: Infinity },
  test: { repo: 'dev', lang: 'TS-heavy/mixed', label: 'test (dev workspace)', limit: LIMIT },
};

function repoLang(repoDir) {
  const counts = {};
  const walk = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const ext = path.extname(e.name).replace('.', '');
        if (ext) counts[ext] = (counts[ext] ?? 0) + 1;
      }
    }
  };
  walk(path.resolve(ROOT, repoDir));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => `${e}:${n}`);
  return top.join(' ');
}

function collectStats(group) {
  const statsFile = path.join(STATS_DIR, `statistics-${group.repo}.ndjson`);
  if (fs.existsSync(statsFile)) fs.rmSync(statsFile);
  const tasks = TASKS.filter((t) => t.repo === group.repo).slice(0, group.limit);
  for (const task of tasks) {
    const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
    if (!fs.existsSync(repoDir)) continue;
    if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
    try {
      execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env: { ...process.env, CF_STATS_FILE: statsFile }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
    } catch { /* timeout/crash: registro parcial, se omite */ }
  }
  return { statsFile, tasks };
}

function loadStats(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      const o = JSON.parse(l);
      if (!o?.operator || !o?.queryClass) return null;
      const actual = Number(o.actual?.candidates);
      if (!Number.isFinite(actual)) return null;
      return { operator: o.operator, queryClass: o.queryClass, est_candidates: Number(o.estimated?.candidates) || 0, actual_candidates: actual };
    } catch { return null; }
  }).filter(Boolean);
}

// --- ridge en node (espejo features de classify.mjs: solo flags definidos) ---
function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

function trainRidge(trainRows) {
  const ops = [...new Set(trainRows.map((r) => r.operator))].sort();
  const qcs = [...new Set(trainRows.map((r) => r.queryClass))].sort();
  const op_idx = new Map(ops.map((o, i) => [o, i]));
  const qc_idx = new Map(qcs.map((q, i) => [q, i]));
  const D = ops.length + qcs.length + 1;
  const feat = (r) => {
    const f = new Array(D).fill(0);
    const op = op_idx.get(r.operator);
    if (op !== undefined) f[op] = 1;
    const qc = qc_idx.get(r.queryClass);
    if (qc !== undefined) f[ops.length + qc] = 1;
    f[D - 1] = Math.log1p(Math.max(0, r.est_candidates || 0));
    return f;
  };
  const X = trainRows.map(feat);
  const y = trainRows.map((r) => Math.log1p(Math.max(0, r.actual_candidates)));
  const A = Array.from({ length: D }, () => new Array(D).fill(0));
  const b = new Array(D).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < D; r++) {
      for (let c = 0; c < D; c++) A[r][c] += X[i][r] * X[i][c];
      b[r] += X[i][r] * y[i];
    }
  }
  for (let i = 0; i < D; i++) A[i][i] += 1.0; // λ=1 (mismo que train-cardinality.py)
  const W = solve(A, b);
  const predict = (r) => {
    const f = feat(r);
    let acc = 0;
    for (let i = 0; i < D; i++) acc += f[i] * W[i];
    return Math.max(0, Math.expm1(Math.min(acc, 20)));
  };
  const artifact = { type: 'ridge-cardinality', W, op_idx: Object.fromEntries(op_idx), qc_idx: Object.fromEntries(qc_idx) };
  return { predict, artifact, ops, qcs };
}

function mapeStats(actuals, preds) {
  const errs = actuals.map((a, i) => (a > 0 ? Math.abs(a - preds[i]) / a : 0)).sort((x, y) => x - y);
  const n = errs.length;
  return {
    n,
    mape: n ? errs.reduce((x, y) => x + y, 0) / n : 0,
    p50: n ? errs[Math.min(n - 1, Math.floor(0.5 * n))] : 0,
    p95: n ? errs[Math.min(n - 1, Math.floor(0.95 * n))] : 0,
  };
}

// --- regret OOD: oracle A/B/C vs selección heurística vs aprendida (modelo OOD) ---
function runEngine(cqp, repoDir, extraEnv = {}, timeoutMs = 60000) {
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, CF_STATS_FILE: path.join(STATS_DIR, 'statistics-regret-tmp.ndjson'), ...extraEnv };
  fs.writeFileSync(env.CF_STATS_FILE, '');
  const t0 = Date.now();
  try {
    const parsed = JSON.parse(execFileSync('node', [ENGINE, cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }));
    return { tokens: parsed.stats?.tokens_used ?? 0, selected: parsed.plan?.selected ?? null, latencyMs: Date.now() - t0 };
  } catch {
    return null;
  }
}

function regretGroup(group, oodArtifactPath) {
  const out = { tasks: 0, oracle_plan: 0, heur: { regret: [], acc: 0 }, ood: { regret: [], acc: 0 }, skipped: 0 };
  const tasks = TASKS.filter((t) => t.repo === group.repo).slice(0, group.limit);
  for (const task of tasks) {
    const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
    if (!fs.existsSync(repoDir)) continue;
    const forced = {};
    let any = false;
    for (const pid of ['A', 'B', 'C']) {
      const r = runEngine(task.cqp, repoDir, { FORCE_PLAN: pid }, 45000);
      if (r) { forced[pid] = r.tokens; any = true; }
    }
    if (!any) { out.skipped += 1; continue; }
    const oracle = Math.min(...Object.values(forced));
    const oraclePlan = Object.keys(forced).find((k) => forced[k] === oracle) ?? '?';
    const heur = runEngine(task.cqp, repoDir, {}, 45000);
    const ood = runEngine(task.cqp, repoDir, { CF_MODEL_CMD: `node ${CLASSIFY}`, CF_CARD_MODEL: oodArtifactPath }, 45000);
    if (!heur || !ood) { out.skipped += 1; continue; }
    out.tasks += 1;
    if (heur.selected === oraclePlan) out.heur.acc += 1;
    if (ood.selected === oraclePlan) out.ood.acc += 1;
    out.heur.regret.push(oracle > 0 ? (heur.tokens - oracle) / oracle : 0);
    out.ood.regret.push(oracle > 0 ? (ood.tokens - oracle) / oracle : 0);
    out.oracle_plan = oraclePlan;
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return { tasks: out.tasks, skipped: out.skipped, regret_heuristic: mean(out.heur.regret), regret_ood: mean(out.ood.regret), plan_acc_heuristic: out.heur.acc / Math.max(1, out.tasks), plan_acc_ood: out.ood.acc / Math.max(1, out.tasks) };
}

// --- main ---
const collected = {};
const groupStats = {};
for (const [gid, g] of Object.entries(GROUPS)) {
  const { statsFile } = collectStats(g);
  collected[gid] = loadStats(statsFile);
  groupStats[gid] = { repo: g.repo, lang: g.lang, label: g.label, rows: collected[gid].length, langs: repoLang(REPO_DIRS[g.repo]) };
}

const train = collected.train;
const { predict, artifact, ops, qcs } = trainRidge(train);
const oodPath = path.join(ROOT, 'evals', 'reports', 'ood-cardinality-model.json');
fs.writeFileSync(oodPath, JSON.stringify(artifact) + '\n');

const baselineAvg = {};
const blCnt = {};
for (const r of train) {
  const k = `${r.operator}|${r.queryClass}`;
  baselineAvg[k] = (baselineAvg[k] ?? 0) + r.actual_candidates;
  blCnt[k] = (blCnt[k] ?? 0) + 1;
}
const baseline = (r) => {
  const k = `${r.operator}|${r.queryClass}`;
  return (baselineAvg[k] ?? 0) / Math.max(1, blCnt[k]);
};

const metrics = {};
for (const [gid, g] of Object.entries(GROUPS)) {
  const rows = collected[gid];
  const actuals = rows.map((r) => r.actual_candidates);
  metrics[gid] = {
    rows: rows.length,
    ml: mapeStats(actuals, rows.map((r) => predict(r))),
    heuristic_baseline: mapeStats(actuals, rows.map((r) => baseline(r))),
  };
}

const mIn = metrics.train.ml.mape;
const mOut = Math.max(metrics.val.ml.mape, metrics.test.ml.mape);
const ratio = mIn > 0 ? mOut / mIn : Infinity;
const verdict = { mape_out_le_2x_in: ratio <= 2, mape_in: mIn, mape_out: mOut, ratio: Number.isFinite(ratio) ? ratio : null, threshold: 2 };

const regret = { val: regretGroup(GROUPS.val, oodPath), test: regretGroup(GROUPS.test, oodPath) };

const TS = Date.now();
const report = {
  date: new Date().toISOString().slice(0, 10),
  split: 'train=t1-basic(TS) / val=t1-modular(Python) / test=dev(unseen) — polar: sin repo dir, omitido',
  groups: groupStats,
  model: { type: 'ridge-cardinality', operators: ops, query_classes: qcs, train_rows: train.length },
  mape_in_vs_out: { in: metrics.train, out_val: metrics.val, out_test: metrics.test },
  language_hypothesis: {
    train_lang: groupStats.train.langs,
    val_lang: groupStats.val.langs,
    mape_train_ts: metrics.train.ml.mape,
    mape_val_python: metrics.val.ml.mape,
    degradation: metrics.train.ml.mape > 0 ? metrics.val.ml.mape / metrics.train.ml.mape : null,
    note: 'entrenado solo en TypeScript; val = repos Python (t1-modular)',
  },
  regret_ood: regret,
  verdict,
  ood_model_artifact: path.relative(ROOT, oodPath),
};
const outPath = path.join(ROOT, 'evals', 'reports', `distribution-shift-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

console.log(`split: train=t1-basic(TS, ${train.length} obs) | val=t1-modular(Python) | test=dev`);
for (const [gid, m] of Object.entries(metrics)) {
  console.log(`  ${gid.padEnd(5)} ML  MAPE ${(m.ml.mape * 100).toFixed(0).padStart(3)}%  P50 ${(m.ml.p50 * 100).toFixed(0)}%  P95 ${(m.ml.p95 * 100).toFixed(0)}%  | base ${(m.heuristic_baseline.mape * 100).toFixed(0)}%  (n=${m.rows})`);
}
console.log(`shift: MAPE_in ${(mIn * 100).toFixed(1)}% → MAPE_out ${(mOut * 100).toFixed(1)}%  ratio ${verdict.ratio?.toFixed(2)}  ${verdict.mape_out_le_2x_in ? 'PASS' : 'FAIL'} (≤2×)`);
console.log(`lenguaje: TS ${(metrics.train.ml.mape * 100).toFixed(0)}% → Python(val) ${(metrics.val.ml.mape * 100).toFixed(0)}%`);
console.log(`regret val:  heur ${regret.val.regret_heuristic.toFixed(3)} / ood ${regret.val.regret_ood.toFixed(3)} (acc ${regret.val.plan_acc_heuristic.toFixed(2)}/${regret.val.plan_acc_ood.toFixed(2)})`);
console.log(`regret test: heur ${regret.test.regret_heuristic.toFixed(3)} / ood ${regret.test.regret_ood.toFixed(3)} (acc ${regret.test.plan_acc_heuristic.toFixed(2)}/${regret.test.plan_acc_ood.toFixed(2)})`);
console.log('artefacto:', outPath);
console.log('modelo OOD:', path.relative(ROOT, oodPath));
