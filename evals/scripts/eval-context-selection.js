#!/usr/bin/env node
/**
 * evals/scripts/eval-context-selection.js — 07B budgeted context selection.
 * Aísla el SELECTOR: corre el engine (default) una vez por task de T1 y toma el
 * ranked fusionado (rows con score_final/evidence_tier/token_estimate/path), y
 * simula offline tres políticas sobre EL MISMO set: top-k (fuse legacy),
 * MMR (diversidad, λ=0.7) y marginal (greedy submodular engine/selector.js).
 * Métricas: r@5/r@10/mrr/gt_hits/tokens/density (gt/token)/dirs distintos.
 * Veredicto: marginal ≥ top-k en r@5 sin aumentar tokens (budget duro).
 * Artefacto: evals/reports/context-selection-<TS>.json
 * Uso: node evals/scripts/eval-context-selection.js [--limit N] (CF_TASKS=t1|dev)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { select as marginalSelect } from '../../engine/selector.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STATS = path.join(ROOT, 'engine', 'statistics.ndjson');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const EXTRA = path.join(ROOT, 'evals/datasets/tasks-dev.json');
if (fs.existsSync(EXTRA)) TASKS.push(...JSON.parse(fs.readFileSync(EXTRA, 'utf8')));
const TEST = fs.readFileSync(path.join(ROOT, 'evals/datasets/queries-test.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byId = Object.fromEntries(TASKS.map((t) => [t.id, t]));
const REPO_DIRS = { 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'), 't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'), polar: '/home/nicolas/dev/polar', dev: path.resolve(ROOT, '..') };
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;
export const SELECTOR_BUDGET = Number(process.env.CF_SELECTOR_BUDGET ?? 8000);
export const MMR_LAMBDA = 0.7;
export const SCORE_FLOOR = 0.2;

function groundOf(t) { return (t.primary || []).concat(t.related || []).concat(t.tests || []); }
function gtHits(ranked, ground) { return ranked.filter((r) => { const f = (r.path || '').replace(/^\.\//, ''); return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f)); }).length; }
function recallAtK(ranked, ground, k) { const top = ranked.slice(0, k); const hits = top.filter((f) => ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f))).length; return ground.length ? hits / Math.min(k, ground.length) : 1; }
function mrr(ranked, ground) { for (let i = 0; i < ranked.length; i++) { if (ground.some((g) => ranked[i] === g || ranked[i].endsWith('/' + g) || g.endsWith('/' + ranked[i]))) return 1 / (i + 1); } return 0; }
function dirOf(p) { return path.dirname(String(p || '').replace(/^\.\//, '')); }
function sameRegion(a, b) { const da = dirOf(a); const db = dirOf(b); if (da === db) return 1; const pa = da.split('/'); const pb = db.split('/'); let n = 0; for (let i = 0; i < Math.min(pa.length, pb.length); i++) { if (pa[i] !== pb[i]) break; n++; } return n >= 1 ? 0.5 : 0; }

function mmrSelect(rows, budget) {
  const sel = []; let used = 0;
  const cands = rows.map((r) => ({ r, score_final: r.score_final ?? r.score ?? 0.5 }));
  while (cands.length) {
    let best = null, bestVal = -Infinity;
    for (const c of cands) {
      const sim = sel.length ? Math.max(...sel.map((s) => sameRegion(c.r.path ?? '', s))) : 0;
      const v = c.score_final - (1 - MMR_LAMBDA) * (sel.length ? sim : 0);
      if (v > bestVal) { bestVal = v; best = c; }
    }
    const t = best.r.token_estimate ?? 10;
    if (used + t > budget) break;
    if (best.r.score_final >= SCORE_FLOOR) { sel.push(best.r); used += t; }
    cands.splice(cands.indexOf(best), 1);
  }
  return { selected: sel, used };
}

function topkSelect(rows, budget) {
  const sel = []; let used = 0;
  for (const r of rows) { const t = r.token_estimate ?? 10; if (used + t > budget) break; sel.push(r); used += t; }
  return { selected: sel, used };
}

function runEngine(task) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const t0 = Date.now();
  const parsed = JSON.parse(execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env: { ...process.env, TMPDIR: path.join(ROOT, '.tmp'), CF_STATS_FILE: STATS, CF_SELECTOR_RANKED_ONLY: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 60000 }));
  return { results: (parsed.results ?? []).map((r) => ({ ...r, score_final: r.score_final ?? r.score ?? 0.5, evidence_tier: r.evidence_tier ?? (r.match_type === 'semantic' ? 2 : r.match_type === 'test' || r.match_type === 'config' ? 3 : 0) })), tokens: parsed.stats?.tokens_used ?? 0 };
}

const scope = process.env.CF_TASKS === 'dev'
  ? TASKS.filter((t) => t.repo === 'dev')
  : process.env.CF_TASKS === 't1'
    ? TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular')
    : process.env.CF_TASKS === 'adv'
      ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'))
          .filter((t) => ['huge-fanout', 'monorepo', 'polyglot', 'duplicate-implementations'].includes(t.category))
      : TEST.map((r) => byId[r.source]).filter(Boolean);
const list = LIMIT ? scope.slice(0, LIMIT) : scope;

const agg = { topk: { r5: [], r10: [], mrr: [], gt: [], tok: [], dirs: [] }, mmr: { r5: [], r10: [], mrr: [], gt: [], tok: [], dirs: [] }, marginal: { r5: [], r10: [], mrr: [], gt: [], tok: [], dirs: [] } };
const records = [];

for (const t of list) {
  const r = runEngine(t);
  if (!r) continue;
  const ground = groundOf(t);
  const row = { id: t.id, repo: t.repo, candidates: r.results.length };
  for (const [name, al] of [['topk', topkSelect(r.results, SELECTOR_BUDGET)], ['mmr', mmrSelect(r.results, SELECTOR_BUDGET)], ['marginal', marginalSelect(r.results, SELECTOR_BUDGET)]]) {
    const sel = al.selected;
    const sp = sel.map((x) => String(x.path ?? '').replace(/^\.\//, ''));
    row[name] = { r5: +recallAtK(sp, ground, 5).toFixed(4), r10: +recallAtK(sp, ground, 10).toFixed(4), mrr: +mrr(sp, ground).toFixed(4), gt: gtHits(sel, ground), tokens: al.used, dirs: new Set(sel.map((x) => dirOf(x.path))).size };
    for (const k of ['r5', 'r10', 'mrr']) agg[name][k].push(row[name][k]);
    agg[name].gt.push(row[name].gt); agg[name].tok.push(row[name].tokens); agg[name].dirs.push(row[name].dirs);
  }
  records.push(row);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const rep = (name) => ({ r5: mean(agg[name].r5), r10: mean(agg[name].r10), mrr: mean(agg[name].mrr), gt_hits: mean(agg[name].gt), tokens: mean(agg[name].tok), dirs: mean(agg[name].dirs), density: mean(agg[name].gt) / Math.max(1, mean(agg[name].tok)) });
const out = { topk: rep('topk'), mmr: rep('mmr'), marginal: rep('marginal') };

const verdict = {
  pass: out.marginal.r5 >= out.topk.r5 && out.marginal.tokens <= out.topk.tokens * 1.05,
  r5: { topk: out.topk.r5, marginal: out.marginal.r5 },
  tokens: { topk: out.topk.tokens, marginal: out.marginal.tokens },
  threshold: 'marginal.r5 >= topk.r5 AND marginal.tokens <= 1.05*topk.tokens',
};
const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: records.length, budget: SELECTOR_BUDGET, mmr_lambda: MMR_LAMBDA, selectors: out, verdict, records };
const outPath = path.join(ROOT, 'evals', 'reports', `context-selection-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

const f = (x) => x.toFixed(4);
console.log(`tasks: ${records.length} | budget ${SELECTOR_BUDGET}`);
for (const [n, d] of [['topk', out.topk], ['mmr', out.mmr], ['marginal', out.marginal]]) {
  console.log(`  ${n.padEnd(9)} r@5 ${f(d.r5)}  r@10 ${f(d.r10)}  mrr ${f(d.mrr)}  gt ${d.gt_hits.toFixed(2)}  tok ${Math.round(d.tokens)}  dirs ${d.dirs.toFixed(1)}  density ${d.density.toFixed(4)}`);
}
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — r@5 ${f(out.topk.r5)}→${f(out.marginal.r5)} (${verdict.pass ? '✓' : '✗'}), tokens ${Math.round(out.topk.tokens)}→${Math.round(out.marginal.tokens)}`);
console.log('artefacto:', outPath);