#!/usr/bin/env node
/**
 * evals/scripts/eval-structural.js — semantic-structural-operator (CeQe/dc-13).
 * Regresión: adversarial completo (30, categorías) + T1 (32). Verifica que dc
 * (deep-dependency-chain) llega a ≥0.9 y que ninguna categoría ni T1 regresan.
 * Artefacto: evals/reports/structural-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const T1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8')).filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'), 't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
const gtHits = (results, ground) => results.filter((r) => {
  const f = (r.path || '').replace(/^\.\//, '');
  return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
}).length;

function run(task) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env: { ...process.env, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const j = JSON.parse(out.toString());
  const results = j.results ?? [];
  return { gt: gtHits(results, groundOf(task)), leak: results.some((r) => String(r.path ?? '').includes('node_modules')), tokens: j.stats?.tokens_used ?? 0, refined: j.stats?.structural_refined ?? 0, latency: Date.now() - t0 };
}

const rows = [];
for (const t of [...ADV, ...T1]) {
  const r = run(t);
  if (r) rows.push({ id: t.id, group: t.category ?? 't1', t1: !t.id.startsWith('adv-'), ...r });
}
const agg = {};
for (const r of rows) {
  const antiLeak = r.group === 'vendor-code'; // correcto = SIN node_modules en resultados
  const ok = antiLeak ? !r.leak : r.gt > 0;
  (agg[r.group] ??= { n: 0, hits: 0, tokens: 0, refined: 0 });
  const a = agg[r.group];
  a.n++; a.hits += ok ? 1 : 0; a.tokens += r.tokens; a.refined += r.refined;
}
const cats = Object.fromEntries(Object.entries(agg).map(([k, a]) => [k, { correctness: +(a.hits / a.n).toFixed(3), tokens_avg: Math.round(a.tokens / a.n), refined_total: a.refined }]));
const dc = cats['deep-dependency-chain'] ?? { correctness: 0 };
const t1rows = rows.filter((r) => r.t1);
const t1c = { correctness: t1rows.length ? t1rows.filter((r) => r.gt > 0).length / t1rows.length : 0 };
const verdict = { dc_ge_09: dc.correctness >= 0.9, t1_no_regression: t1c.correctness >= 1.0, pass: dc.correctness >= 0.9 && t1c.correctness >= 1.0, dc_correctness: dc.correctness, t1_correctness: t1c.correctness };
const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), categories: cats, verdict, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `structural-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
for (const [k, c] of Object.entries(cats)) console.log(`  ${k.padEnd(24)} correct ${c.correctness}  tok ${c.tokens_avg}  refined ${c.refined_total}`);
console.log(`verdict: ${verdict.pass ? 'PASS' : 'FAIL'} — dc ${dc.correctness} (≥0.9 ${verdict.dc_ge_09}), T1 ${t1c.correctness} (${verdict.t1_no_regression})`);
console.log('artefacto:', outPath);
