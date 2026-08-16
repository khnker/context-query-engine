#!/usr/bin/env node
/**
 * evals/scripts/eval-ir.js — context-query-ir: access paths del índice vs rg.
 * CF_TASKS=t1 (32) | dev (14). Modos: cqe (default rg) vs index (CF_INDEX=1);
 * warmup por repo construye el catálogo (build), luego runs medidos.
 * Métricas: correctness, recall@5/@10, MRR, tokens, latency + build_time.
 * Umbral: correctness_index ≥ correctness_cqe (sin degradación).
 * Artefacto: evals/reports/ir-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const DEV = fs.existsSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'), 'utf8')) : [];
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', dev: path.resolve(ROOT, '..'),
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };

const tasks = process.env.CF_TASKS === 'dev' ? DEV : TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const limitIdx = process.argv.indexOf('--limit');
if (limitIdx > 0) tasks.length = Math.min(tasks.length, Number(process.argv[limitIdx + 1]));

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function recallAtK(ranked, ground, k) {
  const top = ranked.slice(0, k);
  const hits = top.filter((f) => ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f))).length;
  return ground.length ? hits / Math.min(k, ground.length) : 1;
}
function mrr(ranked, ground) {
  for (let i = 0; i < ranked.length; i++) {
    if (ground.some((g) => ranked[i] === g || ranked[i].endsWith('/' + g) || g.endsWith('/' + ranked[i]))) return 1 / (i + 1);
  }
  return 0;
}

function run(task, env) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env: { ...process.env, TMPDIR: path.join(ROOT, '.tmp'), CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  const j = JSON.parse(out.toString());
  return { latency_ms: Date.now() - t0, tokens: j.stats?.tokens_used ?? 0, results: j.results ?? [], plan: j.plan?.selected ?? null };
}

// warmup: construir índices por repo (build medido en la 1ª consulta)
const buildMs = {};
const agg = { cqe: { ok: 0, r5: [], mrr: [], tok: [], lat: [] }, index: { ok: 0, r5: [], mrr: [], tok: [], lat: [] } };
const rows = [];
for (const task of tasks) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  const ground = groundOf(task);
  if (!(task.repo in buildMs)) {
    const b0 = Date.now();
    try { run(task, { CF_INDEX: '1' }); } catch { /* build */ }
    buildMs[task.repo] = Date.now() - b0;
  }
  for (const mode of ['cqe', 'index']) {
    const env = mode === 'index' ? { CF_INDEX: '1' } : {};
    const r = run(task, env);
    if (!r) continue;
    const ranked = [...new Set(r.results.map((x) => x.path))];
    const hits = ground.filter((g) => ranked.some((f) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)));
    const a = agg[mode];
    a.ok += hits.length > 0 ? 1 : 0;
    a.r5.push(recallAtK(ranked, ground, 5));
    a.mrr.push(mrr(ranked, ground));
    a.tok.push(r.tokens);
    a.lat.push(r.latency_ms);
    rows.push({ id: task.id, mode, gt: hits.length, n_ground: ground.length, tokens: r.tokens, plan: r.plan, results: ranked.length });
  }
}

const n = tasks.length;
const fmt = (m) => ({ correctness: m.ok / n, recall5: m.r5.reduce((a, b) => a + b, 0) / n, mrr: m.mrr.reduce((a, b) => a + b, 0) / n, tokens_mean: m.tok.reduce((a, b) => a + b, 0) / n, latency_mean: m.lat.reduce((a, b) => a + b, 0) / n });
const cqe = fmt(agg.cqe), idx = fmt(agg.index);
const verdict = { pass: idx.correctness >= cqe.correctness, correctness: { cqe: cqe.correctness, index: idx.correctness }, detail: `index ${idx.correctness.toFixed(3)} vs cqe ${cqe.correctness.toFixed(3)}` };

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: n, build_ms_per_repo: buildMs, cqe, index: idx, verdict, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `ir-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${n} | build/ms por repo: ${JSON.stringify(buildMs)}`);
console.log(`  cqe   correct ${cqe.correctness.toFixed(3)}  r@5 ${cqe.recall5.toFixed(3)}  mrr ${cqe.mrr.toFixed(3)}  tok ${Math.round(cqe.tokens_mean)}  lat ${Math.round(cqe.latency_mean)}ms`);
console.log(`  index correct ${idx.correctness.toFixed(3)}  r@5 ${idx.recall5.toFixed(3)}  mrr ${idx.mrr.toFixed(3)}  tok ${Math.round(idx.tokens_mean)}  lat ${Math.round(idx.latency_mean)}ms`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.detail}`);
console.log('artefacto:', outPath);
for (const r of rows.filter((r) => r.mode === 'index' && r.gt === 0)) console.log('  INDEX-MISS', r.id, '| plan', r.plan, '| results', r.results);