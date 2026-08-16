#!/usr/bin/env node
/**
 * evals/scripts/eval-ssm.js — context-selection (06): MMR vs marginal vs top-k.
 * Una corrida ranked (CF_SELECTOR_RANKED_ONLY=1 + CF_RETRIEVAL=hybrid) por task;
 * los selectores REALES de engine/selector.js (select/selectMMR) se aplican
 * offline sobre el mismo ranked a budgets [2000, 800, 400] → comparación justa.
 * Smoke end-to-end: engine CF_SELECTOR=mmr CF_SELECTOR_BUDGET=400 en 3 fan-out.
 * Verdict: mmr.gt >= topk.gt en tight (400) Y en T1 loose (2000) — sin regresión.
 * Artefacto: evals/reports/ssm-<TS>.json
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
const { select } = await import('../../engine/selector.js');

const BUDGETS = [2000, 800, 400];
const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
const gtHits = (rows, ground) => rows.filter((r) => {
  const f = String(r.path ?? '').replace(/^\.\//, '');
  return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
}).length;

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
  const per = { id: t.id, group: (t.repo || '').startsWith('t1') ? 't1' : t.category, n_ranked: ranked.length, ground: ground.length };
  for (const b of BUDGETS) {
    const topk = ranked.slice(0, 50).reduce((acc, r) => { if (acc.t + (r.token_estimate ?? 10) <= b) { acc.sel.push(r); acc.t += r.token_estimate ?? 10; } return acc; }, { sel: [], t: 0 }).sel;
    const marg = select(ranked, b, 'marginal').selected;
    const mmr = select(ranked, b, 'mmr').selected;
    per[b] = {
      topk: { gt: gtHits(topk, ground), tokens: topk.reduce((a, r) => a + (r.token_estimate ?? 0), 0), n: topk.length },
      marginal: { gt: gtHits(marg, ground), tokens: marg.reduce((a, r) => a + (r.token_estimate ?? 0), 0), n: marg.length },
      mmr: { gt: gtHits(mmr, ground), tokens: mmr.reduce((a, r) => a + (r.token_estimate ?? 0), 0), n: mmr.length },
    };
  }
  rows.push(per);
}

const sum = (rows, key, f) => rows.reduce((a, r) => a + r[key][f].gt, 0);
const fam = (budget, sel) => rows.reduce((a, r) => a + r[budget][sel].gt, 0);
const t1Rows = rows.filter((r) => r.group === 't1');
const tight = { topk: fam(400, 'topk'), mmr: fam(400, 'mmr'), marginal: fam(400, 'marginal') };
const loose = { topk: t1Rows.reduce((a, r) => a + r[2000].topk.gt, 0), mmr: t1Rows.reduce((a, r) => a + r[2000].mmr.gt, 0), marginal: t1Rows.reduce((a, r) => a + r[2000].marginal.gt, 0) };
const verdict = { tight_400: { topk: tight.topk, mmr: tight.mmr, mmr_beats_topk: tight.mmr >= tight.topk }, loose_2000_t1: { topk: loose.topk, mmr: loose.mmr, mmr_gte_topk: loose.mmr >= loose.topk }, pass: tight.mmr >= tight.topk && loose.mmr >= loose.topk };

// smoke end-to-end engine CF_SELECTOR=mmr @400 en 3 fan-out
const smoke = [];
for (const t of fanout.slice(0, 3)) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[t.repo]);
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), CF_SELECTOR: 'mmr', CF_SELECTOR_BUDGET: '400', CF_RETRIEVAL: 'hybrid' };
  const out = execFileSync('node', [ENGINE, t.cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const j = JSON.parse(out.toString());
  smoke.push({ id: t.id, selector: j.stats?.selector, kept: j.stats?.selector_kept, gt: gtHits(j.results ?? [], groundOf(t)) });
}

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: rows.length, budgets: BUDGETS, verdict, smoke, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `ssm-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

for (const b of BUDGETS) {
  console.log(`budget ${b}: topk gt ${fam(b, 'topk')} | marginal gt ${fam(b, 'marginal')} | mmr gt ${fam(b, 'mmr')}`);
}
console.log(`verdict: ${verdict.pass ? 'PASS' : 'FAIL'} — tight400 mmr ${tight.mmr} >= topk ${tight.topk}; loose2000(t1) mmr ${loose.mmr} >= topk ${loose.topk}`);
console.log('smoke engine mmr@400:', smoke.map((s) => `${s.id}:${s.selector}/${s.kept} gt${s.gt}`).join(' | '));
console.log('artefacto:', outPath);