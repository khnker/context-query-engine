#!/usr/bin/env node
/**
 * evals/scripts/export-cardinality-features.js — 13.1/13.2: dataset de cardinalidad.
 * Lee engine/statistics.ndjson (obs: operator, queryClass, scope, ts, estimated,
 * actual{candidates,tokens,latencyMs}) y exporta una fila por ejecución con
 * FEATURES + target actual_candidates. Luego split 70/15/15 determinista (hash).
 * Insumo para el cost model aprendido (13.3+) — entrenamiento out-of-band.
 * Node ESM, stdlib SOLO.
 *
 * Uso: node evals/scripts/export-cardinality-features.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATS = path.join(ROOT, 'engine', 'statistics.ndjson');
const OUT = path.join(ROOT, 'evals/ml/model', 'cardinality-dataset.jsonl');

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const lines = fs.existsSync(STATS) ? fs.readFileSync(STATS, 'utf8').split('\n').filter(Boolean) : [];
const rows = [];
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch { continue; }
  if (!o || !o.operator || !o.queryClass) continue;
  const actual = o.actual ?? {};
  const estimated = o.estimated ?? {};
  const candidates = Number(actual.candidates);
  if (!Number.isFinite(candidates)) continue;
  rows.push({
    operator: o.operator,
    queryClass: o.queryClass,
    scope: o.scope ?? '',
    ts: o.ts,
    est_candidates: Number(estimated.candidates) || 0,
    est_tokens: Number(estimated.tokens) || 0,
    actual_candidates: candidates,
    actual_tokens: Number(actual.tokens) || 0,
    latency_ms: Number(actual.latencyMs) || 0,
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// split 70/15/15 por hash del (operator|queryClass|ts) — determinista
const parts = { train: [], val: [], test: [] };
const sorted = rows.slice().sort((a, b) => hash(a.operator + '|' + a.queryClass + '|' + a.ts) - hash(b.operator + '|' + b.queryClass + '|' + b.ts));
sorted.forEach((r, i) => {
  const n = sorted.length;
  if (i < Math.round(n * 0.7)) parts.train.push(r);
  else if (i < Math.round(n * 0.85)) parts.val.push(r);
  else parts.test.push(r);
});
for (const [k, v] of Object.entries(parts)) {
  fs.writeFileSync(path.join(ROOT, 'evals/ml/model', `cardinality-${k}.jsonl`), v.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const ops = {};
for (const r of rows) ops[r.operator] = (ops[r.operator] ?? 0) + 1;
console.log(JSON.stringify({ total: rows.length, splits: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length])), by_operator: ops }, null, 2));
