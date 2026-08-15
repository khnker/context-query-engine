#!/usr/bin/env node
/**
 * evals/scripts/eval-failure-modes.js — comparación rg (raw) vs CQE en casos triviales
 * donde CQE pierde contra una búsqueda léxica directa (change failure-modes-where-cqe-loses).
 *
 * Dataset: evals/datasets/failure-modes.json (24 queries, 6 categorías):
 *   exact-filename | exact-symbol | single-file | one-shot | tiny-repo | trivial-regex
 *
 * Por query corre AMBOS modos sobre el mismo repo:
 *   raw: rg -n --no-ignore -g!node_modules con las palabras de la query (top-10 files por hits)
 *   cqe: engine (plan por defecto, sin flags)
 * Métricas: correctness (gt_hits>0), tokens, latency_ms (+ selected_plan para cqe).
 * 4.3 overhead: latency_cqe−latency_raw y tokens_cqe−tokens_raw por query → media por categoría.
 * 4.5 verdict: lose_rate = (raw.correct && !cqe.correct)/n > 30% → mitigación requerida.
 * Artefacto: evals/reports/failure-modes-<TS>.json.
 *
 * Uso: TMPDIR=$PWD/.tmp node evals/scripts/eval-failure-modes.js
 * Node.js ESM, stdlib SOLO.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/failure-modes.json'), 'utf8'));
const REPO_DIRS = {
  't1-basic': 'evals/datasets/repos/t1-basic',
  't1-modular': 'evals/datasets/repos/t1-modular',
  polar: '/home/nicolas/dev/polar',
};
const STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'que', 'y', 'a', 'en', 'se', 'con', 'para',
  'dónde', 'donde', 'está', 'esta', 'es', 'del', 'por', 'al', 'definido', 'define', 'defina',
  'archivo', 'función', 'funcion', 'variable', 'constante', 'patrón', 'patron', 'top', 'usado',
  'usa', 'usar', 'cuál', 'cual', 'cómo', 'como', 'hace', 'qué', 'real', 'encontrar', 'buscar',
]);

function ground(task) {
  return [...(task.primary ?? []), ...(task.related ?? []), ...(task.tests ?? [])];
}

function matches(f, g) {
  return f === g || f.endsWith('/' + g) || g.endsWith('/' + f);
}

function queryWords(query) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w)); // >=3 evita ruido tipo 'ts'/'py'/'el'
}

// --- raw: rg -n top-10 files por hits, tokens = suma de line-length/4 ---
function runRaw(query, repoDir) {
  const words = queryWords(query);
  const args = ['-n', '--no-ignore', '-g', '!node_modules', ...words.flatMap((w) => ['-e', w]), '.'];
  const t0 = Date.now();
  let out = '';
  try {
    out = execFileSync('rg', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.stdout) out = e.stdout; // rg exit 1 = sin matches
  }
  const latencyMs = Date.now() - t0;
  const perFile = new Map(); // path -> {hits, tokens}
  for (const line of out.split('\n')) {
    if (!line) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const p = line.slice(0, i);
    const content = line.slice(i + 1);
    const e2 = content.indexOf(':');
    const body = e2 >= 0 ? content.slice(e2 + 1) : content;
    const cur = perFile.get(p) ?? { hits: 0, tokens: 0 };
    cur.hits += 1;
    cur.tokens += Math.ceil(body.length / 4);
    perFile.set(p, cur);
  }
  const ranked = [...perFile.entries()]
    .sort((a, b) => b[1].hits - a[1].hits)
    .slice(0, 10)
    .map(([p]) => p);
  // tokens = longitud total del output rg / 4 (misma fórmula que eval-baselines raw_rg)
  const tokens = Math.ceil(out.length / 4);
  return { ranked, tokens, latencyMs };
}

// --- cqe: engine default plan (cache borrado por determinismo) ---
function runCqe(cqp, repoDir) {
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = {
    ...process.env,
    TMPDIR: path.join(ROOT, '.tmp'),
    CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
  };
  const t0 = Date.now();
  let parsed = null;
  try {
    const out = execFileSync('node', [ENGINE, cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    // stdout del CLI = 1 JSON final {plan, results, stats}; tolerar líneas stray (telemetría)
    for (const l of out.split('\n').reverse()) {
      if (!l) continue;
      try {
        const o = JSON.parse(l);
        if (o && Array.isArray(o.results) && o.plan) { parsed = o; break; }
      } catch { /* línea no-JSON */ }
    }
  } catch (e) { parsed = null; }
  const latencyMs = Date.now() - t0;
  if (!parsed) return { ranked: [], tokens: 0, latencyMs, selected_plan: 'ERROR', error: true };
  const ranked = [...new Set((parsed.results ?? []).map((x) => x.path))];
  return { ranked, tokens: parsed.stats?.tokens_used ?? 0, latencyMs, selected_plan: parsed.plan?.selected ?? '?', error: false };
}

