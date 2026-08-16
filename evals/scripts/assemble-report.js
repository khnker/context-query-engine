#!/usr/bin/env node
/**
 * evals/scripts/assemble-report.js — G2/G3/G5: ensambla artefacto verificable de un run
 * reproduce.sh. Lee raw-runs.ndjson (eval-recall, por-query×modo×run), optimizer-eval.json
 * (opcional) y el manifest → escribe raw-results.jsonl, metrics.json, statistical-tests.json,
 * report.md en el OUT dir. Veredicto PASS/FAIL vs thresholds del manifest (exit 0/1).
 * Uso: node evals/scripts/assemble-report.js <out-dir> <manifest.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [, , outDirArg, manifestArg] = process.argv;
const OUT = path.resolve(ROOT, outDirArg);
const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(ROOT, manifestArg), 'utf8'));

const pct = (x) => (x * 100).toFixed(1) + '%';
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stats(arr) {
  if (!arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length;
  const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  return { n: s.length, mean, median, stddev: Math.sqrt(variance), p95 };
}

function bootstrapCi(pairs, seed, iters = 1000) {
  const rnd = mulberry32(seed);
  const deltas = pairs;
  if (deltas.length < 2) return { ci95: null, n: deltas.length };
  const resampled = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < deltas.length; j++) sum += deltas[Math.floor(rnd() * deltas.length)];
    resampled.push(sum / deltas.length);
  }
  resampled.sort((a, b) => a - b);
  return { ci95: [resampled[Math.floor(iters * 0.025)], resampled[Math.floor(iters * 0.975)]], n: deltas.length };
}

const rawPath = path.join(OUT, 'raw-runs.ndjson');
if (!fs.existsSync(rawPath)) {
  console.error('no raw-runs.ndjson — corre eval-recall con CF_RAW_OUT primero');
  process.exit(2);
}
const rows = fs.readFileSync(rawPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

const modeLabel = { heuristic: 'CQE deterministic', rerank: 'CQE + ML reranker' };
const byMode = {};
for (const row of rows) {
  (byMode[row.mode] ??= []).push(row);
}

const optPath = path.join(OUT, 'optimizer-eval.json');
const opt = fs.existsSync(optPath) ? JSON.parse(fs.readFileSync(optPath, 'utf8')) : null;
const rec = opt?.records ?? [];

const rawResults = rows.map((r) => ({
  query_id: r.query_id, query: r.query, mode: r.mode, run: r.run,
  correct: r.correct, tokens: r.tokens, latency_ms: r.latency_ms,
  gt_hits: r.gt_hits, n_ground: r.n_ground, selected_plan: r.selected_plan,
  oracle_plan: null,
}));
const byQuery = (m) => {
  const out = {};
  for (const r of byMode[m] ?? []) (out[r.query_id] ??= []).push(r);
  return out;
};
const hRows = byQuery('heuristic');
const rRows = byQuery('rerank');
for (const qid of Object.keys(hRows)) {
  const o = rec.find((x) => x.id === qid)?.oracle_plan ?? null;
  if (o) rawResults.forEach((rr) => { if (rr.query_id === qid) rr.oracle_plan = o; });
}

const metrics = {};
for (const m of Object.keys(byMode)) {
  const t = stats(byMode[m].map((r) => r.tokens));
  const l = stats(byMode[m].map((r) => r.latency_ms));
  const correct = byMode[m].filter((r) => r.correct).length / byMode[m].length;
  const r5 = byMode[m].reduce((a, r) => a + (r.recall5 ?? 0), 0) / byMode[m].length;
  const mrr = byMode[m].reduce((a, r) => a + (r.mrr ?? 0), 0) / byMode[m].length;
  metrics[m] = {
    label: modeLabel[m] ?? m,
    tokens: t, latency: l, correctness: correct, recall5: r5, mrr,
    tasks: new Set(byMode[m].map((r) => r.query_id)).size,
  };
}

const tokPairs = [], latPairs = [];
const qids = Object.keys(hRows).filter((q) => rRows[q]);
for (const q of qids) {
  const h = hRows[q].filter((r) => typeof r.run === 'number');
  const rq = rRows[q].filter((r) => typeof r.run === 'number');
  for (let i = 0; i < Math.min(h.length, rq.length); i++) {
    tokPairs.push(h[i].tokens - rq[i].tokens);
    latPairs.push(h[i].latency_ms - rq[i].latency_ms);
  }
}
const tokenCi = bootstrapCi(tokPairs, 42);
const latencyCi = bootstrapCi(latPairs, 42);
const statTests = {
  paired_queries: qids.length,
  token_delta: { mean: tokPairs.reduce((a, b) => a + b, 0) / Math.max(1, tokPairs.length), ci95: tokenCi.ci95 },
  latency_delta: { mean: latPairs.reduce((a, b) => a + b, 0) / Math.max(1, latPairs.length), ci95: latencyCi.ci95 },
  method: 'paired bootstrap, 1000 resamples, seed 42',
};

let report = '';
const hr = '='.repeat(50);
report += `${hr}\nContext Query Engine — Reproducibility Report\n${hr}\n`;
report += `Benchmark: ${MANIFEST.id} (${MANIFEST.description})\n`;
const env = JSON.parse(fs.readFileSync(path.join(OUT, 'environment.json'), 'utf8'));
report += `CQE commit: ${env.cqe_commit}\n`;
for (const r of MANIFEST.repos ?? []) report += `Repo ${r.name}: ${r.path} @ ${env.repo_commits?.[r.name] ?? r.commit}\n`;
report += `Queries: ${qids.length || rows.length} | runs/query: ${MANIFEST.runs} (warmup ${MANIFEST.warmup})\n\n`;
for (const m of Object.keys(metrics)) {
  const mm = metrics[m];
  report += `--- ${mm.label} ---\n`;
  report += `correctness: ${pct(mm.correctness)} | recall@5 ${f3(mm.recall5)} | mrr ${f3(mm.mrr)}\n`;
  report += `tokens: mean ${f1(mm.tokens.mean)} | median ${f1(mm.tokens.median)} | p95 ${f1(mm.tokens.p95)}\n`;
  report += `latency ms: mean ${f1(mm.latency.mean)} | median ${f1(mm.latency.median)} | p95 ${f1(mm.latency.p95)}\n\n`;
}
if (opt && rec.length) {
  const p = opt.report ?? {};
  const planAcc = (typeof p.plan_accuracy === 'object' ? p.plan_accuracy.learned : p.plan_accuracy) ?? null;
  const regret = (typeof p.regret === 'object' ? p.regret.learned : p.regret) ?? null;
  const regretBase = (typeof p.regret === 'object' ? p.regret.heuristic : null) ?? th.regret_max ?? 0.6886;
  report += '--- Optimizer (oracle vs selected) ---\n';
  report += `plan accuracy (learned): ${f3(planAcc)} | regret (learned): ${f3(regret)} (heuristic ${f3(regretBase)}) | gt_recall: ${f3(p.gt_recall)}\n`;
  report += `avg tokens (learned): ${f1(typeof p.avg_tokens === 'object' ? p.avg_tokens.learned : p.avg_tokens)} | avg latency (learned): ${f1(typeof p.avg_latency_ms === 'object' ? p.avg_latency_ms.learned : p.avg_latency_ms)} ms\n\n`;
} else {
  report += '--- Optimizer (oracle vs selected) ---\nSKIP — sin records (queries sin GT o benchmark sin optimizer)\n\n';
}
const piPath = path.join(OUT, 'planner-isolation.json');
if (fs.existsSync(piPath)) {
  const pi = JSON.parse(fs.readFileSync(piPath, 'utf8')).report ?? {};
  const planners = ['first_match', 'heuristic', 'learned', 'oracle'];
  report += '--- Planner isolation (same retrieval ops, different planners) ---\n';
  report += `plan accuracy: ${planners.map((p) => `${p} ${f3(pi.plan_accuracy?.[p])}`).join(' | ')}\n`;
  report += `regret: ${planners.map((p) => `${p} ${f3(pi.regret?.[p])}`).join(' | ')}\n`;
  report += `avg tokens: ${planners.map((p) => `${p} ${f1(pi.avg_tokens?.[p])}`).join(' | ')}\n`;
  report += `gt_recall: ${planners.filter((p) => p !== 'oracle').map((p) => `${p} ${f3(pi.gt_recall?.[p])}`).join(' | ')}\n\n`;
} else {
  report += '--- Planner isolation ---\nSKIP — sin planner-isolation.json (correr eval-optimizer.js primero)\n\n';
}
report += '--- Statistical tests (paired bootstrap, 95% CI) ---\n';
report += `token delta (heur - rerank): ${f1(statTests.token_delta.mean)} CI [${statTests.token_delta.ci95 ? statTests.token_delta.ci95.map(f1).join(', ') : 'n/a'}]\n`;
report += `latency delta (heur - rerank): ${f1(statTests.latency_delta.mean)} ms CI [${statTests.latency_delta.ci95 ? statTests.latency_delta.ci95.map(f1).join(', ') : 'n/a'}]\n\n`;

// B5 — task-information density: utilidad por token, no solo budget
const ib = {};
for (const m of Object.keys(metrics)) {
  const mm = metrics[m];
  const d = mm.correctness / Math.max(1, mm.tokens.mean);
  ib[m] = +d.toFixed(6);
  report += `--- Task-information density (${m}) ---\n`;
  report += `${ib[m]} correct/token (${pct(mm.correctness)} / ${f1(mm.tokens.mean)} tok)\n\n`;
}

const th = MANIFEST.thresholds ?? {};
const failures = [];
const cmp = (name, ok, msg) => {
  report += `${ok ? 'PASS' : 'FAIL'} ${name}: ${msg}\n`;
  if (!ok) failures.push(name);
};
for (const m of Object.keys(metrics)) {
  if (th.correctness_min != null) {
    cmp(`correctness ${m} >= ${th.correctness_min}`, metrics[m].correctness >= th.correctness_min, `${pct(metrics[m].correctness)}`);
  }
}
if (opt && rec.length) {
  const p = opt.report ?? {};
  const planAcc = (typeof p.plan_accuracy === 'object' ? p.plan_accuracy.learned : p.plan_accuracy) ?? null;
  const regret = (typeof p.regret === 'object' ? p.regret.learned : p.regret) ?? null;
  const regretBase = (typeof p.regret === 'object' ? p.regret.heuristic : null) ?? th.regret_max ?? 0.6886;
  if (planAcc != null) cmp('plan accuracy (learned) >= 0.5', planAcc >= 0.5, f3(planAcc));
  if (regret != null) {
    cmp(`regret (learned) <= baseline (${f3(regretBase)})`, regret <= regretBase, f3(regret));
    if (th.regret_max != null) cmp(`regret (learned) <= ${f3(th.regret_max)}`, regret <= th.regret_max, f3(regret));
  }
} else {
  report += 'SKIP optimizer thresholds (sin records de oracle)\n';
}
if (th.token_reduction_min != null && metrics.heuristic && metrics.rerank) {
  const reduction = 1 - metrics.rerank.tokens.mean / Math.max(1, metrics.heuristic.tokens.mean);
  cmp(`token reduction >= ${th.token_reduction_min}`, reduction >= th.token_reduction_min, `${pct(reduction)} (heur ${f1(metrics.heuristic.tokens.mean)} → rerank ${f1(metrics.rerank.tokens.mean)})`);
}
report += `\n${hr}\n${failures.length ? 'FAIL' : 'PASS'}\n${hr}\n`;

fs.writeFileSync(path.join(OUT, 'raw-results.jsonl'), rawResults.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify({ manifest: MANIFEST.id, metrics, optimizer: opt?.report ?? null, statistical: statTests, task_info_density: ib }, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'statistical-tests.json'), JSON.stringify(statTests, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'report.md'), report);
process.stdout.write(report);
process.exit(failures.length ? 1 : 0);
