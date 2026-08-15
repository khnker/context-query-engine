#!/usr/bin/env node
/**
 * evals/scripts/eval-abstain.js — ABSTAIN / No-Answer (change abstain-no-answer).
 * Dataset no-gold (evals/datasets/no-gold.json, 24 queries sin respuesta real)
 * + split gold (tasks.json t1-basic/t1-modular). Engine con CF_ABSTAIN=1.
 * Métricas: abstention precision (correct abstains / total abstains), coverage
 * no-gold (rate de abstain correcto), coverage gold (gold NO abstiene),
 * FP/FN retrieval. Umbral 6.5: precision ≥ 0.7 AND coverage_gold ≥ 0.8.
 * Artefacto: evals/reports/abstain-<TS>.json
 * Node.js ESM, stdlib SOLO. Uso: node evals/scripts/eval-abstain.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const NO_GOLD = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/no-gold.json'), 'utf8'));
const GOLD = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');

const REPO_DIRS = { polar: '/home/nicolas/dev/polar', 't1-basic': 'evals/datasets/repos/t1-basic', 't1-modular': 'evals/datasets/repos/t1-modular' };

function runEngine(task) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const t0 = Date.now();
  const parsed = JSON.parse(execFileSync('node', [ENGINE, task.cqp], {
    cwd: repoDir,
    env: { ...process.env, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), CF_ABSTAIN: '1' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000,
  }));
  return { ...parsed, latency_ms: Date.now() - t0 };
}

const goldGround = (t) => [...(t.primary ?? []), ...(t.related ?? []), ...(t.tests ?? [])];

const rows = [];
for (const t of NO_GOLD) {
  const r = runEngine(t);
  if (!r) { console.error(`skip ${t.id} (repo ausente)`); continue; }
  const abstained = r.abstained === true;
  rows.push({ id: t.id, split: 'no-gold', repo: t.repo, category: t.category, abstained, tokens: r.stats?.tokens_used ?? 0, results: (r.results ?? []).length, reason: r.reason ?? null, plan: r.plan?.selected ?? null, latency_ms: r.latency_ms });
}
for (const t of GOLD) {
  const r = runEngine(t);
  if (!r) { console.error(`skip ${t.id} (repo ausente)`); continue; }
  const abstained = r.abstained === true;
  rows.push({ id: t.id, split: 'gold', repo: t.repo, abstained, tokens: r.stats?.tokens_used ?? 0, results: (r.results ?? []).length, reason: r.reason ?? null, plan: r.plan?.selected ?? null, latency_ms: r.latency_ms });
}

const ng = rows.filter((r) => r.split === 'no-gold');
const gd = rows.filter((r) => r.split === 'gold');
const abstains = rows.filter((r) => r.abstained);
const correctAbstain = abstains.filter((r) => r.split === 'no-gold').length;
const abstainPrecision = abstains.length ? correctAbstain / abstains.length : 0;
const coverageNoGold = ng.length ? ng.filter((r) => r.abstained).length / ng.length : 0;
const coverageGold = gd.length ? gd.filter((r) => !r.abstained).length / gd.length : 0;
const fpRetrieval = ng.filter((r) => !r.abstained).length;   // no-gold respondido (debió abstener)
const fnRetrieval = gd.filter((r) => r.abstained).length;    // gold que abstuvo (debió responder)

const verdict = { pass: abstainPrecision >= 0.7 && coverageGold >= 0.8, abstention_precision: +abstainPrecision.toFixed(3), coverage_no_gold: +coverageNoGold.toFixed(3), coverage_gold: +coverageGold.toFixed(3), fp_retrieval: fpRetrieval, fn_retrieval: fnRetrieval, threshold: 'precision >= 0.7 AND coverage_gold >= 0.8' };

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), total: rows.length, no_gold: ng.length, gold: gd.length, abstains: abstains.length, verdict, rows, misclassified: rows.filter((r) => (r.split === 'no-gold') !== r.abstained).map((r) => ({ id: r.id, split: r.split, abstained: r.abstained })) };
const outPath = path.join(ROOT, 'evals', 'reports', `abstain-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`no-gold: ${ng.length} | gold: ${gd.length} | abstains: ${abstains.length} (${abstains.filter((r) => r.split === 'gold').length} sobre gold)`);
console.log(`abstention precision: ${abstainPrecision.toFixed(3)} | coverage no-gold: ${coverageNoGold.toFixed(3)} | coverage gold: ${coverageGold.toFixed(3)}`);
console.log(`FP retrieval (no-gold respondido): ${fpRetrieval} | FN retrieval (gold abstuvo): ${fnRetrieval}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.threshold}`);
for (const r of rows.filter((r) => (r.split === 'no-gold') !== r.abstained)) {
  console.log(`  MISCLAS ${r.id} [${r.split}] abstained=${r.abstained} reason=${r.reason ?? ''} tokens=${r.tokens}`);
}
console.log('artefacto:', outPath);
