import test from 'node:test';
import assert from 'node:assert/strict';
import { toPacket } from '../engine/evidence.js';
import { select, selectMMR, applySelector } from '../engine/selector.js';

const OPTS = { operator: 'search-code', query: 'FIND definitions OF symbol foo', target: { name: 'foo' } };

test('B13: score_t separa namespaces evidence/estimate', () => {
  const det = toPacket({ path: 'a.ts', match_type: 'exact', score: 1, token_estimate: 10 }, 0, OPTS);
  assert.equal(det.score_t.evidence, 1);
  assert.equal(det.score_t.estimate, null);
  const prob = toPacket({ path: 'b.ts', match_type: 'semantic', score: 0.62, token_estimate: 10 }, 0, OPTS);
  assert.equal(prob.score_t.evidence, null);
  assert.equal(prob.score_t.estimate, 0.62);
});

test('B13: provenance conserva operator/query/tier en el packet', () => {
  const p = toPacket({ path: 'a.ts', match_type: 'structural', score: 0.9, token_estimate: 10 }, 0, OPTS);
  assert.equal(p.provenance.operator, 'search-code');
  assert.equal(p.provenance.query, OPTS.query);
  assert.equal(p.provenance.tier, 0);
  assert.equal(p.evidence_tier, 0);
  const sem = toPacket({ path: 'b.ts', match_type: 'semantic', score: 0.6, token_estimate: 10 }, 0, OPTS);
  assert.equal(sem.evidence_tier, 2);
});

test('B13: selector marginal con adaptive-k nunca elimina tier0 por score', () => {
  const rows = [
    { path: 'src/sem.ts', score_final: 0.9, evidence_tier: 2, token_estimate: 10 },
    { path: 'src/def.ts', score_final: 0.1, evidence_tier: 0, token_estimate: 10 },
  ];
  const { selected } = select(rows, 8000, 'marginal', 1.0);
  assert.ok(selected.some((r) => r.evidence_tier === 0), 'tier0 eliminado por knee a pesar de score bajo');
});

test('B13: selector MMR prioriza tier0 sobre score probabilistico alto', () => {
  const rows = [
    { path: 'src/sem.ts', score_final: 0.9, evidence_tier: 2, token_estimate: 10 },
    { path: 'src/def.ts', score_final: 0.1, evidence_tier: 0, token_estimate: 10 },
  ];
  const { selected } = selectMMR(rows, 8000);
  assert.equal(selected[0].path, 'src/def.ts');
});

test('B13: applySelector conserva provenance/score_t/evidence_tier en la salida', () => {
  const packet = toPacket({ path: 'src/def.ts', match_type: 'exact', score: 1, token_estimate: 10 }, 0, OPTS);
  const { lines } = applySelector([JSON.stringify(packet)], 8000, 'marginal');
  const out = JSON.parse(lines[0]);
  assert.equal(out.provenance.query, OPTS.query);
  assert.ok(out.score_t.evidence >= 1);
  assert.equal(out.evidence_tier, 0);
});
