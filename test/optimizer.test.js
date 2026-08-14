// test/optimizer.test.js — Unit tests optimizer (tasks 3.x, D21/D22).
// node:test stdlib, lee exports públicos de optimizer y statistics (blend).
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimize, estimateCandidates as optimizerEstimate } from '../engine/optimizer.js';
import { DEFAULTS, confidence, estimateCandidates } from '../engine/statistics.js';

test('3.1 cost model: costo crece con ops (tokens/latency/calls); utility = quality / cost', () => {
  const { plans } = optimize({
    query_type: 'definitions',
    target: { kind: 'symbol', name: 'parseConfig' },
  });
  assert.ok(plans.length >= 2, 'espera ≥2 planes candidatos');
  for (const p of plans) {
    assert.ok(p.cost > 0, 'cost > 0');
    assert.ok(p.quality > 0, 'quality > 0');
    assert.equal(p.utility, p.quality / p.cost, 'utility = quality / cost');
    for (const op of p.ops) {
      assert.ok(op.tokens > 0 && op.latency_ms > 0 && op.tool_calls > 0,
        'cada op con tokens/latency/tool_calls');
    }
  }
  // costos no decrecientes (empates permitidos); existe plan más caro que el mínimo
  for (let i = 1; i < plans.length; i++) {
    assert.ok(plans[i].cost >= plans[i - 1].cost, 'costos ordenados no decrecientes');
  }
  assert.ok(plans.some((p) => p.cost > plans[0].cost), 'existe plan más costoso que el mínimo');
});

test('3.2 selección de plan; planes por query_type (selected ∈ planes)', () => {
  for (const qt of ['definitions', 'filename', 'pattern']) {
    const r = optimize({ query_type: qt, target: { kind: 'symbol', name: 'x' } });
    assert.ok(r.selected, `selected presente para ${qt}`);
    assert.ok(Array.isArray(r.plans) && r.plans.length > 0, `planes para ${qt}`);
    assert.ok(r.plans.some((p) => p.id === r.selected), `selected es un plan real (${qt})`);
  }
});

test('3.2 selección min-costo en definitions y filename', () => {
  for (const qt of ['definitions', 'filename']) {
    const r = optimize({ query_type: qt, target: { kind: 'symbol', name: 'x' } });
    const min = r.plans.reduce((m, p) => (p.cost < m.cost ? p : m), r.plans[0]);
    assert.equal(r.selected, min.id, `selected = plan de min-costo (${qt})`);
  }
});

test('3.3 confidence blend (statistics): estimado = default·(1-c) + observado·c', () => {
  const stats = new Map([['concept', { n: 50, avgCandidates: 40 }]]);
  const c = confidence(50);
  const expected = Math.round(DEFAULTS.concept * (1 - c) + 40 * c);
  assert.equal(estimateCandidates('concept', undefined, stats), expected);
});

test('3.3 optimizer.estimateCandidates: agregado por predClass desde store; default sin datos', () => {
  const store = new Map([
    ['search-code|concept', { avg_candidates: 40, records: 5 }],
    ['search-code|symbol', { avg_candidates: 12, records: 3 }],
  ]);
  assert.equal(optimizerEstimate('concept', store), 40);
  assert.equal(optimizerEstimate('symbol', store), 12);
  assert.ok(optimizerEstimate('symbol', new Map()) >= 1, 'default numérico sin datos');
});
