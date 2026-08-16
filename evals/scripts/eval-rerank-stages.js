#!/usr/bin/env node
/*
 * evals/scripts/eval-rerank-stages.js — diagnosis reranker+context (paso 07).
 * Separa el pipeline en etapas observables: retrieval pool (pre_rerank),
 * re-orden del reranker (post_rerank), selección de contexto/fusión (post_fuse).
 * Métricas por etapa y por modo (heur vs rerank): recall@5, MRR, posición del GT.
 * Atribución de pérdida: dónde cae el GT fuera del top-5 cuando está en el pool.
 * Artefacto: evals/reports/rerank-stages-<TS>.json
 * Uso: CF_TASKS=t1 node evals/scripts/eval-rerank-stages.js [--limit N]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STAGES = path.join(ROOT, '.tmp', 'stages.ndjson');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const REPO_DIRS = { 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'), 't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const rerankerModel = path.join(ROOT, 'evals', 'ml', 'model', 'reranker-model.json');
const MODEL_CMD = process.env.CF_MODEL_CMD ?? (fs.existsSync(rerankerModel) ? `node ${path.join(ROOT, 'evals', 'ml', 'classify.mjs')}` : null);
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;
const RANKS = [5];

const list = (process.env.CF_TASKS === 't1' ? TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular') : TASKS)
  .filter((t) => REPO_DIRS[t.repo]);
const rows = LIMIT ? list.slice(0, LIMIT) : list;

function groundOf(t) { return (t.primary || []).concat(t.related || []).concat(t.tests || []); }
function isHit(path1, ground) { return ground.some((g) => path1 === g || path1.endsWith('/' + g) || g.endsWith('/' + path1)); }
function rankStats(paths, ground) {
  // r5 = fracción de archivos GT cubiertos en top-5 (misma fórmula que recallAtK de los evals)
  // dedup de paths primero (mismo que eval-recall/hybrid: new Set sobre results)
  const unique = [...new Set(paths)];
  const top = unique.slice(0, 5);
  const hits = top.filter((p) => isHit(p, ground)).length;
  const r5 = ground.length ? hits / Math.min(5, ground.length) : 1;
  let mrr = 0;
  for (let i = 0; i < unique.length; i++) if (isHit(unique[i], ground)) { mrr = 1 / (i + 1); break; }
  const firstGt = unique.findIndex((p) => isHit(p, ground));
  return { r5, mrr, gtPos: firstGt === -1 ? null : firstGt + 1 };
}

function runOne(task, mode) {
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  if (fs.existsSync(STAGES)) fs.rmSync(STAGES);
  const env = {
    ...process.env, TMPDIR: path.join(ROOT, '.tmp'), CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'),
    CF_STAGES_FILE: STAGES,
    ...(mode === 'rerank' && MODEL_CMD ? { CF_MODEL_CMD: MODEL_CMD } : {}),
  };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, task.cqp], { cwd: path.resolve(ROOT, REPO_DIRS[task.repo]), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out);
  const snap = {};
  if (fs.existsSync(STAGES)) {
    for (const line of fs.readFileSync(STAGES, 'utf8').split('\n').filter(Boolean)) {
      const o = JSON.parse(line);
      snap[o.stage] = o.rows.map((r) => r.path);
    }
  }
  return { latency_ms: Date.now() - t0, tokens: j.stats?.tokens_used ?? 0, snap, reranked: j.stats?.reranked === true, plan: j.plan?.selected, n_pool: snap.pre_rerank?.length ?? 0 };
}

const agg = { heur: { candidate: [], pre: [], post: [], fuse: [], rerankLoss: 0, fuseLoss: 0, anchoredDemoted: 0, n: 0 }, rerank: { candidate: [], pre: [], post: [], fuse: [], rerankLoss: 0, fuseLoss: 0, anchoredDemoted: 0, n: 0 } };
const records = [];

for (const t of rows) {
  const ground = groundOf(t);
  const res = {};
  for (const mode of ['heur', 'rerank']) {
    if (mode === 'rerank' && !MODEL_CMD) continue;
    const run = runOne(t, mode);
    res[mode] = run;
    const pre = run.snap.pre_rerank ?? [];
    const post = run.snap.post_rerank ?? [];
    const fuse = run.snap.post_fuse ?? [];
    const a = agg[mode];
    a.n += 1;
    a.candidate.push(pre.some((p) => isHit(p, ground)) ? 1 : 0);
    a.pre.push(rankStats(pre, ground).r5);
    a.post.push(rankStats(post, ground).r5);
    a.fuse.push(rankStats(fuse, ground).r5);
    const preStats = rankStats(pre, ground);
    const postStats = rankStats(post, ground);
    const fuseStats = rankStats(fuse, ground);
    if (postStats.r5 < preStats.r5) a.rerankLoss += 1;
    if (fuseStats.r5 < (mode === 'rerank' ? postStats.r5 : preStats.r5)) a.fuseLoss += 1;
    // anchored demotion: filas exact/filename en pre top-5 que salen del top-5 post_rerank
    if (mode === 'rerank' && pre.length > 1) {
      const anchored = run.snap.pre_rerank.filter((r) => r.mt === 'exact' || r.mt === 'filename').map((r) => r.path);
      const post5 = new Set(post.slice(0, 5));
      if (anchored.some((p) => !post5.has(p))) a.anchoredDemoted += 1;
    }
    records.push({ id: t.id, repo: t.repo, mode, plan: run.plan, n_pool: run.n_pool, reranked: run.reranked, tokens: run.tokens,
      r5: { pre: preStats.r5, post: postStats.r5, fuse: fuseStats.r5 }, mrr: { pre: +preStats.mrr.toFixed(3), post: +postStats.mrr.toFixed(3), fuse: +fuseStats.mrr.toFixed(3) }, gtPos: { pre: preStats.gtPos, post: postStats.gtPos, fuse: fuseStats.gtPos } });
  }
  // divergencia por task: GT en pool pero fuera del top-5 final en rerank
  if (res.heur && res.rerank && res.rerank.snap.pre_rerank?.some((p) => isHit(p, ground)) && rankStats(res.rerank.snap.post_fuse ?? [], ground).r5 === 0) {
    records.push({ id: t.id, note: 'GT_in_pool_but_no_r5_fuse (rerank)' });
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0.0);
function fmt(a) { return { candidate_recall: +mean(a.candidate).toFixed(3), r5_pre: +mean(a.pre).toFixed(3), r5_post: +mean(a.post).toFixed(3), r5_fuse: +mean(a.fuse).toFixed(3), rerank_loss_tasks: a.rerankLoss, fuse_loss_tasks: a.fuseLoss, anchored_demoted_tasks: a.anchoredDemoted, n: a.n }; }

const report = { date: new Date().toISOString().slice(0, 10), tasks: rows.length, model: MODEL_CMD, stages: { heur: fmt(agg.heur), rerank: agg.rerank.n ? fmt(agg.rerank) : null } };
const verdict = {
  rerank_demotes_anchored: report.stages.rerank ? (report.stages.rerank.anchored_demoted_tasks > 0) : null,
  rerank_loss_where_pool_ok: report.stages.rerank ? (report.stages.rerank.rerank_loss_tasks > 0) : null,
  fuse_loss_where_pool_ok: (report.stages.heur.fuse_loss_tasks > 0),
  summary: 'atribución de pérdida de recall por etapa — el GT está en el pool (candidate recall) pero cae del top-5 en re-orden o en fusión',
};

const TS = Date.now();
const artifact = { ...report, verdict, records };
const outPath = path.join(ROOT, 'evals', 'reports', `rerank-stages-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${rows.length} | modelo: ${MODEL_CMD ?? '(ausente)'}`);
for (const m of ['heur', 'rerank']) {
  const s = report.stages[m];
  if (!s) continue;
  console.log(`  ${m.padEnd(6)} cand ${s.candidate_recall}  r5 pre ${s.r5_pre}  post ${s.r5_post}  fuse ${s.r5_fuse}  | rerankLoss ${s.rerank_loss_tasks}  fuseLoss ${s.fuse_loss_tasks}  anchoredDemoted ${s.anchored_demoted_tasks}`);
}
console.log('veredicto:', JSON.stringify(verdict));
console.log('artefacto:', outPath);