#!/usr/bin/env node
/**
 * evals/scripts/eval-claim.js — claim-level-context (B3).
 * Baseline (file-level dumps) vs CF_CLAIMS=1 (claims con spans mínimos).
 * Métricas: file_coverage (GT path en resultados/claims), span_hit (claim con
 * span sobre archivo GT — proxy line-level sin GT de líneas), tokens (dump sum
 * token_estimate vs claim span_tokens = líneas×5), reduction. Verdict: coverage
 * parity Y reduction ≥ 0.40. Artefacto: evals/reports/claims-<TS>.json
 * Uso: node evals/scripts/eval-claim.js [--limit N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'), 't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;

const tasks = TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular')
  .concat(ADV.filter((t) => ['huge-fanout', 'monorepo', 'polyglot', 'duplicate-implementations'].includes(t.category)));
const list = LIMIT ? tasks.slice(0, LIMIT) : tasks;

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
const hit = (paths, ground) => paths.filter((f) => ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f))).length;

const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

function run(task, claims) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...(claims ? { CF_CLAIMS: '1' } : {}) };
  const t0 = Date.now();
  let j;
  try {
    j = JSON.parse(execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 }));
  } catch (e) {
    return { id: task.id, error: String(e.message || e).slice(0, 60) };
  }
  const ground = groundOf(task);
  const paths = (claims ? (j.results ?? []).map((c) => c.subject) : (j.results ?? []).map((r) => r.path)).filter(Boolean);
  const tokens = claims ? (j.stats?.claims?.span_tokens ?? 0) : (j.results ?? []).reduce((a, r) => a + (r.token_estimate ?? 0), 0);
  return {
    id: task.id, gt: hit(paths, ground), n_ground: ground.length,
    span_hit: claims ? (j.results ?? []).filter((c) => ground.some((g) => c.subject === g || c.subject.endsWith('/' + g) || g.endsWith('/' + c.subject))).length > 0 : null,
    tokens, n_claims: claims ? (j.results ?? []).length : null, latency_ms: Date.now() - t0,
  };
}

const rows = [];
for (const t of list) {
  const base = run(t, false);
  const clm = run(t, true);
  if (base && clm) rows.push({ ...base, claims: clm, reduction: base.tokens ? 1 - clm.tokens / base.tokens : 0 });
}

const ok = rows.filter((r) => !r.error);
const covBase = ok.filter((r) => r.gt > 0).length / Math.max(1, ok.length);
const covClm = ok.filter((r) => r.claims.gt > 0).length / Math.max(1, ok.length);
const meanRed = ok.reduce((a, r) => a + r.reduction, 0) / Math.max(1, ok.length);
const tokensBase = ok.reduce((a, r) => a + r.tokens, 0);
const tokensClm = ok.reduce((a, r) => a + r.claims.tokens, 0);
const parity = covClm >= covBase;
const verdict = { pass: parity && meanRed >= 0.40, coverage: { base: +covBase.toFixed(3), claims: +covClm.toFixed(3), parity }, reduction: +meanRed.toFixed(3), tokens: { base: tokensBase, claims: tokensClm } };

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: ok.length, verdict, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `claims-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${ok.length}`);
console.log(`coverage: base ${covBase.toFixed(3)} vs claims ${covClm.toFixed(3)} (parity ${parity})`);
console.log(`tokens: ${tokensBase} → ${tokensClm} (reduction ${meanRed.toFixed(3)})`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — parity ${parity} && reduction ${meanRed.toFixed(3)} >= 0.40`);
for (const r of ok.filter((r) => r.reduction < 0)) console.log(`  NEG ${r.id}: reduction ${r.reduction.toFixed(3)} (base ${r.tokens} → ${r.claims.tokens})`);
console.log('artefacto:', outPath);