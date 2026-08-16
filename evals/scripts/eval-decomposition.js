#!/usr/bin/env node
/**
 * evals/scripts/eval-decomposition.js — physical-query-decomposition (change 02).
 * 8 queries intent multi-facet (evals/datasets/decompose-queries.json) con GT real.
 * Baseline (intent simple) vs CF_DECOMPOSE=1 (sub-consultas físicas fusionadas).
 * Hipótesis: descomposición AÑADE gt_hits en queries multi-facet (callers/impl)
 * sin degradar correctness; coste = tokens extra documentado.
 * Verdict: decomposed.correctness >= baseline.correctness (y se reporta gt delta).
 * Uso: node evals/scripts/eval-decomposition.js  → evals/reports/decomposition-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const QUERIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/decompose-queries.json'), 'utf8'));
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'), 't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const tmp = path.join(ROOT, '.tmp');

function run(q, decompose) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[q.repo]);
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...(decompose ? { CF_DECOMPOSE: '1' } : {}) };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, '--intent', q.intent], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  const j = JSON.parse(out.toString());
  const ground = (q.primary || []).concat(q.related || []).concat(q.tests || []);
  const paths = [...new Set((j.results ?? []).map((r) => (r.path || '').replace(/^\.\//, '')))];
  const hits = ground.filter((g) => paths.some((f) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)));
  return { id: q.id, repo: q.repo, tokens: j.stats?.tokens_used ?? 0, latency_ms: Date.now() - t0,
    gt_hits: hits.length, n_ground: ground.length, correct: hits.length > 0, hits,
    decomposed: j.stats?.decomposed ?? null, results: paths.length };
}

const rows = [];
for (const q of QUERIES) {
  const base = run(q, false);
  const dec = run(q, true);
  rows.push({ id: q.id, repo: q.repo, baseline: base, decomposed: dec,
    gt_delta: dec.gt_hits - base.gt_hits, tokens_delta: dec.tokens - base.tokens,
    decomposed_run: dec.decomposed });
}

const bOk = rows.filter((r) => r.baseline.correct).length / rows.length;
const dOk = rows.filter((r) => r.decomposed.correct).length / rows.length;
const gtGain = rows.filter((r) => r.gt_delta > 0).length;
const gtLoss = rows.filter((r) => r.gt_delta < 0).length;
const tokenMean = rows.reduce((a, r) => a + r.tokens_delta, 0) / rows.length;
const verdict = {
  correctness: { baseline: +bOk.toFixed(3), decomposed: +dOk.toFixed(3), ok: dOk >= bOk },
  gt_gain_tasks: gtGain, gt_loss_tasks: gtLoss, tokens_delta_mean: Math.round(tokenMean),
  n_decomposed: rows.filter((r) => r.decomposed_run?.runs > 1).length,
  pass: dOk >= bOk,
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: rows.length, verdict, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `decomposition-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

for (const r of rows) {
  const d = r.decomposed_run;
  console.log(`${r.id} [${r.repo}] gt ${r.baseline.gt_hits}/${r.decomposed.gt_hits} (Δ${r.gt_delta}) tok ${r.baseline.tokens}→${r.decomposed.tokens} facets ${d ? (d.facets || []).join('+') || '-' : '-'}`);
}
console.log(`correctness: baseline ${bOk.toFixed(3)} → decomposed ${dOk.toFixed(3)} | gt gain ${gtGain}/${rows.length} tasks, loss ${gtLoss} | Δtokens ${Math.round(tokenMean)}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'}`);
console.log('artefacto:', outPath);