const rows = [];
for (const t of DATASET) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[t.repo] ?? t.repo);
  if (!fs.existsSync(repoDir)) {
    rows.push({ id: t.id, category: t.category, repo: t.repo, raw: { correct: false, tokens: 0, latencyMs: 0, skipped: true }, cqe: { correct: false, tokens: 0, latencyMs: 0, selected_plan: 'SKIP', skipped: true } });
    continue;
  }
  const gt = ground(t);
  const r = runRaw(t.query, repoDir);
  const c = runCqe(t.cqp, repoDir);
  const rCorrect = gt.some((g) => r.ranked.some((f) => matches(f, g)));
  const cCorrect = gt.some((g) => c.ranked.some((f) => matches(f, g)));
  rows.push({
    id: t.id, category: t.category, repo: t.repo,
    raw: { correct: rCorrect, tokens: r.tokens, latencyMs: r.latencyMs },
    cqe: { correct: cCorrect, tokens: c.tokens, latencyMs: c.latencyMs, selected_plan: c.selected_plan },
  });
}

const cats = [...new Set(rows.map((r) => r.category))];
const perCategory = {};
for (const cat of cats) {
  const rs = rows.filter((r) => r.category === cat);
  const agg = (side) => {
    const correct = rs.filter((r) => r[side].correct).length / rs.length;
    const tokens = rs.reduce((a, r) => a + r[side].tokens, 0) / rs.length;
    const latency = rs.reduce((a, r) => a + r[side].latencyMs, 0) / rs.length;
    return { correctness: correct, tokens_mean: tokens, latency_mean: latency };
  };
  perCategory[cat] = { raw: agg('raw'), cqe: agg('cqe') };
}

const overheadLat = rows.reduce((a, r) => a + (r.cqe.latencyMs - r.raw.latencyMs), 0) / rows.length;
const overheadTok = rows.reduce((a, r) => a + (r.cqe.tokens - r.raw.tokens), 0) / rows.length;
const lose = rows.filter((r) => r.raw.correct && !r.cqe.correct);
const loseRate = lose.length / rows.length;
const THRESHOLD = 0.30;
const mitigationNeeded = loseRate > THRESHOLD;
const verdict = {
  lose_rate: loseRate,
  threshold_30pct: THRESHOLD,
  mitigation_needed: mitigationNeeded,
  pass: !mitigationNeeded,
  lost: lose.map((r) => r.id),
};

const TS = Date.now();
const artifact = {
  date: new Date().toISOString().slice(0, 10),
  tasks: rows.length,
  per_category: perCategory,
  overhead: { latency_mean_ms: overheadLat, tokens_mean: overheadTok },
  verdict,
  rows,
};
const outPath = path.join(ROOT, 'evals', 'reports', `failure-modes-${TS}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${rows.length} | categorías: ${cats.join(', ')}`);
console.log('categoría          raw[corr tok  lat]   cqe[corr tok  lat]   plan  Δlat  Δtok');
for (const cat of cats) {
  const p = perCategory[cat];
  const lat = p.cqe.latency_mean - p.raw.latency_mean;
  const tok = p.cqe.tokens_mean - p.raw.tokens_mean;
  console.log(
    `${cat.padEnd(17)} raw[${p.raw.correctness.toFixed(2)} ${String(Math.round(p.raw.tokens_mean)).padStart(4)} ${String(Math.round(p.raw.latency_mean)).padStart(4)}ms]  ` +
    `cqe[${p.cqe.correctness.toFixed(2)} ${String(Math.round(p.cqe.tokens_mean)).padStart(4)} ${String(Math.round(p.cqe.latency_mean)).padStart(4)}ms]  ${Math.round(lat)}ms ${Math.round(tok)}tok`
  );
}
console.log(`overhead global: latency ${Math.round(overheadLat)}ms media, tokens ${Math.round(overheadTok)} media`);
for (const r of rows) {
  console.log(`  ${r.id.padEnd(17)} ${r.category.padEnd(15)} raw:${r.raw.correct ? 'OK ' : 'FAIL'} (${r.raw.tokens}t ${r.raw.latencyMs}ms)  cqe:${r.cqe.correct ? 'OK ' : 'FAIL'} (${r.cqe.tokens}t ${r.cqe.latencyMs}ms, plan ${r.cqe.selected_plan})`);
}
console.log(`verdict: ${verdict.pass ? 'PASS' : 'FAIL'} — lose_rate ${loseRate.toFixed(3)} ${loseRate > THRESHOLD ? '>' : '<='} 0.30 ${mitigationNeeded ? '→ mitigación requerida' : '→ no mitigación'}`);
if (lose.length) console.log('lost:', lose.map((r) => r.id).join(', '));
console.log('artefacto:', outPath);
