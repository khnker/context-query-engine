#!/usr/bin/env node
/**
 * evals/scripts/eval-fingerprint.js — repo-fingerprint-consistency.
 * Verifica la máxima transversal:
 *  1. cache engine: touch archivo → con CF_FINGERPRINT=1 el 2º run NO da cache hit
 *     (sin fingerprint SÍ daría hit dentro del TTL → contraste);
 *  2. BM25 persistido: reuse OK → touch → rebuild (from_persist false);
 *  3. statistics: records llevan repo_fp (provenance).
 * Artefacto: evals/reports/fingerprint-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const REPO = path.resolve(ROOT, 'evals/datasets/repos/t1-basic');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });
const Q = 'FIND definitions OF symbol retryWithFallback LIMIT 10';
const TOUCH = path.join(REPO, 'src', 'utils', 'helpers.ts');
const CARD = 'fingerprint';

function runEngine(env) {
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, Q], { cwd: REPO, env: { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...env }, encoding: 'utf8', timeout: 120000 });
  const j = JSON.parse(out);
  return { cache_hits: j.stats?.cache_hits ?? 0, tokens: j.stats?.tokens_used ?? 0, ms: Date.now() - t0 };
}

function touch() {
  const t = new Date(Date.now() + 1000);
  fs.utimesSync(TOUCH, t, t);
  fs.utimesSync(TOUCH, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
}

// --- 1. cache engine ---
fs.rmSync(CACHE, { force: true });
const cold = runEngine({});
const warm = runEngine({});                    // hit (nada cambió)
touch();
const afterTouch = runEngine({ CF_FINGERPRINT: '1' }); // 0 = invalidada por fingerprint
const afterTouch2 = runEngine({ CF_FINGERPRINT: '1' }); // 1 = repoblada, estable
const cache = {
  cold_hits: cold.cache_hits, warm_hits: warm.cache_hits,
  after_touch_fp_hits: afterTouch.cache_hits,
  after_touch2_fp_hits: afterTouch2.cache_hits,
};

// --- 2. BM25 persistido ---
const idxFile = path.join(tmp, `.bm25-${CARD}.json`);
fs.rmSync(idxFile, { force: true });
const bm25Run = (extra) => {
  const t0 = Date.now();
  execFileSync('node', ['--input-type=module', '-e', `
    import { score } from '/home/nicolas/dev/contextforge/engine/bm25.js';
    const r = score(process.cwd(), 'retryWithFallback helpers', 8);
    console.log(JSON.stringify({ n: r.length, from_persist: process.env.FP_MARK ?? null }));
  `], { cwd: REPO, env: { ...process.env, CF_BM25_INDEX_FILE: idxFile, FP_MARK: '', ...extra }, encoding: 'utf8', timeout: 120000 });
  return Date.now() - t0;
};
const b1 = bm25Run({});
const b2 = bm25Run({});          // reuse (persistido)
const fpBefore = JSON.parse(fs.readFileSync(idxFile, 'utf8'))[path.resolve(REPO)]?.fp ?? null;
touch();
const b3 = bm25Run({});          // fingerprint cambió → rebuild
const fpAfter = JSON.parse(fs.readFileSync(idxFile, 'utf8'))[path.resolve(REPO)]?.fp ?? null;
const bm25 = {
  build_ms: b1, reuse_ms: b2, rebuild_after_touch_ms: b3,
  persisted_fp_present: Boolean(fpBefore), fp_updated_on_rebuild: Boolean(fpBefore) && fpAfter !== fpBefore,
};

// --- 3. statistics provenance ---
const statsFile = path.join(ROOT, 'engine/statistics.ndjson');
let statsFp = null;
try {
  const lines = fs.readFileSync(statsFile, 'utf8').split('\n').filter(Boolean);
  statsFp = lines.length ? (JSON.parse(lines[lines.length - 1]).repo_fp ?? null) : null;
} catch { /* sin stats */ }

const verdict = {
  cache_invalidated_by_touch: cache.after_touch_fp_hits === 0 && cache.after_touch2_fp_hits === 1,
  bm25_rebuild_on_change: bm25.fp_updated_on_rebuild,
  stats_have_provenance: typeof statsFp === 'string' && statsFp.length === 64,
  pass: cache.after_touch_fp_hits === 0 && cache.after_touch2_fp_hits === 1 && bm25.fp_updated_on_rebuild && typeof statsFp === 'string' && statsFp.length === 64,
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), cache, bm25, stats_provenance: statsFp ? 'present' : 'absent', verdict };
const outPath = path.join(ROOT, 'evals', 'reports', `fingerprint-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log('cache   :', JSON.stringify(cache));
console.log('bm25    : build', b1, 'ms | reuse', b2, 'ms | tras touch', b3, 'ms | fp persistido', Boolean(fpBefore), '| fp actualizado en rebuild', bm25.fp_updated_on_rebuild);
console.log('stats   : repo_fp', statsFp ? 'present (' + statsFp.slice(0, 8) + '…)' : 'absent');
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — cache invalidada por touch ${verdict.cache_invalidated_by_touch}, bm25 rebuild ${verdict.bm25_rebuild_on_change}, stats provenance ${verdict.stats_have_provenance}`);
console.log('artefacto:', outPath);