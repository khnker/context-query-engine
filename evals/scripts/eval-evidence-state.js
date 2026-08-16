#!/usr/bin/env node
/**
 * evals/scripts/eval-evidence-state.js — belief state (paso 04 roadmap).
 * Correlación Spearman entre señales del belief state (coverage_estimate,
 * agreement_rate) y gt_hits real, sobre T1 + adversarial fan-out.
 * Umbral 1.4: Spearman(coverage, gt) >= 0.5 y Spearman(agreement, gt) >= 0.3.
 * Artefacto: evals/reports/evidence-state-<TS>.json
 * Node.js ESM, stdlib SOLO. Uso: node evals/scripts/eval-evidence-state.js
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
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', dev: path.resolve(ROOT, '..'),
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

const tasks = TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular')
  .concat(ADV.filter((t) => ['huge-fanout', 'monorepo', 'polyglot', 'duplicate-implementations', 'zero-results'].includes(t.category)));
const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);

function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function spearman(xs, ys) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

const rows = [];
for (const t of tasks) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[t.repo] ?? t.repo);
  if (!fs.existsSync(repoDir)) continue;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const t0 = Date.now();
  let j;
  try {
    j = JSON.parse(execFileSync('node', [ENGINE, t.cqp], {
      cwd: repoDir, env: { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), CF_RETRIEVAL: 'hybrid' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000,
    }).toString().trim().split('\n').pop());
  } catch (e) {
    rows.push({ id: t.id, error: String(e.message || e).slice(0, 80) });
    continue;
  }
  const b = j.stats?.belief ?? {};
  rows.push({
    id: t.id, group: t.category || (t.repo.startsWith('t1') ? 't1' : 'dev'),
    gt_hit: gtHits(j.results ?? [], groundOf(t)) > 0 ? 1 : 0,
    gt_hits: gtHits(j.results ?? [], groundOf(t)),
    agreement: b.agreement_rate, coverage: b.coverage_estimate,
    sources: b.sources ?? 0, n_pool: b.n_pool ?? 0, tokens: j.stats?.tokens_used ?? 0,
  });
}

const ok = rows.filter((r) => r.error == null && r.agreement != null);
const cov = spearman(ok.map((r) => r.coverage), ok.map((r) => r.gt_hit));
const agr = spearman(ok.map((r) => r.agreement), ok.map((r) => r.gt_hit));
const verdict = { pass: cov >= 0.5 && agr >= 0.3, spearman_coverage_gt: +cov.toFixed(3), spearman_agreement_gt: +agr.toFixed(3), n: ok.length, threshold: 'cov>=0.5 && agr>=0.3' };

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: rows.length, with_agreement: ok.length, verdict, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `evidence-state-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${rows.length} | con agreement: ${ok.length}`);
console.log(`Spearman(coverage, gt_hit) = ${cov.toFixed(3)} | Spearman(agreement, gt_hit) = ${agr.toFixed(3)}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.threshold}`);
for (const r of rows.filter((r) => r.error)) console.log(`  ERROR ${r.id}: ${r.error}`);
console.log('artefacto:', outPath);