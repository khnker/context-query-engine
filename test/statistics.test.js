// test/statistics.test.js — Unit tests statistics (tasks 4.x, D21/D22/R1).
// Aísla el NDJSON con CF_STATS_FILE en tmp (no contamina engine/statistics.ndjson).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CF_STATS_FILE = path.join(
  mkdtempSync(path.join(tmpdir(), 'cf-stats-')),
  'stats.ndjson',
);
const st = await import('../engine/statistics.js');

test('4.1 record append + load agrega (avgCandidates, p95Tokens, avgLatencyMs, successRate, n)', () => {
  st.record({
    operator: 'search-code',
    queryClass: 'definitions',
    estimated: { candidates: 3, tokens: 80, latencyMs: 8 },
    actual: { candidates: 5, tokens: 100, latencyMs: 10 },
  });
  st.record({
    operator: 'search-code',
    queryClass: 'definitions',
    estimated: { candidates: 3, tokens: 80, latencyMs: 8 },
    actual: { candidates: 0, tokens: 200, latencyMs: 30 },
  });
  const map = st.load();
  const e = map.get('search-code|definitions');
  assert.ok(e, 'entrada agregada por operator|queryClass');
  assert.equal(e.n, 2);
  assert.equal(e.avgCandidates, 2.5);
  assert.equal(e.p95Tokens, 200);
  assert.equal(e.avgLatencyMs, 20);
  assert.equal(e.successRate, 0.5);
  assert.equal(e.avgEstCandidates, 3);
  assert.equal(map.get('definitions').n, 2, 'agrega también por queryClass plano');
});

test('4.2 confidence(n): umbrales 0.3 / 0.6 / 0.9', () => {
  assert.equal(st.confidence(0), 0.3);
  assert.equal(st.confidence(4), 0.3);
  assert.equal(st.confidence(5), 0.6);
  assert.equal(st.confidence(20), 0.6);
  assert.equal(st.confidence(21), 0.9);
  assert.equal(st.confidence(100), 0.9);
});

test('4.2 estimateCandidates con stats vacías → defaults', () => {
  assert.equal(st.estimateCandidates('identifier'), st.DEFAULTS.identifier);
  assert.equal(st.estimateCandidates('filename'), st.DEFAULTS.filename);
  assert.equal(st.estimateCandidates('pattern'), st.DEFAULTS.pattern);
  assert.equal(st.estimateCandidates('concept'), st.DEFAULTS.concept);
  assert.equal(st.estimateCandidates('symbol'), st.DEFAULTS.symbol);
  assert.equal(st.estimateCandidates('repo_map'), st.DEFAULTS.repo_map);
});
