#!/usr/bin/env node
/**
 * evals/scripts/eval-intent-ml.js — 11.8 gate ML: clasificador local vs regex
 * sobre queries-test.jsonl (150 rows, 10 clases). Mide el path de intención NL
 * (interpret), no CQP. Dos vías: heurística (regex) y ML (CF_MODEL_CMD con
 * gate de confianza ≥ 0.6 → fallback si conf baja). Reporta accuracy de cada
 * vía vs ground-truth label, y accuracy efectiva del ML (gate aplicado).
 * Node ESM, stdlib SOLO.
 *
 * Uso: node evals/scripts/eval-intent-ml.js [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpret } from '../../engine/interpreter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST = fs
  .readFileSync(path.join(ROOT, 'evals/datasets/queries-test.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// mismo mapeo que interpreter.js CLASS_TO_TYPE (la fuente de verdad del test)
const CLASS_TO_TYPE = {
  LEXICAL: 'definitions', SYMBOL: 'definitions', STRUCTURAL: 'implementation',
  REFERENCE: 'references', DEPENDENCY: 'references', SEMANTIC: 'concept',
  CONFIGURATION: 'pattern', TEST: 'pattern', GIT: 'implementation', COMPOSITE: 'concept',
};

function runHeuristic(text) {
  const prev = process.env.CF_MODEL_CMD;
  delete process.env.CF_MODEL_CMD;
  try {
    return interpret(text);
  } finally {
    if (prev !== undefined) process.env.CF_MODEL_CMD = prev;
  }
}

function runML(text) {
  const prev = process.env.CF_MODEL_CMD;
  process.env.CF_MODEL_CMD = 'node evals/ml/classify.mjs';
  try {
    return interpret(text);
  } finally {
    if (prev !== undefined) process.env.CF_MODEL_CMD = prev;
    else delete process.env.CF_MODEL_CMD;
  }
}

const rows = [];
let hCorrect = 0;
let mlCorrect = 0;
let mlFired = 0;
let mlFiredCorrect = 0;
let fallbackCount = 0;
let diff = 0;

for (const r of TEST) {
  const expected = CLASS_TO_TYPE[r.label];
  const h = runHeuristic(r.text);
  const m = runML(r.text);
  const hOk = h.query_type === expected;
  const mOk = m.query_type === expected;
  if (hOk) hCorrect += 1;
  if (mOk) mlCorrect += 1;
  if (m.ml) {
    mlFired += 1;
    if (mOk) mlFiredCorrect += 1;
  } else {
    fallbackCount += 1;
  }
  if (m.query_type !== h.query_type) diff += 1;
  rows.push({ text: r.text, label: r.label, h: h.query_type, hOk, m: m.query_type, mOk, ml: m.ml });
}

const n = TEST.length;
const report = {
  n,
  heuristic_acc: Math.round((hCorrect / n) * 1000) / 1000,
  ml_effective_acc: Math.round((mlCorrect / n) * 1000) / 1000,
  ml_fired: mlFired,
  ml_fired_acc: mlFired ? Math.round((mlFiredCorrect / mlFired) * 1000) / 1000 : null,
  fallback_count: fallbackCount,
  queries_with_different_type: diff,
};
report.verdict = report.ml_effective_acc >= report.heuristic_acc ? 'PASS' : 'FAIL';

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ report, rows }, null, 2) + '\n');
} else {
  console.log(`n=${n}`);
  console.log(`  regex  (heurística):       acc ${report.heuristic_acc}`);
  console.log(`  ML efectivo (gate 0.6):    acc ${report.ml_effective_acc} (fired ${mlFired}, fallback ${fallbackCount})`);
  console.log(`  ML cuando dispara:         acc ${report.ml_fired_acc} (${mlFiredCorrect}/${mlFired})`);
  console.log(`  tipos distintos (m vs h):  ${diff}`);
  console.log(`  verdict: ${report.verdict}`);
}
