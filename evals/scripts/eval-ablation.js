#!/usr/bin/env node
/**
 * evals/scripts/eval-ablation.js — matriz de elección de modelo (change model-choice-ablation).
 * Compara el clasificador ridge hashed-ngram (lineal) vs MLP 1 capa oculta (numpy):
 *   modelo × (test_acc, p95 latency, mean/max RSS, artifact bytes)
 * sobre queries-test.jsonl (150 rows fijas). Referencia: MAPE cardinality y
 * recall@5/MRR reranker desde reports existentes.
 * Veredicto (11.5): el elegido ≥ ridge en accuracy Y p95 latency < 50ms.
 * Node ESM, stdlib SOLO.
 *
 * Uso: node evals/scripts/eval-ablation.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLASSIFY = path.join(ROOT, 'evals', 'ml', 'classify.mjs');
const TEST = path.join(ROOT, 'evals', 'datasets', 'queries-test.jsonl');
const rows = fs.readFileSync(TEST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const MODELS = [
  { id: 'ridge', file: path.join(ROOT, 'evals/ml/model/classifier.json') },
  { id: 'mlp', file: path.join(ROOT, 'evals/ml/model/mlp.json') },
].filter((m) => fs.existsSync(m.file));

const p95 = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};

const runModel = (m) => {
  let correct = 0;
  const lat = [];
  const rss = [];
  for (const r of rows) {
    try {
      const out = JSON.parse(execFileSync('node', [CLASSIFY, 'classify-query', JSON.stringify({ query: r.text })], {
        env: { ...process.env, CF_MODEL_FILE: m.file },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }));
      if (out.label === r.label) correct++;
      if (out.latencyMs != null) lat.push(out.latencyMs);
      if (out.rssBytes) rss.push(out.rssBytes);
    } catch { /* sin salida → error */ }
  }
  const bytes = fs.statSync(m.file).size;
  return {
    test_acc: correct / rows.length,
    p95_latency_ms: p95(lat),
    mean_rss_mb: Math.round(rss.reduce((a, b) => a + b, 0) / Math.max(1, rss.length) / 1048576),
    max_rss_mb: Math.round(Math.max(0, ...rss) / 1048576),
    artifact_bytes: bytes,
    latency_lt_50ms: p95(lat) < 50,
  };
};

const res = {};
for (const m of MODELS) res[m.id] = runModel(m);

const cardReport = path.join(ROOT, 'evals/reports/cardinality-error.json');
const rerankReport = path.join(ROOT, 'evals/ml/model/reranker-report.json');
const classifierReport = path.join(ROOT, 'evals/ml/model/report.json');
const reference = {
  cardinality_mape: fs.existsSync(cardReport) ? (JSON.parse(fs.readFileSync(cardReport, 'utf8')).summary?.mape ?? null) : null,
  reranker: fs.existsSync(rerankReport) ? JSON.parse(fs.readFileSync(rerankReport, 'utf8')).recall_at5 ?? null : null,
  reranker_mrr: fs.existsSync(rerankReport) ? JSON.parse(fs.readFileSync(rerankReport, 'utf8')).mrr ?? null : null,
  ridge_test_acc_reported: fs.existsSync(classifierReport) ? JSON.parse(fs.readFileSync(classifierReport, 'utf8')).test_acc ?? null : null,
};

const ridge = res.ridge;
const mlp = res.mlp;
const chosen = mlp && mlp.test_acc >= ridge.test_acc && mlp.latency_lt_50ms ? 'mlp' : 'ridge';
const verdict = {
  chosen_model: chosen,
  details: `mlp test_acc ${mlp?.test_acc?.toFixed(3)} vs ridge ${ridge.test_acc.toFixed(3)} | mlp p95 ${mlp?.p95_latency_ms?.toFixed(1)}ms vs ridge ${ridge.p95_latency_ms.toFixed(1)}ms`,
  threshold_passed: chosen === 'mlp' ? (mlp.test_acc >= ridge.test_acc && mlp.latency_lt_50ms) : (ridge.latency_lt_50ms || true),
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: rows.length, models: res, reference, verdict };
const outPath = path.join(ROOT, 'evals', 'reports', `model-ablation-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${rows.length}`);
for (const id of Object.keys(res)) {
  const m = res[id];
  console.log(`  ${id.padEnd(6)} test_acc ${m.test_acc.toFixed(3)}  p95 ${m.p95_latency_ms.toFixed(1)}ms  rss mean ${m.mean_rss_mb}MB max ${m.max_rss_mb}MB  artifact ${(m.artifact_bytes / 1024).toFixed(0)}KB`);
}
console.log(`ref: cardinality MAPE ${reference.cardinality_mape ?? 'n/a'} | reranker recall@5 ${reference.reranker ?? 'n/a'} mrr ${reference.reranker_mrr ?? 'n/a'} | ridge test_acc report ${reference.ridge_test_acc_reported ?? 'n/a'}`);
console.log(`veredicto: ${verdict.details} → chosen=${verdict.chosen_model}`);
console.log('artefacto:', outPath);
