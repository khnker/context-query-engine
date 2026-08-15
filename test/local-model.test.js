// test/local-model.test.js — Unit tests local-model-interface (Phase 10).
// El contrato: sin CF_MODEL_CMD → null (fallback heurístico); con modelo → scores/latencyMs;
// fallos (binario ausente, salida corrupta, timeout) → null, nunca lanza.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { available, run, rerank, CAPACITIES } = await import('../engine/local-model.js');

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

test('12.1 rerank: contrato scores alineado + clamp 0..1', async () => {
  const prev = process.env.CF_MODEL_CMD;
  const dir = mkdtempSync(path.join(tmpdir(), 'cf-rerank-'));
  const script = path.join(dir, 'model.mjs');
  writeFileSync(script, 'console.log(JSON.stringify({scores:[0.9,0.2,0.7]}))\n');
  process.env.CF_MODEL_CMD = `node ${script}`;
  try {
    const results = [
      { path: 'a.ts', content: 'alpha' },
      { path: 'b.ts', content: 'beta' },
      { path: 'c.ts', content: 'gamma' },
      { path: 'd.ts', content: 'delta' },
    ];
    const r = await rerank(results, 'find beta');
    assert.ok(r, 'resultado no null');
    assert.equal(r.scores.length, 4, 'scores alineado a results (rellena con 0)');
    assert.deepEqual(r.scores, [0.9, 0.2, 0.7, 0]);
    assert.equal(typeof r.latencyMs, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prev !== undefined) process.env.CF_MODEL_CMD = prev;
    else delete process.env.CF_MODEL_CMD;
  }
});

test('12.1 rerank: sin modelo o salida corrupta → null (fallback heurístico)', async () => {
  const prev = process.env.CF_MODEL_CMD;
  delete process.env.CF_MODEL_CMD;
  try {
    assert.equal(await rerank([{ path: 'a.ts' }], 'q'), null, 'sin modelo → null');
    process.env.CF_MODEL_CMD = `node -e "console.log('nope')"`;
    assert.equal(await rerank([{ path: 'a.ts' }], 'q'), null, 'salida corrupta → null');
  } finally {
    if (prev !== undefined) process.env.CF_MODEL_CMD = prev;
    else delete process.env.CF_MODEL_CMD;
  }
});

test('12.1 rerank: clamp de scores fuera de rango', async () => {
  const prev = process.env.CF_MODEL_CMD;
  const dir = mkdtempSync(path.join(tmpdir(), 'cf-rerank2-'));
  const script = path.join(dir, 'model.mjs');
  writeFileSync(script, 'console.log(JSON.stringify({scores:[5,-1,0.5,"x"]}))\n');
  process.env.CF_MODEL_CMD = `node ${script}`;
  try {
    const r = await rerank([{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }], 'q');
    assert.ok(r);
    assert.deepEqual(r.scores, [1, 0, 0.5, 0], 'clamp a 0..1 y no-numérico → 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prev !== undefined) process.env.CF_MODEL_CMD = prev;
    else delete process.env.CF_MODEL_CMD;
  }
});
