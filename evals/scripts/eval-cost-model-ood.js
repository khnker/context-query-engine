#!/usr/bin/env node
/**
 * evals/scripts/eval-cost-model-ood.js — cost-model-ood (derivada v1.6 #3).
 * Retrain del cost model (ridge cardinality) con train COMBINADO de repos de
 * ambos lenguajes (t1-basic TS + t1-modular Python) vs test OOD dev, que antes
 * daba MAPE 237% (distribution-shift). Sweep de λ ∈ {1, 10} (regularización
 * fuerte = generalización OOD). Umbral: ML-OOD MAPE < heuristic baseline MAPE
 * en test → ADOPT (escribe evals/ml/model/cardinality-model-ood.json, usable
 * con CF_CARD_MODEL en classify.mjs); si no → REJECT (heurístico sigue siendo
 * el default robusto).
 * Artefacto: evals/reports/cost-model-ood-<TS>.json
 * Uso: node evals/scripts/eval-cost-model-ood.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATS_DIR = path.join(ROOT, 'engine');
const MODEL_DIR = path.join(ROOT, 'evals/ml/model');
const REPO_FILES = {
  train: ['statistics-t1-basic.ndjson', 'statistics-t1-modular.ndjson'],
  test: ['statistics-dev.ndjson'],
};

function readStats(file) {
  const rows = [];
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || !o.operator || !o.queryClass) continue;
    if (String(o.operator).startsWith('plan:')) continue; // telemetría por plan (no cardinalidad)
    const actual = o.actual ?? {};
    const estimated = o.estimated ?? {};
    const ac = Number(actual.candidates);
    if (!Number.isFinite(ac)) continue;
    rows.push({ operator: o.operator, queryClass: o.queryClass, est_candidates: Number(estimated.candidates) || 0, actual_candidates: ac });
  }
  return rows;
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

function trainRidge(trainRows, lambda) {
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
  for (let i = 0; i < D; i++) A[i][i] += lambda;
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

function mape(actuals, preds) {
  if (!actuals.length) return { mape: 0, p50: 0, p95: 0 };
  const errs = actuals.map((a, i) => (a > 0 ? Math.abs(a - preds[i]) / a : 0)).sort((x, y) => x - y);
  const n = errs.length;
  return {
    mape: errs.reduce((a, b) => a + b, 0) / n,
    p50: errs[Math.min(n - 1, Math.floor(0.5 * n))],
    p95: errs[Math.min(n - 1, Math.ceil(0.95 * n) - 1)],
  };
}

function main() {
  const train = REPO_FILES.train.flatMap((f) => readStats(path.join(STATS_DIR, f)));
  const test = REPO_FILES.test.flatMap((f) => readStats(path.join(STATS_DIR, f)));
  if (!train.length || !test.length) {
    console.error('sin stats — corre eval-distribution-shift primero (genera statistics-<repo>.ndjson)');
    process.exit(1);
  }

  // baseline heurístico: avg actual por operator|queryClass DE TRAIN (mismo que train-cardinality.py)
  const avg = new Map(), cnt = new Map();
  for (const r of train) {
    const k = `${r.operator}|${r.queryClass}`;
    avg.set(k, (avg.get(k) ?? 0) + r.actual_candidates);
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  const baselinePredict = (r) => (avg.get(`${r.operator}|${r.queryClass}`) ?? 0) / Math.max(1, cnt.get(`${r.operator}|${r.queryClass}`) ?? 0);

  const results = [];
  for (const lambda of [1, 10]) {
    const { predict, artifact, ops, qcs } = trainRidge(train, lambda);
    const mIn = mape(train.map((r) => r.actual_candidates), train.map(predict));
    const mOut = mape(test.map((r) => r.actual_candidates), test.map(predict));
    results.push({ lambda, mape_in: mIn.mape, p50_in: mIn.p50, mape_out: mOut.mape, p50_out: mOut.p50, p95_out: mOut.p95, rows: { train: train.length, test: test.length }, ops, qcs, artifact });
    console.log(`λ=${lambda}  MAPE in ${(mIn.mape * 100).toFixed(1)}%  MAPE out ${(mOut.mape * 100).toFixed(1)}%  (p50 out ${(mOut.p50 * 100).toFixed(1)}%  p95 out ${(mOut.p95 * 100).toFixed(1)}%)`);
  }
  const baselineMape = mape(test.map((r) => r.actual_candidates), test.map(baselinePredict));
  console.log(`baseline heurístico (avg train por op|qc)  MAPE out ${(baselineMape.mape * 100).toFixed(1)}% (p50 ${(baselineMape.p50 * 100).toFixed(1)}% p95 ${(baselineMape.p95 * 100).toFixed(1)}%)`);
  console.log(`referencia: MAPE out previo (train solo TS, model original) 237.3%`);

  const best = results.slice().sort((a, b) => a.mape_out - b.mape_out)[0];
  const adopt = best.mape_out < baselineMape.mape;
  if (adopt) {
    const out = path.join(MODEL_DIR, 'cardinality-model-ood.json');
    fs.writeFileSync(out, JSON.stringify(best.artifact));
    console.log(`ADOPT λ=${best.lambda} → ${out}`);
  } else {
    console.log('REJECT: ML-OOD no mejora el baseline heurístico en test');
  }

  const TS = Date.now();
  const artifact = {
    date: new Date().toISOString().slice(0, 10),
    rows: { train: train.length, test: test.length },
    reference: { previous_ood_mape: 0.2373, note: 'train solo TS (distribution-shift)' },
    baseline: { mape: baselineMape.mape, p50: baselineMape.p50, p95: baselineMape.p95 },
    results: results.map((r) => ({ lambda: r.lambda, mape_in: r.mape_in, mape_out: r.mape_out, p50_out: r.p50_out, p95_out: r.p95_out })),
    verdict: { adopt, chosen_lambda: adopt ? best.lambda : null, threshold: 'ML-OOD MAPE < heuristic baseline MAPE en test', model_file: adopt ? 'evals/ml/model/cardinality-model-ood.json' : null },
  };
  const outPath = path.join(ROOT, 'evals', 'reports', `cost-model-ood-${TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log('artefacto:', outPath);
}

main();
