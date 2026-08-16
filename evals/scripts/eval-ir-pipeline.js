#!/usr/bin/env node
/**
 * evals/scripts/eval-ir-pipeline.js — context-compilation-ir (B6).
 * Parity: baseline vs CF_IR=1 sobre T1(32) — correctness/tokens no cambian
 * (el IR es representación, la ejecución es la misma); valida lowering:
 * ir.physical presente, operadores IR mapeados (SCAN/SYMBOL_LOOKUP/...),
 * access_path index cuando hay catálogo, total_est vs actual (correlación).
 * Artefacto: evals/reports/ir-pipeline-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const REPO_DIRS = { 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'), 't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

function run(task, irMode, statsFile) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo]);
  if (!repoDir || !fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  fs.writeFileSync(statsFile, '');
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: statsFile, ...(irMode ? { CF_IR: '1' } : {}) };
  const t0 = Date.now();
  let out;
  try {
    out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  } catch (e) {
    return { id: task.id, error: String(e.message || e).slice(0, 80) };
  }
  const j = JSON.parse(out.toString());
  const ir = j.plan?.ir ?? null;
  return {
    id: task.id, repo: task.repo,
    gt_hits: gtHits(j.results ?? [], groundOf(task)),
    tokens: j.stats?.tokens_used ?? 0,
    has_ir: !!ir,
    ir_operators: ir?.physical?.map((o) => o.ir) ?? null,
    access_paths: ir ? Object.entries(ir.physical.reduce((a, o) => ((a[o.access_path] = (a[o.access_path] ?? 0) + 1), a), {})) : null,
    est_tokens: ir?.total_est?.tokens ?? null,
    plan: j.plan?.selected ?? null,
  };
}

const rows = [];
for (let i = 0; i < TASKS.length; i++) {
  const t = TASKS[i];
  const base = run(t, false, path.join(tmp, `ir-base-${i}.ndjson`));
  const ir = run(t, true, path.join(tmp, `ir-${i}.ndjson`));
  if (base && ir) rows.push({ id: t.id, base: { gt_hits: base.gt_hits, tokens: base.tokens }, ir: { gt_hits: ir.gt_hits, tokens: ir.tokens, has_ir: ir.has_ir, operators: ir.ir_operators, access_paths: ir.access_paths, est_tokens: ir.est_tokens } });
}

const n = rows.length;
const parityCorrect = rows.filter((r) => (r.base.gt_hits > 0) === (r.ir.gt_hits > 0)).length;
const parityTokens = rows.every((r) => r.base.tokens === r.ir.tokens);
const withIr = rows.filter((r) => r.ir.has_ir).length;
const operatorsSeen = new Set(rows.flatMap((r) => r.ir.operators ?? []));
const indexPaths = rows.filter((r) => (r.ir.access_paths ?? []).some(([k]) => k === 'index')).length;
// correlación est vs actual (spearman simplificado sobre pares ordenados por rank)
const pairs = rows.filter((r) => r.ir.est_tokens != null);
const rankOf = (arr, v) => arr.filter((x) => x < v).length + 1;
const estR = pairs.map((r) => rankOf(pairs.map((x) => x.ir.est_tokens), r.ir.est_tokens));
const actR = pairs.map((r) => rankOf(pairs.map((x) => x.ir.tokens), r.ir.tokens));
const nR = pairs.length;
const d2 = pairs.reduce((a, r, i) => a + (estR[i] - actR[i]) ** 2, 0);
const spearman = nR > 2 ? 1 - (6 * d2) / (nR * (nR * nR - 1)) : null;

const verdict = {
  parity_correctness: parityCorrect / n,
  parity_tokens: parityTokens,
  has_ir: withIr / n,
  spearman_est_vs_actual: spearman == null ? null : +spearman.toFixed(3), // informacional: est es estático por query_type
  pass: parityCorrect === n && parityTokens && withIr === n,
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: n, verdict, operators_seen: [...operatorsSeen].sort(), rows };
const outPath = path.join(ROOT, 'evals', 'reports', `ir-pipeline-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${n} | parity correctness: ${(parityCorrect / n).toFixed(3)} | parity tokens: ${parityTokens} | has_ir: ${(withIr / n).toFixed(2)}`);
console.log(`operadores IR vistos: ${[...operatorsSeen].sort().join(', ')}`);
console.log(`queries con access_path index: ${indexPaths}/${n} | spearman est-vs-actual: ${spearman == null ? 'n/a' : spearman.toFixed(3)}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'}`);
console.log('artefacto:', outPath);