#!/usr/bin/env node
/**
 * evals/scripts/eval-adaptive-k.js — B2 adaptive-context-budget (Adaptive-k).
 * Una corrida ranked por task (CF_SELECTOR_RANKED_ONLY=1 + CF_RETRIEVAL=hybrid);
 * offline: top-k fijo vs marginal vs adaptive-k (θ sweep) a budgets [2000, 8000].
 * Métricas: gt_hits, tokens usados, k seleccionado, density = gt/tokens.
 * Veredicto: density(adaptive mejor θ) ≥ density(topk) en ambos budgets Y parity
 * de correctness (queries con gt>0 iguales).
 * Artefacto: evals/reports/adaptive-k-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { select } from '../../engine/selector.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', dev: path.resolve(ROOT, '..'),
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const BUDGETS = [2000, 8000];
const THETAS = [0.05, 0.10, 0.20];
const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

const fanout = ADV.filter((t) => ['huge-fanout', 'monorepo', 'polyglot', 'duplicate-implementations'].includes(t.category));
const t1 = TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const tasks = [...fanout, ...t1];
const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

function runEngine(task) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
    CF_SELECTOR_RANKED_ONLY: '1', CF_RETRIEVAL: 'hybrid' };
  const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  return JSON.parse(out.toString());
}

const rows = [];
for (const t of tasks) {
  const j = runEngine(t);
  if (!j) continue;
  const ranked = (j.results ?? []).map((r) => ({ ...r, score_final: r.score_final ?? r.score ?? 0.5 }));
  const ground = groundOf(t);
  const per = { id: t.id, group: (t.repo || '').startsWith('t1') ? 't1' : t.category, n_ranked: ranked.length };
  const topkSel = (b) => ranked.reduce((acc, r) => { if (acc.t + (r.token_estimate ?? 10) <= b) { acc.sel.push(r); acc.t += r.token_estimate ?? 10; } return acc; }, { sel: [], t: 0 }).sel;
  for (const b of BUDGETS) {
    const topk = topkSel(b);
    per[b] = {
      topk: { gt: gtHits(topk, ground), tokens: topk.reduce((a, r) => a + (r.token_estimate ?? 0), 0), n: topk.length },
      adaptive: {},
    };
    for (const th of THETAS) {
      const { selected, used, adaptive_k } = select(ranked, b, 'marginal', th);
      per[b].adaptive[th] = { gt: gtHits(selected, ground), tokens: used, n: adaptive_k ?? selected.length };
    }
  }
  rows.push(per);
}

const sumGt = (key) => (budget, sel) => rows.reduce((a, r) => a + (r[budget][sel]?.gt ?? 0), 0);
const sumTok = (budget, sel) => rows.reduce((a, r) => a + (r[budget][sel]?.tokens ?? 0), 0);
const parities = {};
const verdict = { budgets: {} };
for (const b of BUDGETS) {
  const topkGt = sumGt('topk')(b, 'topk'), topkTok = sumTok(b, 'topk');
  const dTopk = topkGt / Math.max(1, topkTok);
  const best = { th: null, d: -1, gt: -1, tok: -1 };
  for (const th of THETAS) {
    const gt = rows.reduce((a, r) => a + (r[b].adaptive[th]?.gt ?? 0), 0);
    const tok = rows.reduce((a, r) => a + (r[b].adaptive[th]?.tokens ?? 0), 0);
    const d = gt / Math.max(1, tok);
    if (d > best.d) Object.assign(best, { th, d, gt, tok });
  }
  // parity de correctness: nº de tasks con gt>0 iguales
  let parOk = true;
  for (const r of rows) {
    const topkHit = r[b].topk.gt > 0;
    const adHit = r[b].adaptive[best.th].gt > 0;
    if (topkHit !== adHit) parOk = false;
  }
  parities[b] = parOk;
  verdict.budgets[b] = { topk: { gt: topkGt, tokens: topkTok, density: +dTopk.toFixed(6) }, adaptive: { theta: best.th, gt: best.gt, tokens: best.tok, density: +best.d.toFixed(6) }, adaptive_density_gte_topk: best.d >= dTopk, parity_correctness: parOk };
}
verdict.pass = Object.values(verdict.budgets).every((v) => v.adaptive_density_gte_topk && v.parity_correctness);

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: rows.length, budgets: BUDGETS, thetas: THETAS, verdict, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `adaptive-k-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

for (const b of BUDGETS) {
  const v = verdict.budgets[b];
  console.log(`budget ${b}: topk gt ${v.topk.gt}/tok ${v.topk.tokens}/d ${v.topk.density} | adaptive(θ=${v.adaptive.theta}) gt ${v.adaptive.gt}/tok ${v.adaptive.tokens}/d ${v.adaptive.density} | d>= ${v.adaptive_density_gte_topk} | parity ${v.parity_correctness}`);
}
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'}`);
console.log('artefacto:', outPath);