#!/usr/bin/env node
/**
 * evals/scripts/eval-downstream.js — agente determinista multi-turno (change downstream-agent-eval).
 * Loop: retrieve → inspect → think → (refinar) → verify. Sin LLM (stdlib SOLO): el agente
 * es un retrieval-agent con reglas — la escalera correctness → usefulness → task completion
 * se mide con completion medible (answer contiene GT) y costo real (tokens + tool calls + tts).
 * Comparación: agente + tools crudas (rg) vs agente + CQE (engine).
 * Hipótesis falsable (5.5): "menos contexto ≠ mejor" — CQE reduce tokens SIN degradar task success.
 * Uso: node evals/scripts/eval-downstream.js [--limit N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const REPO_DIRS = { 't1-basic': 'evals/datasets/repos/t1-basic', 't1-modular': 'evals/datasets/repos/t1-modular', dev: '/home/nicolas/dev' };
const STOP = new Set(['the', 'and', 'or', 'for', 'of', 'in', 'to', 'a', 'is', 'on', 'at', 'with', 'this', 'that', 'from', 'find', 'where', 'define', 'defined', 'which', 'file', 'files', 'shows', 'show', 'list', 'all', 'de', 'el', 'la', 'los', 'las', 'que', 'se', 'en', 'del']);

const tokenize = (s) => String(s).toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2 && !STOP.has(t));

// 5.1 — suite: tareas reales con completion medible (GT verificable), repos existentes
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const suite = TASKS
  .filter((t) => fs.existsSync(path.resolve(ROOT, REPO_DIRS[t.repo] ?? '')) && (t.primary?.length || t.related?.length))
  .slice(0, 8);
if (process.argv.includes('--limit')) {
  suite.length = Math.min(suite.length, Number(process.argv[process.argv.indexOf('--limit') + 1]));
}

const matches = (f, g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f);
const readTokens = (absPath, chars = 600) => {
  try {
    const c = fs.readFileSync(absPath, 'utf8').slice(0, chars);
    return { content: c, tokens: Math.ceil(c.length / 4) };
  } catch {
    return { content: '', tokens: 0 };
  }
};

function rawRetrieve(repoDir, words) {
  const rgArgs = ['-n', '--no-ignore', '-g', '!node_modules', ...words.flatMap((w) => ['-e', w])];
  let out = '';
  try {
    out = execFileSync('rg', rgArgs, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    out = e.stdout ?? '';
  }
  const ranked = [...new Set(out.split('\n').filter(Boolean).map((l) => l.split(':')[0]).filter((p) => !p.includes('node_modules')))].slice(0, 10);
  return { ranked, tokens: Math.ceil(out.length / 4), toolCalls: 1, latencyMs: 0 };
}

function cqeRetrieve(repoDir, cqp) {
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const t0 = Date.now();
  let parsed = null;
  try {
    parsed = JSON.parse(execFileSync('node', [ENGINE, cqp], { cwd: repoDir, env: { ...process.env, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 60000 }));
  } catch (e) { parsed = { error: String(e.message ?? e).slice(0, 100) }; }
  const ranked = [...new Set((parsed.results ?? []).map((x) => x.path))].slice(0, 10);
  return { ranked, tokens: parsed.stats?.tokens_used ?? 0, toolCalls: parsed.stats?.tool_calls ?? 1, latencyMs: Date.now() - t0 };
}

// 5.2 — loop del agente: retrieve → inspect(top3, 600 chars) → think → si falla: refine + retrieve → verify
function agentLoop(repoDir, goal, cqp, mode, gt) {
  const t0 = Date.now();
  const words = tokenize(goal);
  const seen = new Set();
  let answer = [];
  let tokens = 0;
  let toolCalls = 0;
  let latency = 0;
  let rounds = 0;

  const retrieve = (w) => {
    const r = mode === 'cqe' ? cqeRetrieve(repoDir, cqp) : rawRetrieve(repoDir, w ?? words);
    tokens += r.tokens;
    toolCalls += r.toolCalls;
    latency += r.latencyMs;
    rounds += 1;
    return r;
  };

  const inspect = (ranked) => {
    for (const p of ranked.slice(0, 3)) {
      if (seen.has(p)) continue;
      seen.add(p);
      answer.push(p);
      const { tokens: tt } = readTokens(path.resolve(repoDir, p));
      tokens += tt;
      toolCalls += 1; // read = tool call
    }
  };

  let r = retrieve(words);
  inspect(r.ranked);
  // think: la GT está en el answer → done
  const satisfied = () => gt.some((g) => answer.some((f) => matches(f, g)));

  if (!gt.length || !satisfied()) {
    // refine: última palabra significativa distinta de la primera
    const refined = [...words].reverse().find((w) => w !== words[0]) ?? words[0];
    r = retrieve(refined === words[0] ? null : [refined]);
    inspect(r.ranked.filter((p) => !seen.has(p)));
  }

  return { answer: [...seen], tokens, toolCalls, ttsMs: Date.now() - t0, rounds };
}

// 5.3 — métricas por modalidad
const MODES = ['raw', 'cqe'];
const agg = { raw: { ok: 0, tokens: [], calls: [], tts: [] }, cqe: { ok: 0, tokens: [], calls: [], tts: [] } };
const rows = [];

for (const task of suite) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo]);
  const goal = task.query ?? task.cqp;
  const gt = [...(task.primary ?? []), ...(task.related ?? [])];
  for (const mode of MODES) {
    const res = agentLoop(repoDir, goal, task.cqp, mode, gt);
    const ok = gt.some((g) => res.answer.some((f) => matches(f, g)));
    agg[mode].ok += ok ? 1 : 0;
    agg[mode].tokens.push(res.tokens);
    agg[mode].calls.push(res.toolCalls);
    agg[mode].tts.push(res.ttsMs);
    rows.push({ task: task.id, mode, success: ok, tokens: res.tokens, tool_calls: res.toolCalls, tts_ms: res.ttsMs, rounds: res.rounds });
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const summary = {};
for (const m of MODES) {
  const a = agg[m];
  const tokensMean = mean(a.tokens);
  const ttsMean = mean(a.tts);
  summary[m] = {
    task_success: a.ok / suite.length,
    mean_tokens: tokensMean,
    mean_tool_calls: mean(a.calls),
    mean_tts_ms: ttsMean,
    success_per_token: a.ok / Math.max(1, a.tokens.reduce((x, y) => x + y, 0)),
    success_per_second: (a.ok / Math.max(1, a.tts.reduce((x, y) => x + y, 0))) * 1000,
  };
}

// 5.6 — umbral: CQE ≥ crudo en task success, con menos tokens
const verdict = {
  cqe_success_gte_raw: summary.cqe.task_success >= summary.raw.task_success,
  cqe_less_tokens: summary.cqe.mean_tokens < summary.raw.mean_tokens,
  pass: summary.cqe.task_success >= summary.raw.task_success && summary.cqe.mean_tokens < summary.raw.mean_tokens,
  hypothesis: 'menos contexto ≠ mejor — CQE reduce tokens SIN degradar task success',
};
if (!verdict.cqe_success_gte_raw) {
  verdict.fail_reason = 'CQE reduce tokens pero NO mantiene task success (escenario de la hipótesis falsable)';
}

const TS = Date.now();
const artifact = {
  date: new Date().toISOString().slice(0, 10),
  tasks: suite.length,
  agent: 'deterministic retrieval-agent (no LLM — stdlib SOLO): retrieve→inspect(600ch×3)→think→refine→verify',
  suite: suite.map((t) => ({ id: t.id, repo: t.repo, goal: t.query ?? t.cqp, gt: [...(t.primary ?? []), ...(t.related ?? [])] })),
  summary,
  verdict,
  rows,
};
const outPath = path.join(ROOT, 'evals', 'reports', `downstream-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`downstream eval — ${suite.length} tareas | agente determinista 2-turno`);
for (const m of MODES) {
  const s = summary[m];
  console.log(`  ${m.padEnd(5)} success ${s.task_success.toFixed(3)}  tok ${Math.round(s.mean_tokens)}  calls ${s.mean_tool_calls.toFixed(1)}  tts ${Math.round(s.mean_tts_ms)}ms  succ/tok ${s.success_per_token.toFixed(5)}  succ/s ${s.success_per_second.toFixed(3)}`);
}
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — CQE≥crudo: ${verdict.cqe_success_gte_raw}, CQE<crudo tokens: ${verdict.cqe_less_tokens}`);
if (verdict.fail_reason) console.log('razón:', verdict.fail_reason);
console.log('hipótesis:', verdict.hypothesis);
console.log('artefacto:', outPath);
