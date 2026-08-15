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

const MODEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'model/classifier.json');

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

// --- CLI ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const task = process.argv[2];
  let payload = {};
  try { payload = JSON.parse(process.argv[3] ?? '{}'); } catch { payload = {}; }
  const t0 = Date.now();
  if (task === 'classify-query' && payload.query) {
    const r = classify(String(payload.query));
    process.stdout.write(JSON.stringify({ ...r, latencyMs: Date.now() - t0 }) + '\n');
  }
  // otros tasks → sin salida → local-model devuelve null → fallback heurístico
}
