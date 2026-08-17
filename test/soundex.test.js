import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { soundexCode, similarity, soundexFind, buildCorpus } from '../engine/soundex.js';

test('soundex-fallback: parseConfg codifica igual que parseConfig (typo vocal)', () => {
  assert.equal(soundexCode('parseConfg'), soundexCode('parseConfig'));
  assert.equal(soundexCode('parseConfg'), 'P622');
  assert.equal(soundexCode('retryWithFallbak'), soundexCode('retryWithFallback'));
});

test('soundex-fallback: similarity prefix-match (3+ chars = 0.8+, sin match < 0.8)', () => {
  assert.equal(similarity('P625', 'P625'), 1);
  assert.ok(similarity('P625', 'P62X') >= 0.8);
  assert.ok(similarity('P625', 'R360') < 0.8);
});

test('soundex-fallback: findInRepo encuentra typo sobre file real y rechaza inventado', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-sx-'));
  try {
    fs.writeFileSync(path.join(dir, 'fallback.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'config.py'), 'y');
    const hit = soundexFind('fallbak', dir, 0.8);
    assert.ok(hit.length >= 1);
    assert.equal(hit[0].path, path.join(dir, 'fallback.ts'));
    assert.ok(hit[0].similarity >= 0.8);
    const snake = soundexFind('get_provider_confg', dir, 0.8);
    assert.ok(snake.length >= 1);
    assert.equal(snake[0].path, path.join(dir, 'config.py'));
    assert.deepEqual(soundexFind('zxq9PlutoniumWidget', dir, 0.8), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('soundex-fallback: buildCorpus no crashe sin corpus', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-sx-'));
  try {
    assert.ok(Array.isArray(buildCorpus(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
