#!/usr/bin/env node
/**
 * evals/scripts/eval-calibrated.js — B11 repo-calibrated-cardinality.
 * Calibra el estimador global con residuos per-repo (online mean-squares por
 * (op, queryClass)) y mide MAPE OOD contra el baseline heurístico.
 * Pipeline: recolecta stats con CF_FINGERPRINT=1 (para repo_fp en records) →
 * entrena ridge global (train t1-basic) → aplica residual correction per-repo
 * (usa el per-repo key repo:<fp>|op|qc de statistics.js) → MAPE en val (t1-modular)
 * y test (dev, OOD sin per-repo profile → calibración no aplica, mide efecto del
 * blend global) → comparar contra heuristic baseline.
 * Umbral: MAPE test OOD < 2× heurístico (27.7%) → PASS.
 * Artefacto: evals/reports/calibrated-<TS>.json
 * Uso: node evals/scripts/eval-calibrated.js [--limit N]
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
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const EXTRA = path.join(ROOT, 'evals/datasets/tasks-dev.json');
if (fs.existsSync(EXTRA)) TASKS.push(...JSON.parse(fs.readFileSync(EXTRA, 'utf8')));
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 6;

const GROUPS = {
  train: { repo: 't1-basic', limit: Infinity },
  val: { repo: 't1-modular', limit: Infinity },
  test: { repo: 'dev', limit: LIMIT },
};

function collectStats(group, outFile, extraEnv = {}) {
  if (fs.existsSync(outFile)) fs.rmSync(outFile);
  const tasks = TASKS.filter((t) => t.repo === group.repo).slice(0, group.limit);
  for (const task of tasks) {
    const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
    if (!fs.existsSync(repoDir)) continue;
    if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
    try {
      execFileSync('node', [ENGINE, task.cqp], {
        cwd: repoDir,
        env: { ...process.env, CF_STATS_FILE: outFile, CF_FINGERPRINT: '1', ...extraEnv },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024, timeout: 60000,
      });
    } catch { /* parcial */ }
  }
  return loadStats(outFile);
}

function loadStats(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      const o = JSON.parse(l);
      if (!o?.operator || !o?.queryClass) return null;
      const actual = Number(o.actual?.candidates);
      if (!Number.isFinite(actual)) return null;
      return {
        operator: o.operator,
        queryClass: o.queryClass,
        est_candidates: Number(o.estimated?.candidates) || 0,
        actual_candidates: actual,
        repo_fp: o.repo_fp ?? null,
      };
    } catch { return null; }
  }).filter(Boolean);
}

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

function trainRidge(rows) {
  const ops = [...new Set(rows.map((r) => r.operator))].sort();
  const qcs = [...new Set(rows.map((r) => r.queryClass))].sort();
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
  const X = rows.map(feat);
  const y = rows.map((r) => Math.log1p(Math.max(0, r.actual_candidates)));
  const A = Array.from({ length: D }, () => new Array(D).fill(0));
  const b = new Array(D).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < D; r++) {
      for (let c = 0; c < D; c++) A[r][c] += X[i][r] * X[i][c];
      b[r] += X[i][r] * y[i];
    }
  }
  for (let i = 0; i < D; i++) A[i][i] += 1.0;
  const W = solve(A, b);
  const predict = (r) => {
    const f = feat(r);
    let acc = 0;
    for (let i = 0; i < D; i++) acc += f[i] * W[i];
    return Math.max(0, Math.expm1(Math.min(acc, 20)));
  };
  return { predict };
}

