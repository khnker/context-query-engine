#!/usr/bin/env node
/*
 * evals/scripts/eval-utility.js — expected-utility-cost (change 07)
 * Ablación 7.3: selección actual (cost/quality, learned) vs EU (CF_UTILITY=1) vs
 * oráculo (FORCE_PLAN A/B/C) sobre T1. Métricas por selector: plan_accuracy,
 * regret, avg_tokens, gt_recall (correctness), expected_total_cost (7.4: si el
 * plan seleccionado tiene P(correct) < 0.8 → segunda ronda simulada = +tokens
 * del oráculo). Umbral 7.5: utility.correctness ≥ current.correctness Y
 * regret_util ≤ 0.9 × regret_current (≥10% relativo).
 * Artefacto: evals/reports/utility-<TS>.json
 * Uso: node evals/scripts/eval-utility.js [--limit N]  (CF_TASKS=dev → dev)
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
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;
const P_RETRY = 0.8; // 7.4 — segunda ronda si P(correct) < 0.8

function groundOf(t) {
  return (t.primary || []).concat(t.related || []).concat(t.tests || []);
}

function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function run(query, repoDir, { force, utility }) {
  fs.rmSync(CACHE, { force: true });
  const tmp = path.join(ROOT, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = {
    ...process.env, TMPDIR: tmp, CF_STATS_FILE: STATS,
    ...(force ? { FORCE_PLAN: force } : {}),
    ...(utility ? { CF_UTILITY: '1' } : {}),
  };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, query], { cwd: repoDir, env, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const j = JSON.parse(out.toString());
  const sel = j.plan?.selected;
  const pCorrect = j.plan?.plans?.find((p) => p.id === sel)?.p_correct ?? null;
  return {
    latency_ms: Date.now() - t0,
    tokens: j.stats?.tokens_used ?? 0,
    results: j.results ?? [],
    selected: sel,
    p_correct: pCorrect,
  };
}

function main() {
  const tasks = process.env.CF_TASKS === 'dev'
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'), 'utf8'))
    : process.env.CF_TASKS === 't1'
      ? TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular')
      : TEST.map((r) => byId[r.source]).filter(Boolean);
  const list = LIMIT ? tasks.slice(0, LIMIT) : tasks;

  const acc = {
    n: 0,
    plan_acc: { current: 0, utility: 0 },
    regret: { current: [], utility: [] },
    tokens: { current: 0, utility: 0, oracle: 0 },
    gt_hits: { current: 0, utility: 0 }, total_gt: 0,
    etc: { current: 0, utility: 0 },
    selected_plans: { current: new Set(), utility: new Set() },
  };
  const records = [];

  // plan-variant-confidence — preheat: pasada 1 con selección default para acumular
  // telemetría plan:<id>|queryClass (n≥5) ANTES de medir EU en la pasada 2
  if (process.env.CF_PREHEAT === '1' && process.env.CF_TASKS === 't1') {
    for (const t of list) {
      const repoDir = REPO_DIRS[t.repo];
      if (!repoDir || !t.cqp) continue;
      run(t.cqp, repoDir, {});
      run(t.cqp, repoDir, { utility: true });
    }
  }

  for (const t of list) {
    const repoDir = REPO_DIRS[t.repo];
    if (!repoDir || !t.cqp) continue;
    const forced = {};
    for (const id of ['A', 'B', 'C']) forced[id] = run(t.cqp, repoDir, { force: id });
    const current = run(t.cqp, repoDir, {});            // selección actual (cost/quality, learned)
    const utility = run(t.cqp, repoDir, { utility: true }); // EU
    const oracle = Object.keys(forced).sort((a, b) =>
      forced[a].tokens - forced[b].tokens || gtHits(forced[b].results, groundOf(t)) - gtHits(forced[a].results, groundOf(t)))[0];
    const ground = groundOf(t);
    const reg = (sel, tok) => (tok - forced[oracle].tokens) / Math.max(1, forced[oracle].tokens);
    const etc = (tok, p) => tok + (p === null || p < P_RETRY ? forced[oracle].tokens : 0);

    acc.n += 1;
    if (current.selected === oracle) acc.plan_acc.current += 1;
    if (utility.selected === oracle) acc.plan_acc.utility += 1;
    acc.regret.current.push(reg(current.selected, current.tokens));
    acc.regret.utility.push(reg(utility.selected, utility.tokens));
    acc.tokens.current += current.tokens; acc.tokens.utility += utility.tokens; acc.tokens.oracle += forced[oracle].tokens;
    acc.gt_hits.current += Math.min(1, gtHits(current.results, ground));
    acc.gt_hits.utility += Math.min(1, gtHits(utility.results, ground));
    acc.total_gt += 1;
    acc.etc.current += etc(current.tokens, current.p_correct);
    acc.etc.utility += etc(utility.tokens, utility.p_correct);
    acc.selected_plans.current.add(current.selected);
    acc.selected_plans.utility.add(utility.selected);

    records.push({
      id: t.id, repo: t.repo, query: t.cqp, oracle_plan: oracle,
      selected_current: current.selected, selected_utility: utility.selected,
      p_correct_current: current.p_correct, p_correct_utility: utility.p_correct,
      tokens: { current: current.tokens, utility: utility.tokens, oracle: forced[oracle].tokens },
      regret: { current: +reg(current.selected, current.tokens).toFixed(4), utility: +reg(utility.selected, utility.tokens).toFixed(4) },
      expected_total_cost: { current: etc(current.tokens, current.p_correct), utility: etc(utility.tokens, utility.p_correct) },
      gt_hits: { current: gtHits(current.results, ground), utility: gtHits(utility.results, ground) },
    });
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const n = acc.n;
  const report = {
    date: new Date().toISOString().slice(0, 10),
    tasks: n,
    plan_accuracy: { current: acc.plan_acc.current / n, utility: acc.plan_acc.utility / n, oracle: 1 },
    regret: { current: mean(acc.regret.current), utility: mean(acc.regret.utility) },
    avg_tokens: { current: acc.tokens.current / n, utility: acc.tokens.utility / n, oracle: acc.tokens.oracle / n },
    gt_recall: { current: acc.gt_hits.current / acc.total_gt, utility: acc.gt_hits.utility / acc.total_gt },
    expected_total_cost: { current: acc.etc.current / n, utility: acc.etc.utility / n },
    selected_plans: { current: [...acc.selected_plans.current].sort(), utility: [...acc.selected_plans.utility].sort() },
  };

  // 7.5 — utility no degrada correctness Y regret ≥10% relativo menor
  const rCur = report.regret.current, rUtil = report.regret.utility;
  const okCorrectness = report.gt_recall.utility >= report.gt_recall.current;
  const okRegret = rCur > 0 ? rUtil <= 0.9 * rCur : rUtil <= rCur;
  const verdict = {
    pass: okCorrectness && okRegret,
    correctness: { current: report.gt_recall.current, utility: report.gt_recall.utility, ok: okCorrectness },
    regret: { current: rCur, utility: rUtil, reduction: rCur > 0 ? (1 - rUtil / rCur) : null, ok: okRegret },
    threshold: 'utility.correctness >= current.correctness AND regret_util <= 0.9*regret_current',
  };

  const TS = Date.now();
  const artifact = { ...report, verdict, records };
  const outPath = path.join(ROOT, 'evals', 'reports', `utility-${TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

  const f = (x) => (x == null ? 'n/a' : Number(x).toFixed(4));
  console.log(`tasks: ${n}`);
  console.log(`  current   plan_acc ${f(report.plan_accuracy.current)}  regret ${f(rCur)}  tok ${Math.round(report.avg_tokens.current)}  correct ${f(report.gt_recall.current)}  etc ${Math.round(report.expected_total_cost.current)}  plans [${report.selected_plans.current.join(',')}]`);
  console.log(`  utility   plan_acc ${f(report.plan_accuracy.utility)}  regret ${f(rUtil)}  tok ${Math.round(report.avg_tokens.utility)}  correct ${f(report.gt_recall.utility)}  etc ${Math.round(report.expected_total_cost.utility)}  plans [${report.selected_plans.utility.join(',')}]`);
  console.log(`  oracle    tok ${Math.round(report.avg_tokens.oracle)}`);
  console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — correctness ${verdict.correctness.ok ? '✓' : '✗'} (${verdict.correctness.current}→${verdict.correctness.utility}), regret red ${verdict.regret.reduction == null ? 'n/a' : (verdict.regret.reduction * 100).toFixed(1) + '%'} ${verdict.regret.ok ? '✓' : '✗'} (${f(rCur)}→${f(rUtil)})`);
  console.log('artefacto:', outPath);
}

main();
