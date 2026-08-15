#!/usr/bin/env node
/*
 * evals/scripts/eval-optimizer.js — change 02 optimizer-evaluation-v2
 * Benchmark del optimizer: por query corre planes A, B, C FORZADOS (FORCE_PLAN),
 * selección HEURÍSTICA (stats vacías) y selección APRENDIDA (stats reales).
 * Registra {query, candidate_plans {id, est_tokens, actual_tokens, latency_ms,
 * gt_hits}, selected_heuristic, selected_learned, oracle_plan, quality, tokens,
 * latency} → evals/reports/optimizer-eval.json + tabla console.
 *
 * Plan accuracy = selección == oráculo (argmin tokens reales entre A/B/C).
 * Regret = (tokens(sel) - tokens(oracle)) / tokens(oracle).
 *
 * Uso: node evals/scripts/eval-optimizer.js [--limit N]   (CF_TASKS=dev → dev)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STATS = path.join(ROOT, 'engine', 'statistics.ndjson');
const EMPTY_STATS = path.join(ROOT, 'evals', 'reports', '.optimizer-empty.ndjson');
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
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;

function groundOf(t) {
  return (t.primary || []).concat(t.related || []).concat(t.tests || []);
}

function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function run(query, repoDir, { force, statsFile }) {
  fs.rmSync(CACHE, { force: true });
  const tmp = path.join(ROOT, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: statsFile, ...(force ? { FORCE_PLAN: force } : {}) };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, query], { cwd: repoDir, env, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const j = JSON.parse(out.toString());
  return {
    latency_ms: Date.now() - t0,
    tokens: j.stats?.tokens_used ?? 0,
    results: j.results ?? [],
    selected: j.plan?.selected,
    plans: (j.plan?.plans || []).map((p) => ({
      id: p.id,
      ops: (p.ops || []).map((o) => o.tool),
      est_tokens: (p.ops || []).reduce((a, o) => a + (o.tokens || 0), 0),
      cost: p.cost,
      quality: p.quality,
      utility: p.utility,
    })),
  };
}

function main() {
  fs.mkdirSync(path.join(ROOT, 'evals/reports'), { recursive: true });
  fs.writeFileSync(EMPTY_STATS, '');
  const tasks = process.env.CF_TASKS === 'dev'
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'), 'utf8'))
    : TEST.map((r) => byId[r.source]).filter(Boolean);
  const list = LIMIT ? tasks.slice(0, LIMIT) : tasks;

  const records = [];
  const acc = {
    plan_acc_first: 0, plan_acc_heur: 0, plan_acc_learned: 0, n: 0,
    regret_first: [], regret_heur: [], regret_learned: [],
    tokens: { first: 0, heur: 0, learned: 0, oracle: 0 }, latency: { heur: 0, learned: 0 },
    gt_hits: { first: 0, heur: 0, learned: 0 }, total_gt: 0,
  };

  for (const t of list) {
    const repoDir = REPO_DIRS[t.repo];
    if (!repoDir || !t.cqp) continue;
    const forced = {};
    for (const id of ['A', 'B', 'C']) forced[id] = run(t.cqp, repoDir, { force: id, statsFile: STATS });
    const heur = run(t.cqp, repoDir, { force: null, statsFile: EMPTY_STATS });
    const learned = run(t.cqp, repoDir, { force: null, statsFile: STATS });
    const oracle = Object.keys(forced).sort((a, b) =>
      forced[a].tokens - forced[b].tokens || gtHits(forced[b].results, groundOf(t)) - gtHits(forced[a].results, groundOf(t)))[0];
    const ground = groundOf(t);

    records.push({
      id: t.id, repo: t.repo, query: t.cqp,
      candidate_plans: ['A', 'B', 'C'].map((id) => ({
        id, est_tokens: forced[id].plans.find((p) => p.id === id)?.est_tokens ?? null,
        actual_tokens: forced[id].tokens, latency_ms: forced[id].latency_ms,
        gt_hits: gtHits(forced[id].results, ground),
      })),
      selected_first: 'A',
      selected_heuristic: heur.selected,
      selected_learned: learned.selected,
      oracle_plan: oracle,
      quality: {
        first: gtHits(forced.A.results, ground),
        heur: gtHits(heur.results, ground), learned: gtHits(learned.results, ground),
        gt: ground.length,
      },
      tokens: { first: forced.A.tokens, heur: heur.tokens, learned: learned.tokens, oracle: forced[oracle].tokens },
      latency_ms: { heur: heur.latency_ms, learned: learned.latency_ms },
    });
    acc.n += 1;
    if ('A' === oracle) acc.plan_acc_first += 1;
    if (heur.selected === oracle) acc.plan_acc_heur += 1;
    if (learned.selected === oracle) acc.plan_acc_learned += 1;
    acc.regret_first.push((forced.A.tokens - forced[oracle].tokens) / Math.max(1, forced[oracle].tokens));
    acc.regret_heur.push((heur.tokens - forced[oracle].tokens) / Math.max(1, forced[oracle].tokens));
    acc.regret_learned.push((learned.tokens - forced[oracle].tokens) / Math.max(1, forced[oracle].tokens));
    acc.tokens.first += forced.A.tokens;
    acc.tokens.heur += heur.tokens; acc.tokens.learned += learned.tokens; acc.tokens.oracle += forced[oracle].tokens;
    acc.latency.heur += heur.latency_ms; acc.latency.learned += learned.latency_ms;
    acc.gt_hits.first += Math.min(1, gtHits(forced.A.results, ground));
    acc.gt_hits.heur += Math.min(1, gtHits(heur.results, ground));
    acc.gt_hits.learned += Math.min(1, gtHits(learned.results, ground));
    acc.total_gt += 1; // 1 por task → recall = fracción de tasks con ≥1 GT hit
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const report = {
    date: new Date().toISOString().slice(0, 10),
    tasks: acc.n,
    plan_accuracy: { first_match: acc.plan_acc_first / acc.n, heuristic: acc.plan_acc_heur / acc.n, learned: acc.plan_acc_learned / acc.n, oracle: 1 },
    regret: { first_match: mean(acc.regret_first), heuristic: mean(acc.regret_heur), learned: mean(acc.regret_learned) },
    avg_tokens: {
      first_match: acc.tokens.first / acc.n,
      heuristic: acc.tokens.heur / acc.n, learned: acc.tokens.learned / acc.n, oracle: acc.tokens.oracle / acc.n,
    },
    avg_latency_ms: { heuristic: acc.latency.heur / acc.n, learned: acc.latency.learned / acc.n },
    gt_recall: {
      first_match: Math.min(1, acc.gt_hits.first / Math.max(1, acc.total_gt)),
      heuristic: Math.min(1, acc.gt_hits.heur / Math.max(1, acc.total_gt)),
      learned: Math.min(1, acc.gt_hits.learned / Math.max(1, acc.total_gt)),
    },
  };
  fs.writeFileSync(path.join(ROOT, 'evals/reports/optimizer-eval.json'), JSON.stringify({ report, records }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('\nrecords:', records.length, '→ evals/reports/optimizer-eval.json');
}

main();