// Baseline heurístico: avg actual por (op,qc) del train
function makeBaseline(train) {
  const avg = new Map(), cnt = new Map();
  for (const r of train) {
    const k = `${r.operator}|${r.queryClass}`;
    avg.set(k, (avg.get(k) ?? 0) + r.actual_candidates);
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  return (r) => (avg.get(`${r.operator}|${r.queryClass}`) ?? 0) / Math.max(1, cnt.get(`${r.operator}|${r.queryClass}`) ?? 0);
}

// Per-repo residual profile: para cada (op,qc,repo) calcula residual factor
// (actual/global_pred) visto en train/val → aplicado sobre predicción global.
function buildRepoProfiles(trainRows) {
  const byRepo = new Map();
  for (const r of trainRows) {
    if (!r.repo_fp) continue;
    const key = `${r.repo_fp}|${r.operator}|${r.queryClass}`;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(r);
  }
  const profiles = new Map(); // key (repo|op|qc) → {n, ratio}
  for (const [k, rows] of byRepo) {
    const ratios = rows.map((r) => (r.actual_candidates > 0 && r.est_candidates > 0 ? r.actual_candidates / r.est_candidates : 1));
    const n = ratios.length;
    profiles.set(k, { n, ratio: ratios.reduce((a, b) => a + b, 0) / n });
  }
  return profiles;
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

// main
const statsByGroup = {};
for (const [gid, g] of Object.entries(GROUPS)) {
  statsByGroup[gid] = collectStats(g, path.join(STATS_DIR, `statistics-calibrated-${gid}.ndjson`));
}

const train = statsByGroup.train;
const { predict } = trainRidge(train);
const baseline = makeBaseline(train);
const repoProfiles = buildRepoProfiles([...statsByGroup.train, ...statsByGroup.val]);

// Calibrated predict: global * per-repo residual ratio (solo si profile existe)
function calibratedPredict(r) {
  const base = predict(r);
  if (r.repo_fp) {
    const p = repoProfiles.get(`${r.repo_fp}|${r.operator}|${r.queryClass}`);
    if (p && p.n >= 3) return base * p.ratio;
  }
  return base;
}

const metrics = {};
for (const [gid, rows] of Object.entries(statsByGroup)) {
  const actuals = rows.map((r) => r.actual_candidates);
  metrics[gid] = {
    rows: rows.length,
    ml_global: mapeStats(actuals, rows.map((r) => predict(r))),
    ml_calibrated: mapeStats(actuals, rows.map((r) => calibratedPredict(r))),
    heuristic_baseline: mapeStats(actuals, rows.map((r) => baseline(r))),
  };
}

const heurTest = metrics.test.heuristic_baseline.mape;
const calibTest = metrics.test.ml_calibrated.mape;
const THRESH = 2 * heurTest;
const passCalib = calibTest < THRESH;

console.log('=== B11 repo-calibrated-cardinality ===');
for (const [gid, m] of Object.entries(metrics)) {
  console.log(`  ${gid.padEnd(5)} n=${String(m.rows).padEnd(3)} global MAPE ${(m.ml_global.mape * 100).toFixed(1)}%  calibrated ${(m.ml_calibrated.mape * 100).toFixed(1)}%  heur ${(m.heuristic_baseline.mape * 100).toFixed(1)}%`);
}
console.log(`umbral: MAPE calibrado < 2×heur  →  ${(calibTest * 100).toFixed(1)}% < ${(THRESH * 100).toFixed(1)}%  ${passCalib ? 'PASS' : 'FAIL'}`);
console.log(`residual profiles: ${repoProfiles.size} (repo|op|qc)`);

const TS = Date.now();
const report = {
  date: new Date().toISOString().slice(0, 10),
  threshold: { heuristic_test_mape: heurTest, x2: THRESH, pass: passCalib },
  metrics: Object.fromEntries(Object.entries(metrics).map(([g, m]) => [g, {
    rows: m.rows,
    ml_global_mape: m.ml_global.mape,
    ml_calibrated_mape: m.ml_calibrated.mape,
    heuristic_baseline_mape: m.heuristic_baseline.mape,
  }])),
  repo_profiles: repoProfiles.size,
  verdict: passCalib ? 'PASS' : 'REJECT',
  model_file: 'evals/ml/model/cardinality-model-ood.json',
};
const outPath = path.join(ROOT, 'evals', 'reports', `calibrated-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log('artefacto:', outPath);
console.log('veredicto:', report.verdict);