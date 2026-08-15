/**
 * test/adaptive.test.js — AQP v1 (adaptive-query-processing): hook de re-optimización
 * en runPlan, flag-gated por CF_REOPT=1 (off por defecto). Se prueba vía subproceso
 * del engine (patrón de los harnesses eval) sobre el fixture t1-basic.
 * Caso under-return determinista: query filename inexistente → est >> actual(0) →
 * las ops pesadas pendientes (search-semantic/git-log/follow) se saltan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const FIXTURE = path.join(ROOT, 'evals/datasets/repos/t1-basic');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
// query symbol+follow → plan C existe (search-semantic/search-code/follow)
const QUERY = 'FIND definitions OF symbol "zzz_nonexistent_xyz" AND FOLLOW references LIMIT 8000';

function runEngine(query, extraEnv) {
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, FORCE_PLAN: 'C', ...extraEnv };
  const out = execFileSync('node', [ENGINE, query], { cwd: FIXTURE, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

test('AQP: off por defecto — sin campo reoptimized', () => {
  const r = runEngine(QUERY);
  assert.equal(r.stats.reoptimized, undefined, 'sin CF_REOPT no debe re-optimizar');
});

test('AQP: under-return (est >> actual 0) salta ops pesadas con CF_REOPT=1', () => {
  const r = runEngine(QUERY, { CF_REOPT: '1' });
  assert.match(String(r.stats.reoptimized ?? ''), /under-return-skip/, `debe marcar reoptimized (got ${JSON.stringify(r.stats)})`);
  assert.equal(r.stats.early_terminated, true, 'terminación temprana coherente');
  assert.equal(r.stats.tool_calls, 1, 'solo ejecutó el primer op');
});

test('AQP: guards — query filename (plan A) no crashea con CF_REOPT=1', () => {
  const r = runEngine('FIND filename OF file "e" LIMIT 10', { CF_REOPT: '1', CF_REOPT_THRESHOLD: '0.01' });
  assert.ok(Array.isArray(r.results), 'results sigue siendo array');
  assert.ok(r.plan, 'plan presente');
});
