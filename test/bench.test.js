// test/bench.test.js — Métricas DURAS: tiempo y tokens reales (contextforge C vs
// baseline raw-fs A) sobre repo sintético, con guardas de regresión.
// npx node --test test/bench.test.js   (o npm run bench)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const REPO_DIRS = { 't1-basic': 'evals/datasets/repos/t1-basic', 't1-modular': 'evals/datasets/repos/t1-modular' };
const SAMPLE = ['lex-01', 'dep-01', 'sem-01', 'tst-01'];

function runRunner(runner, task) {
  const repo = path.join(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  const out = execFileSync('bash', [path.join(ROOT, runner), task.id, repo], {
    encoding: 'utf8', timeout: 60000,
  });
  return JSON.parse(out.split('\n')[0]);
}

test('bench: métricas duras — tokens y latencia (C vs A), guardas de regresión', () => {
  const rows = [];
  let aTokens = 0;
  let cTokens = 0;
  let wallStart = Date.now();
  for (const id of SAMPLE) {
    const task = TASKS.find((t) => t.id === id);
    assert.ok(task, `task ${id} existe`);
    const t0 = Date.now();
    const a = runRunner('evals/runners/run-raw-fs.sh', task);
    const c = runRunner('evals/runners/run-contextforge.sh', task);
    rows.push({
      task: id,
      a_tokens: a.tokens, c_tokens: c.tokens,
      a_latency_ms: a.latency_ms, c_latency_ms: c.latency_ms,
      a_success: a.success, c_success: c.success,
    });
    aTokens += a.tokens;
    cTokens += c.tokens;
  }
  const wallMs = Date.now() - wallStart;

  for (const r of rows) {
    // guardas duras (bound generosos sobre lo observado en el benchmark T1)
    assert.ok(r.c_tokens <= 5000, `${r.task}: C tokens ${r.c_tokens} ≤ 5000`);
    assert.ok(r.c_tokens < r.a_tokens, `${r.task}: C tokens < A (${r.c_tokens} < ${r.a_tokens})`);
    assert.ok(r.c_latency_ms <= 5000, `${r.task}: C latencia ${r.c_latency_ms}ms ≤ 5000ms`);
    assert.ok(r.a_latency_ms <= 30000, `${r.task}: A latencia ${r.a_latency_ms}ms ≤ 30000ms`);
  }

  const compr = aTokens > 0 ? (1 - cTokens / aTokens) * 100 : 0;
  console.log('\n=== BENCH (métricas duras) ===');
  console.table(rows);
  console.log(JSON.stringify({
    queries: SAMPLE.length,
    wall_ms: wallMs,
    tokens: { A_total: aTokens, C_total: cTokens },
    compression_pct: Math.round(compr * 10) / 10,
  }, null, 2));
  assert.ok(compr >= 50, `compresión C vs A ≥ 50% (real: ${Math.round(compr)}%)`);
});
