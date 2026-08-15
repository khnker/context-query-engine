#!/usr/bin/env node
/**
 * evals/ml/classify.mjs — Inferencia local del clasificador (Phase 11.6).
 * Sirve como CF_MODEL_CMD para engine/local-model.js:
 *   CF_MODEL_CMD="node evals/ml/classify.mjs"
 * Contrato: <task> '<payload-json>' → stdout JSON. classify-query → {label, scores,
 * confidence, latencyMs}. Otros tasks (rerank/estimate-cardinality) → sin salida
 * (null → el optimizer usa el fallback heurístico).
 * Node ESM, stdlib SOLO. Lee evals/ml/model/classifier.json (type:linear|transformer).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODEL = process.env.CF_MODEL_FILE ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'model/classifier.json');

const CLASSES = ['LEXICAL', 'STRUCTURAL', 'SYMBOL', 'REFERENCE', 'SEMANTIC',
  'DEPENDENCY', 'CONFIGURATION', 'TEST', 'GIT', 'COMPOSITE'];

function djb2(buf) {
  let h = 5381;
  for (const b of buf) h = ((h * 33) + b) >>> 0;
  return h;
}

function ngrams(text) {
  // char n-grams rango 2-4 (DEBE coincidir con el trainer python, evals/ml/train-classifier.py)
  const t = '#' + text.toLowerCase() + '#';
  const out = new Set();
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n));
  }
  return out;
}

function featurize(text, H) {
  const x = new Float64Array(H);
  for (const g of ngrams(text)) {
    const idx = djb2(Buffer.from(g)) % H;
    x[idx] = 1;
  }
  return x;
}

function softmax(v) {
  const m = Math.max(...v);
  const e = v.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

export function classify(text) {
  const model = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
  const H = model.H;
  const x = featurize(text, H);
  
  if (model.type === 'mlp') {
    const H_hid = model.H_hid;
    const W1 = model.W1;
    const b1 = model.b1;
    const W2 = model.W2;
    const b2 = model.b2;
    // hidden Z1 = x @ W1 + b1
    const z1 = new Float64Array(H_hid);
    for (let j = 0; j < H_hid; j++) {
      let acc = b1[j];
      for (let i = 0; i < H; i++) {
        acc += x[i] * W1[i][j];
      }
      z1[j] = Math.max(0, acc); // ReLU
    }
    // output Z2 = z1 @ W2 + b2
    const logits = CLASSES.map((_, c) => {
      let acc = b2[c];
      for (let j = 0; j < H_hid; j++) {
        acc += z1[j] * W2[j][c];
      }
      return acc;
    });
    const scores = softmax(logits);
    const idx = scores.indexOf(Math.max(...scores));
    return { label: CLASSES[idx], scores, confidence: scores[idx] };
  } else {
    const W = model.W; // H × C
    const logits = CLASSES.map((_, c) => {
      let acc = 0;
      for (let i = 0; i < H; i++) acc += x[i] * W[i][c];
      return acc;
    });
    const scores = softmax(logits);
    const idx = scores.indexOf(Math.max(...scores));
    return { label: CLASSES[idx], scores, confidence: scores[idx] };
  }
}

const RERANKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'model/reranker-model.json');

function rerankerScores(query, paths) {
  // misma featureización que train-reranker.py: char n-grams (2-4) de 'query|path' hasheados
  let model;
  try {
    model = JSON.parse(fs.readFileSync(RERANKER, 'utf8'));
  } catch {
    return null; // sin modelo → null → fallback heurístico
  }
  const H = model.H;
  const W = model.W;
  const score = (q, p) => {
    const t = '#' + q.toLowerCase() + '#' + '|' + '#' + p.toLowerCase() + '#';
    const x = new Float64Array(H);
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i <= t.length - n; i++) {
        x[djb2(Buffer.from(t.slice(i, i + n))) % H] = 1;
      }
    }
    let acc = 0;
    for (let i = 0; i < H; i++) acc += x[i] * W[i];
    return 1 / (1 + Math.exp(-Math.min(30, Math.max(-30, acc)))); // sigmoid
  };
  return paths.map((p) => score(query, p));
}

// 13.5 — estimate-cardinality: ridge (evals/ml/model/cardinality-model.json; CF_CARD_MODEL para modelos alternos/OOD)
const CARD_MODEL = process.env.CF_CARD_MODEL ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'model/cardinality-model.json');

export function estimateCardinality(payload = {}) {
  if (!fs.existsSync(CARD_MODEL)) return null;
  const m = JSON.parse(fs.readFileSync(CARD_MODEL, 'utf8'));
  const f = new Array(m.W.length).fill(0.0);
  const op = m.op_idx[payload.operator];
  const qc = m.qc_idx[payload.queryClass];
  if (op !== undefined) f[op] = 1.0;
  if (qc !== undefined) f[Object.keys(m.op_idx).length + qc] = 1.0;
  const est = Number(payload.est_candidates) || 0;
  f[f.length - 1] = Math.log1p(Math.max(0, est));
  let acc = 0;
  for (let i = 0; i < m.W.length; i++) acc += f[i] * m.W[i];
  return { candidates: Math.max(0, Math.round(Math.expm1(Math.min(acc, 20)))), model: 'ridge-cardinality' };
}

// --- CLI ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const task = process.argv[2];
  let payload = {};
  try { payload = JSON.parse(process.argv[3] ?? '{}'); } catch { payload = {}; }
  const t0 = Date.now();
  if (task === 'classify-query' && payload.query) {
    const r = classify(String(payload.query));
    process.stdout.write(JSON.stringify({ ...r, latencyMs: Date.now() - t0, rssBytes: process.memoryUsage().rss }) + '\n');
  } else if (task === 'estimate-cardinality') {
    const r = estimateCardinality(payload);
    if (r) process.stdout.write(JSON.stringify({ ...r, latencyMs: Date.now() - t0 }) + '\n');
  } else if (task === 'rerank' && payload.query && Array.isArray(payload.results)) {
    const scores = rerankerScores(String(payload.query), payload.results.map(String));
    if (scores) {
      process.stdout.write(JSON.stringify({ scores, latencyMs: Date.now() - t0 }) + '\n');
    }
  }
  // otros tasks → sin salida → local-model devuelve null → fallback heurístico
}
