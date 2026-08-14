// test/interpreter.test.js — Unit tests interpreter (tasks 2.x, D21/D22).
// node:test stdlib, lee export público interpret().
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../engine/interpreter.js';

test('2.1 familia definitions → confidence 0.8', () => {
  const r = interpret('dónde está definido foo');
  assert.equal(r.query_type, 'definitions');
  assert.equal(r.confidence, 0.8);
});

test('2.1 familia references → confidence 0.8', () => {
  const r = interpret('usos de bar');
  assert.equal(r.query_type, 'references');
  assert.equal(r.confidence, 0.8);
});

test('2.1 familia implementation → confidence 0.75', () => {
  const r = interpret('cómo funciona x');
  assert.equal(r.query_type, 'implementation');
  assert.equal(r.confidence, 0.75);
});

test('2.1 familia filename → confidence 0.8', () => {
  const r = interpret('archivo server.js');
  assert.equal(r.query_type, 'filename');
  assert.equal(r.confidence, 0.8);
});

test('2.1 familia pattern → confidence 0.6', () => {
  const r = interpret('patrón de regex');
  assert.equal(r.query_type, 'pattern');
  assert.equal(r.confidence, 0.6);
});

test('2.1 familia concept → confidence 0.6', () => {
  const r = interpret('concepto de auth');
  assert.equal(r.query_type, 'concept');
  assert.equal(r.confidence, 0.6);
});

test('2.1 2+ keywords de la misma familia → 0.95', () => {
  const r = interpret('define y declara foo');
  assert.equal(r.query_type, 'definitions');
  assert.equal(r.confidence, 0.95);
  const r2 = interpret('usos, referencias y callers de z');
  assert.equal(r2.query_type, 'references');
  assert.equal(r2.confidence, 0.95);
});

test('2.2 combinación ambigua (varias familias, 1 hit c/u) → familia de mayor score, 0.5', () => {
  const r = interpret('dónde está definido foo y cómo funciona');
  assert.equal(r.query_type, 'definitions');
  assert.equal(r.confidence, 0.5);
});

test('2.2 sin match → default implementation 0.3', () => {
  assert.deepEqual(interpret('hola mundo'), {
    query_type: 'implementation',
    confidence: 0.3,
    matched: [],
  });
});
