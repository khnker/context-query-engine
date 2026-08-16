#!/usr/bin/env node
/*
 * evals/scripts/eval-cost-model.js — operator-cost-model (paso 03 roadmap).
 * Ablación: selección con COST_TABLE estática vs CF_LEARNED_COST=1 (costos
 * medidos por op|query_class desde telemetría real) vs oráculo FORCE_PLAN A/B/C.
 * Umbral 1.5: correctness no degrada Y tokens_learned <= tokens_static.
 * Artefacto: evals/reports/cost-model-<TS>.json
 * Uso: node evals/scripts/eval-cost-model.js [--limit N]  (CF_TASKS=dev → dev)
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
const REPO_DIRS = { 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'),
  polar: '/home/nicolas/dev/polar', dev: path.resolve(ROOT, '..') };
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;

function groundOf(t) { return (t.primary || []).concat(t.related || []).concat(t.tests || []); }
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function run(query, repoDir, { force, learned }) {
  fs.rmSync(CACHE, { force: true });
  const env = { ...process.env, TMPDIR: path.join(ROOT, '.tmp'), CF_STATS_FILE: STATS,
    ...(force ? { FORCE_PLAN: force } : {}), ...(learned ? { CF_LEARNED_COST: '1' } : {}) };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, query], { cwd: repoDir, env, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const j = JSON.parse(out.toString());
  return { latency_ms: Date.now() - t0, tokens: j.stats?.tokens_used ?? 0, results: j.results ?? [], selected: j.plan?.selected };
}

function main() {
  const tasks = process.env.CF_TASKS === 'dev'
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'), 'utf8'))
    : process.env.CF_TASKS === 't1'
      ? TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular')
      : TEST.map((r) => byId[r.source]).filter(Boolean);
  const list = LIMIT ? tasks.slice(0, LIMIT) : tasks;

  const acc = { n: 0, pa: { s: 0, l: 0 }, regret: { s: [], l: [] }, tok: { s: 0, l: 0, o: 0 },
    lat: { s: 0, l: 0 }, gt: { s: 0, l: 0 }, plans: { s: new Set(), l: new Set() } };
  const records = [];

  for (const t of list) {
    const repoDir = REPO_DIRS[t.repo];
    if (!repoDir || !t.cqp) continue;
    const forced = {};
    for (const id of ['A', 'B', 'C']) forced[id] = run(t.cqp, repoDir, { force: id });
    const s = run(t.cqp, repoDir, {});
    const l = run(t.cqp, repoDir, { learned: true });
    const oracle = Object.keys(forced).sort((a, b) =>
      forced[a].tokens - forced[b].tokens || gtHits(forced[b].results, groundOf(t)) - gtHits(forced[a].results, groundOf(t)))[0];
    const ground = groundOf(t);
    const reg = (tok) => (tok - forced[oracle].tokens) / Math.max(1, forced[oracle].tokens);

    acc.n += 1;
    if (s.selected === oracle) acc.pa.s += 1;
    if (l.selected === oracle) acc.pa.l += 1;
    acc.regret.s.push(reg(s.tokens)); acc.regret.l.push(reg(l.tokens));
    acc.tok.s += s.tokens; acc.tok.l += l.tokens; acc.tok.o += forced[oracle].tokens;
    acc.lat.s += s.latency_ms; acc.lat.l += l.latency_ms;
    acc.gt.s += Math.min(1, gtHits(s.results, ground)); acc.gt.l += Math.min(1, gtHits(l.results, ground));
    acc.plans.s.add(s.selected); acc.plans.l.add(l.selected);
    records.push({ id: t.id, oracle, selected_static: s.selected, selected_learned: l.selected,
      tokens: { static: s.tokens, learned: l.tokens, oracle: forced[oracle].tokens },
      regret: { static: +reg(s.tokens).toFixed(4), learned: +reg(l.tokens).toFixed(4) },
      gt_hits: { static: gtHits(s.results, ground), learned: gtHits(l.results, ground) } });
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const n = acc.n;
  const report = {
    date: new Date().toISOString().slice(0, 10), tasks: n,
    plan_accuracy: { static: acc.pa.s / n, learned: acc.pa.l / n, oracle: 1 },
    regret: { static: mean(acc.regret.s), learned: mean(acc.regret.l) },
    avg_tokens: { static: acc.tok.s / n, learned: acc.tok.l / n, oracle: acc.tok.o / n },
    avg_latency_ms: { static: acc.lat.s / n, learned: acc.lat.l / n },
    gt_recall: { static: acc.gt.s / acc.n, learned: acc.gt.l / acc.n },
    selected_plans: { static: [...acc.plans.s].sort(), learned: [...acc.plans.l].sort() },
  };
  const okCorrect = report.gt_recall.learned >= report.gt_recall.static;
  const okTokens = report.avg_tokens.learned <= report.avg_tokens.static;
  const verdict = { pass: okCorrect && okTokens, correctness_ok: okCorrect, tokens_ok: okTokens,
    threshold: 'learned.correctness >= static.correctness AND learned.tokens <= static.tokens' };

  const TS = Date.now();
  const artifact = { ...report, verdict, records };
  const outPath = path.join(ROOT, 'evals', 'reports', `cost-model-${TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

  const f = (x) => x.toFixed(4);
  console.log(`tasks: ${n}`);
  console.log(`  static  plan_acc ${f(report.plan_accuracy.static)}  regret ${f(report.regret.static)}  tok ${Math.round(report.avg_tokens.static)}  correct ${f(report.gt_recall.static)}  lat ${Math.round(report.avg_latency_ms.static)}ms  plans [${report.selected_plans.static.join(',')}]`);
  console.log(`  learned plan_acc ${f(report.plan_accuracy.learned)}  regret ${f(report.regret.learned)}  tok ${Math.round(report.avg_tokens.learned)}  correct ${f(report.gt_recall.learned)}  lat ${Math.round(report.avg_latency_ms.learned)}ms  plans [${report.selected_plans.learned.join(',')}]`);
  console.log(`  oracle  tok ${Math.round(report.avg_tokens.oracle)}`);
  console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — correctness ${okCorrect ? '✓' : '✗'}, tokens ${okTokens ? '✓' : '✗'}`);
  console.log('artefacto:', outPath);
}

main();
