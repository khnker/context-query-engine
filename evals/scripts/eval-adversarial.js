#!/usr/bin/env node
/**
 * evals/scripts/eval-adversarial.js — workloads adversariales (change adversarial-workloads).
 * 30 queries (10 categorías × 3) sobre polar + t1. Por query: run heurístico +
 * oracle FORCE_PLAN A/B/C → regret. Detecta token explosion (>5× mediana) y
 * false confidence (plan.confidence >= 0.9 con correctness 0).
 * Categorías sin match real (zero-results, vendor-code): correcto = 0 resultados.
 * Artefacto: evals/reports/adversarial-<TS>.json + tabla por categoría.
 * Node.js ESM, stdlib SOLO.
 *
 * Uso: node evals/scripts/eval-adversarial.js [--limit N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const REPO_DIRS = {
  polar: '/home/nicolas/dev/polar',
  't1-basic': 'evals/datasets/repos/t1-basic',
  't1-modular': 'evals/datasets/repos/t1-modular',
};
const EMPTY_GT_CATS = new Set(['zero-results']);
// vendor-code: la propiedad adversarial NO es "0 resultados" sino NO FILTRAR node_modules
const VENDOR_CAT = 'vendor-code';

if (process.argv.includes('--limit')) {
  DATASET.length = Math.min(DATASET.length, Number(process.argv[process.argv.indexOf('--limit') + 1]));
}

function hit(ranked, ground) {
  return ground.some((g) => ranked.some((f) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)));
}

function runEngine(cqp, repoDir, extraEnv = {}) {
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const t0 = Date.now();
  const env = { ...process.env, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...extraEnv };
  try {
    const out = execFileSync('node', [ENGINE, cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    return {
      tokens: parsed.stats?.tokens_used ?? 0,
      latency_ms: Date.now() - t0,
      results: [...new Set((parsed.results ?? []).map((x) => x.path))],
      plan: parsed.plan?.selected ?? null,
      confidence: parsed.plan?.confidence ?? null,
      early: parsed.stats?.early_terminated ?? false,
      error: null,
    };
  } catch (e) {
    return { tokens: 0, latency_ms: Date.now() - t0, results: [], plan: null, confidence: null, early: false, error: String(e.code ?? e.message ?? e).slice(0, 80) };
  }
}

const rows = [];
for (const t of DATASET) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[t.repo] ?? t.repo);
  if (!fs.existsSync(repoDir)) { console.error('repo faltante:', t.repo); continue; }
  const ground = [...(t.primary ?? []), ...(t.related ?? []), ...(t.tests ?? [])];
  const heur = runEngine(t.cqp, repoDir);
  const forced = {};
  for (const pid of ['A', 'B', 'C']) forced[pid] = runEngine(t.cqp, repoDir, { FORCE_PLAN: pid });
  const oracleTokens = Math.min(...Object.values(forced).map((r) => r.tokens));
  const reg = oracleTokens > 0 ? (heur.tokens - oracleTokens) / oracleTokens : (heur.tokens > 0 ? 1 : 0);
  const emptyGt = EMPTY_GT_CATS.has(t.category);
  const isVendor = t.category === VENDOR_CAT;
  const correct = emptyGt ? heur.results.length === 0
    : isVendor ? !heur.results.some((f) => f.includes('node_modules'))
    : hit(heur.results, ground);
  rows.push({ id: t.id, category: t.category, repo: t.repo, correct, emptyGt, gt_hits: hit(heur.results, ground) ? ground.filter((g) => heur.results.some((f) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f))).length : 0, n_ground: ground.length, tokens: heur.tokens, latency_ms: heur.latency_ms, regret: reg, plan: heur.plan, confidence: heur.confidence, early: heur.early, error: heur.error, n_results: heur.results.length });
}

const tokensAll = rows.map((r) => r.tokens).filter((t) => t > 0).sort((a, b) => a - b);
const median = tokensAll.length ? tokensAll[Math.floor(tokensAll.length / 2)] : 0;
const EXPLOSION_K = 5;
for (const r of rows) {
  r.token_explosion = median > 0 && r.tokens > EXPLOSION_K * median;
  r.false_confidence = !r.emptyGt && !r.correct && (r.confidence ?? 0) >= 0.9;
}

const cats = {};
for (const r of rows) (cats[r.category] ??= []).push(r);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const categories = {};
const verdicts = [];
for (const [cat, rs] of Object.entries(cats)) {
  const correctRate = rs.filter((r) => r.correct).length / rs.length;
  const expl = rs.filter((r) => r.token_explosion).length;
  const fc = rs.filter((r) => r.false_confidence).length;
  categories[cat] = {
    n: rs.length,
    correctness: correctRate,
    tokens_mean: mean(rs.map((r) => r.tokens)),
    latency_ms_mean: mean(rs.map((r) => r.latency_ms)),
    regret_mean: mean(rs.map((r) => r.regret)),
    token_explosions: expl,
    false_confidence: fc,
    errors: rs.filter((r) => r.error).length,
    details: rs.map((r) => ({ id: r.id, correct: r.correct, tokens: r.tokens, plan: r.plan, confidence: r.confidence, error: r.error ?? null })),
  };
  const ok = correctRate >= 0.8 && expl === 0;
  verdicts.push({ category: cat, pass: ok, correctness: correctRate, explosions: expl });
}

const zeroMatchExplosions = rows.filter((r) => r.emptyGt && r.token_explosion).length;
const allPass = verdicts.every((v) => v.pass) && zeroMatchExplosions === 0;
const verdict = {
  pass: allPass,
  details: verdicts.map((v) => `${v.category}: ${v.correctness.toFixed(3)} (expl ${v.explosions})`).join(' | '),
  zero_match_explosions: zeroMatchExplosions,
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: rows.length, median_tokens: median, explosion_k: EXPLOSION_K, categories, verdict, matrix: Object.entries(categories).map(([c, v]) => ({ category: c, correctness: v.correctness, tokens: Math.round(v.tokens_mean), latency: Math.round(v.latency_ms_mean), regret: +v.regret_mean.toFixed(3), explosions: v.token_explosions, false_confidence: v.false_confidence })) };
const outPath = path.join(ROOT, 'evals', 'reports', `adversarial-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${rows.length} | mediana tokens: ${median}`);
for (const m of artifact.matrix) {
  console.log(`  ${m.category.padEnd(26)} correct ${m.correctness.toFixed(3)}  tok ${m.tokens}  lat ${m.latency}ms  regret ${m.regret}  expl ${m.explosions}  fc ${m.false_confidence}`);
}
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'}`);
console.log(verdict.details);
console.log('artefacto:', outPath);
