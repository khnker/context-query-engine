#!/usr/bin/env node
/*
 * evals/scripts/eval-selection-policy.js — selection-policy-diagnosis (change v1.6)
 * Aísla el sub-problema del REJECT de selección: mismo conjunto de candidatos (A/B/C
 * forzados) y mismo executor, políticas de selección PURAMENTE post-hoc sobre los
 * mismos runs: cost_only (argmin est_tokens), quality_only (argmax exactness),
 * oracle_tokens (argmin tokens reales, tiebreak gt_hits), oracle_quality (argmax
 * gt_hits, tiebreak tokens).
 * Métricas por política: avg_tokens, avg_gt_hits, recall@5, MRR, exactness media,
 * regret vs oracle_tokens, distribución de plan.
 * Diagnóstico 3 vías (1.5): oracle_quality domina cost_only → selection policy;
 * nadie supera cost_only → plan-space; oracle_tokens no emulable → señal post-hoc.
 * Artefacto: evals/reports/selection-policy-<TS>.json
 * Uso: node evals/scripts/eval-selection-policy.js  (CF_TASKS=t1|dev; default split test)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STATS = path.join(ROOT, 'engine', 'statistics.ndjson');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const byId = Object.fromEntries(TASKS.map((t) => [t.id, t]));
const TEST = fs.readFileSync(path.join(ROOT, 'evals/datasets/queries-test.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const REPO_DIRS = {
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'),
  polar: '/home/nicolas/dev/polar',
  dev: path.resolve(ROOT, '..'),
};
const EXACTNESS = { exact: 1, filename: 0.8, structural: 0.7, reference: 0.6, semantic: 0.5, test: 0.4, config: 0.3 };

function groundOf(t) {
  return (t.primary || []).concat(t.related || []).concat(t.tests || []);
}
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}
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

function run(query, repoDir, force) {
  fs.rmSync(CACHE, { force: true });
  const tmp = path.join(ROOT, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: STATS, ...(force ? { FORCE_PLAN: force } : {}) };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, query], { cwd: repoDir, env, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const j = JSON.parse(out.toString());
  return { latency_ms: Date.now() - t0, tokens: j.stats?.tokens_used ?? 0, results: j.results ?? [], est_tokens: (j.plan?.plans ?? []).find((p) => p.id === force)?.ops.reduce((a, o) => a + (o.tokens ?? 0), 0) ?? null };
}

function main() {
  const tasks = process.env.CF_TASKS === 'dev'
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'), 'utf8'))
    : process.env.CF_TASKS === 't1'
      ? TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular')
      : TEST.map((r) => byId[r.source]).filter(Boolean);
  const list = process.argv.includes('--limit') ? tasks.slice(0, Number(process.argv[process.argv.indexOf('--limit') + 1])) : tasks;

  const perTask = [];
  for (const t of list) {
    const repoDir = REPO_DIRS[t.repo];
    if (!repoDir || !t.cqp) continue;
    const forced = {};
    for (const id of ['A', 'B', 'C']) forced[id] = run(t.cqp, repoDir, id);
    const ground = groundOf(t);
    const planMetrics = {};
    for (const id of ['A', 'B', 'C']) {
      const r = forced[id];
      const ranked = [...new Set(r.results.map((x) => x.path))];
      planMetrics[id] = {
        tokens: r.tokens, est_tokens: r.est_tokens, latency_ms: r.latency_ms,
        gt_hits: gtHits(r.results, ground), exactness: Math.max(0, ...r.results.map((x) => EXACTNESS[x.match_type] ?? 0.5)),
        recall5: recallAtK(ranked, ground, 5), mrr: mrr(ranked, ground), n_results: r.results.length,
      };
    }
    // políticas sobre los mismos runs (post-hoc, sin re-ejecutar)
    const pick = (sel) => planMetrics[sel];
    const policy = {
      cost_only: 'A', // fallback: se resuelve abajo por argmin est_tokens
      quality_only: Object.keys(planMetrics).sort((a, b) => planMetrics[b].exactness - planMetrics[a].exactness || a.localeCompare(b))[0],
      oracle_tokens: Object.keys(planMetrics).sort((a, b) => planMetrics[a].tokens - planMetrics[b].tokens || planMetrics[b].gt_hits - planMetrics[a].gt_hits)[0],
      oracle_quality: Object.keys(planMetrics).sort((a, b) => planMetrics[b].gt_hits - planMetrics[a].gt_hits || planMetrics[a].tokens - planMetrics[b].tokens)[0],
    };
    const costCands = Object.keys(planMetrics).filter((id) => planMetrics[id].est_tokens != null);
    if (costCands.length) policy.cost_only = costCands.sort((a, b) => planMetrics[a].est_tokens - planMetrics[b].est_tokens)[0];
    perTask.push({ id: t.id, repo: t.repo, plans: planMetrics, policy });
  }

  const names = ['cost_only', 'quality_only', 'oracle_tokens', 'oracle_quality'];
  const agg = Object.fromEntries(names.map((n) => [n, { tokens: [], gt: [], recall5: [], mrr: [], exactness: [], regret: [], plans: {} }]));
  for (const pt of perTask) {
    const oracle = pt.policy.oracle_tokens;
    for (const n of names) {
      const m = pt.plans[pt.policy[n]];
      agg[n].tokens.push(m.tokens);
      agg[n].gt.push(m.gt_hits);
      agg[n].recall5.push(m.recall5);
      agg[n].mrr.push(m.mrr);
      agg[n].exactness.push(m.exactness);
      agg[n].regret.push((m.tokens - pt.plans[oracle].tokens) / Math.max(1, pt.plans[oracle].tokens));
      agg[n].plans[pt.policy[n]] = (agg[n].plans[pt.policy[n]] ?? 0) + 1;
    }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const report = { date: new Date().toISOString().slice(0, 10), tasks: perTask.length, policies: {} };
  for (const n of names) {
    report.policies[n] = {
      avg_tokens: +mean(agg[n].tokens).toFixed(1),
      avg_gt_hits: +mean(agg[n].gt).toFixed(3),
      recall5: +mean(agg[n].recall5).toFixed(3),
      mrr: +mean(agg[n].mrr).toFixed(3),
      exactness: +mean(agg[n].exactness).toFixed(3),
      regret: +mean(agg[n].regret).toFixed(4),
      plan_dist: agg[n].plans,
    };
  }

  // 1.5 — diagnóstico de tres vías
  const co = report.policies.cost_only, qo = report.policies.quality_only, ot = report.policies.oracle_tokens, oq = report.policies.oracle_quality;
  const qualityDominates = oq.avg_gt_hits > co.avg_gt_hits + 0.01 || (oq.avg_gt_hits === co.avg_gt_hits && oq.regret < co.regret);
  const nobodyBeatsCost = co.avg_gt_hits >= oq.avg_gt_hits && co.regret <= ot.regret + 0.001;
  const oracleNotEmulable = ot.avg_tokens < co.avg_tokens - 0.5 && oq.avg_tokens >= ot.avg_tokens + 0.5;
  const diagnosis = qualityDominates
    ? (oracleNotEmulable ? 'selection-policy + señal post-hoc' : 'selection-policy (señal de calidad emulable)')
    : (nobodyBeatsCost ? 'plan-space / physical operators' : 'mixed: señal parcial, ver detalle');
  report.diagnosis = { quality_dominates_cost: qualityDominates, nobody_beats_cost: nobodyBeatsCost, oracle_tokens_not_emulable_by_quality: oracleNotEmulable, conclusion: diagnosis };

  const TS = Date.now();
  const outPath = path.join(ROOT, 'evals', 'reports', `selection-policy-${TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ...report, perTask }, null, 2) + '\n');

  console.log(`tasks: ${perTask.length}`);
  const hdr = 'política'.padEnd(15) + 'tokens  gt_hits  r@5   mrr   exact  regret  plan-dist';
  console.log(hdr);
  for (const n of names) {
    const p = report.policies[n];
    console.log(`${n.padEnd(15)} ${String(p.avg_tokens).padStart(6)}  ${p.avg_gt_hits.toFixed(3).padStart(6)}  ${p.recall5.toFixed(3)}  ${p.mrr.toFixed(3)}  ${p.exactness.toFixed(3)}  ${p.regret.toFixed(4)}  ${JSON.stringify(p.plan_dist)}`);
  }
  console.log(`DIAGNÓSTICO: ${diagnosis}`);
  console.log('artefacto:', outPath);
}

main();
