#!/usr/bin/env node
/**
 * evals/scripts/eval-explorer.js — explorer-solver-separation (FastContext).
 * Baseline (dump completo) vs CF_EXPLORER=1 (evidence references + next_actions).
 * Métricas: tokens dump (sum token_estimate) vs tokens refs (spans ×5),
 * reduction %, correctness (GT path en results/evidence), next_actions con
 * eig>0 cuando agreement<0.5.
 * Verdict 3.1: reduction >= 0.40 && correctness parity (explorer == dump).
 * Artefacto: evals/reports/explorer-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const DOWNSTREAM = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.id.startsWith('lex-') || t.id.startsWith('str-'));
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'))
  .filter((t) => ['huge-fanout', 'monorepo', 'polyglot', 'duplicate-implementations'].includes(t.category));
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };

const tasks = [...DOWNSTREAM, ...ADV];
const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
const gtHit = (paths, ground) => paths.some((f) => ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)));
const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

function run(task, explorer) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
    ...(explorer ? { CF_EXPLORER: '1' } : {}) };
  const t0 = Date.now();
  let j;
  try {
    j = JSON.parse(execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 }));
  } catch (e) {
    return { id: task.id, error: String(e.message || e).slice(0, 60) };
  }
  return { id: task.id, latency_ms: Date.now() - t0, j, explorer };
}

const rows = [];
for (const t of tasks) {
  const d = run(t, false);
  const e = run(t, true);
  if (!d || !e) { if (d?.error) rows.push(d); continue; }
  const ground = groundOf(t);
  const dumpPaths = (d.j.results ?? []).map((r) => r.path);
  const ev = e.j.explorer?.evidence ?? [];
  const refPaths = ev.map((x) => x.path);
  const dumpTokens = (d.j.results ?? []).reduce((a, r) => a + (r.token_estimate ?? 0), 0);
  const refTokens = ev.reduce((a, x) => a + (x.lines[1] - x.lines[0] + 1) * 5, 0);
  const actions = e.j.explorer?.next_actions ?? [];
  const agreement = e.j.stats?.belief?.agreement ?? null;
  rows.push({
    id: t.id, group: t.id.startsWith('adv-') ? 'adversarial' : 'downstream',
    dump_correct: gtHit(dumpPaths, ground), ref_correct: gtHit(refPaths, ground),
    dump_tokens: dumpTokens, ref_tokens: refTokens,
    reduction: dumpTokens ? 1 - refTokens / dumpTokens : null,
    n_evidence: ev.length, actions: actions.length, high_eig_actions: actions.filter((a) => a.eig >= 0.5).length,
    agreement, plan: e.j.plan?.selected ?? null,
  });
}

const withData = rows.filter((r) => !r.error);
const reds = withData.map((r) => r.reduction).filter((r) => r != null);
const meanRed = reds.length ? reds.reduce((a, b) => a + b, 0) / reds.length : 0;
const dumpCorrect = withData.filter((r) => r.dump_correct).length / Math.max(1, withData.length);
const refCorrect = withData.filter((r) => r.ref_correct).length / Math.max(1, withData.length);
const lowAgreeWithAction = withData.filter((r) => r.agreement != null && r.agreement < 0.5 && r.high_eig_actions > 0).length;
const verdict = { pass: meanRed >= 0.4 && refCorrect >= dumpCorrect, mean_reduction: +meanRed.toFixed(3),
  dump_correctness: +dumpCorrect.toFixed(3), ref_correctness: +refCorrect.toFixed(3), threshold: 'reduction>=0.40 && correctness parity' };

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: withData.length, verdict, rows: withData };
const outPath = path.join(ROOT, 'evals', 'reports', `explorer-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${withData.length} | dump correct ${dumpCorrect.toFixed(3)} | refs correct ${refCorrect.toFixed(3)}`);
console.log(`tokens: dump mean ${Math.round(withData.reduce((a, r) => a + r.dump_tokens, 0) / Math.max(1, withData.length))} | refs mean ${Math.round(withData.reduce((a, r) => a + r.ref_tokens, 0) / Math.max(1, withData.length))} | reduction ${(meanRed * 100).toFixed(1)}%`);
console.log(`next_actions: ${withData.reduce((a, r) => a + r.actions, 0)} (eig>=0.5: ${withData.reduce((a, r) => a + r.high_eig_actions, 0)}); low-agreement con acción: ${lowAgreeWithAction}`);
console.log(`verdict: ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.threshold}`);
console.log('artefacto:', outPath);