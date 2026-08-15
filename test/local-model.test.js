// test/local-model.test.js — Unit tests local-model-interface (Phase 10).
// El contrato: sin CF_MODEL_CMD → null (fallback heurístico); con modelo → scores/latencyMs;
// fallos (binario ausente, salida corrupta, timeout) → null, nunca lanza.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { available, run, CAPACITIES } = await import('../engine/local-model.js');

test('10.1 sin modelo configurado: available()=false y run()=null (fallback heurístico)', async () => {
  const prev = process.env.CF_MODEL_CMD;
  delete process.env.CF_MODEL_CMD;
  try {
    assert.equal(available(), false);
    assert.equal(await run('classify-query', { query: 'x' }), null);
  } finally {
    if (prev !== undefined) process.env.CF_MODEL_CMD = prev;
    else delete process.env.CF_MODEL_CMD;
  }
});

test('10.1 modelo configurado: run() devuelve scores + latencyMs', async () => {
  const prev = process.env.CF_MODEL_CMD;
  const dir = mkdtempSync(path.join(tmpdir(), 'cf-model-'));
  const script = path.join(dir, 'model.mjs');
  writeFileSync(script, 'console.log(JSON.stringify({scores:[0.9,0.1]}))\n');
  process.env.CF_MODEL_CMD = `node ${script}`;
  try {
    assert.equal(available(), true);
    const r = await run('classify-query', { query: 'x' });
    assert.ok(r, 'resultado no null');
    assert.deepEqual(r.scores, [0.9, 0.1]);
    assert.equal(typeof r.latencyMs, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prev !== undefined) process.env.CF_MODEL_CMD = prev;
    else delete process.env.CF_MODEL_CMD;
  }
});

test('10.1 fallos del modelo → null, nunca lanza', async () => {
  const prev = process.env.CF_MODEL_CMD;
  try {
    process.env.CF_MODEL_CMD = '/bin/no-existe-xyz';
    assert.equal(await run('rerank', {}), null, 'binario ausente → null');
    process.env.CF_MODEL_CMD = `node -e "console.log('no-json')"`;
    assert.equal(await run('rerank', {}), null, 'salida corrupta → null');
  } finally {
    if (prev !== undefined) process.env.CF_MODEL_CMD = prev;
    else delete process.env.CF_MODEL_CMD;
  }
});

test('10.1 capacidades declaradas', () => {
  assert.deepEqual(CAPACITIES, ['classification', 'reranking', 'relevance', 'embedding', 'cardinality']);
});
