// test/cqp.test.js — Unit tests parser CQP (tasks 1.x, D21/D22).
// node:test stdlib, lee exports públicos (parseAST/toLogicalPlan/parseCQP).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAST, parseCQP, toLogicalPlan } from '../engine/cqp.js';

const FULL =
  'find definitions of symbol foo follow references include tests limit 5 budget 2000';

test('1.1 parseAST: query completa (find/of/follow/include/limit/budget) → shape del AST', () => {
  const ast = parseAST(FULL);
  assert.equal(ast.operator, 'find');
  assert.equal(ast.target.type, 'definitions');
  assert.equal(ast.target.kind, 'symbol');
  assert.equal(ast.target.value, 'foo');
  assert.deepEqual(ast.relations, [{ operator: 'follow', type: 'references' }]);
  assert.deepEqual(ast.include, ['tests']);
  assert.equal(ast.limit, 5);
  assert.equal(ast.budget, 2000);
});

test('1.2 toLogicalPlan: AST → plan (query_type, limit, budget) e igual a parseCQP', () => {
  const ast = parseAST(FULL);
  const plan = toLogicalPlan(ast);
  assert.equal(plan.query_type, 'definitions');
  assert.equal(plan.limit, 5);
  assert.equal(plan.budget, 2000);
  assert.deepEqual(plan.target, { kind: 'symbol', name: 'foo' });
  assert.deepEqual(plan.relations, ['references']);
  assert.deepEqual(plan.inclusions, ['tests']);
  // D22: compat total parseCQP = toLogicalPlan(parseAST(x))
  assert.deepEqual(plan, parseCQP(FULL));
});

test('1.3 parseCQP compat: defaults (limit 20, budget 8000) y forma del plan', () => {
  const plan = parseCQP('find definitions of symbol foo');
  assert.deepEqual(plan, {
    query_type: 'definitions',
    target: { kind: 'symbol', name: 'foo' },
    relations: [],
    inclusions: [],
    limit: 20,
    budget: 8000,
    confidence: 0.95,
    raw: '',
  });
});

test('1.3 error: input inválido lanza CqpError, sin plan parcial', () => {
  assert.throws(() => parseCQP(''), /empty input/);
  // sin keyword FIND → error FIND missing (el texto no debe contener "find")
  assert.throws(() => parseCQP('esto no tiene cláusulas'), /FIND/);
  assert.throws(() => parseCQP('find definitions of symbol foo limit abc'), /invalid LIMIT/);
  assert.throws(() => parseCQP('find definitions of symbol foo budget xyz'), /invalid BUDGET/);
  assert.throws(() => parseCQP('find definitions of symbol foo include nope'), /invalid INCLUDE/);
  assert.throws(() => parseCQP('find definitions of symbol foo follow nope'), /invalid FOLLOW/);
});

test('1.4 BUDGET mapeo: 5000→2000, 15000→8000, 40000→30000, 100→2000 (piso)', () => {
  assert.equal(parseCQP('find definitions of symbol foo budget 5000').budget, 2000);
  assert.equal(parseCQP('find definitions of symbol foo budget 15000').budget, 8000);
  assert.equal(parseCQP('find definitions of symbol foo budget 40000').budget, 30000);
  assert.equal(parseCQP('find definitions of symbol foo budget 100').budget, 2000);
});
