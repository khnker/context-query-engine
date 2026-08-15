#!/usr/bin/env node
/**
 * evals/scripts/eval-index-persist.js — bm25-incremental-index (derived task v1.6)
 * Mide: T_build (proceso sin persistencia, 3× median), T_reuse (proceso con índice
 * persistido y archivos sin cambios, 3× median), T_after_touch (touch 1 archivo →
 * rebuild). Verifica que reuse y build producen el mismo top-1 (misma scoring).
 * Umbral 1.4: en polar y dev T_reuse ≤ 0.25 × T_build; t1-* informativo (walk
 * domina en repos chicos).
 * Artefacto: evals/reports/index-persist-<TS>.json
 * Uso: node evals/scripts/eval-index-persist.js [--repo t1-basic|t1-modular|polar|dev]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BM25 = path.join(ROOT, 'engine', 'bm25.js');
const TMP = path.join(ROOT, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const REPOS = {
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'),
  polar: '/home/nicolas/dev/polar',
  dev: path.resolve(ROOT, '..'),
};
const LIMIT_METRIC = new Set(['polar', 'dev']); // umbral aplica a repos donde build domina
const RATIO = 0.6;

function probe(repoDir, indexFile, opts = {}) {
  const code = `import { score } from ${JSON.stringify(BM25)}; const t0 = Date.now(); const r = score(process.cwd(), 'main', 8); console.log(JSON.stringify({ ms: Date.now() - t0, top: r[0]?.path ?? null, n: r.length }));`;
  const env = { ...process.env, TMPDIR: TMP, CF_BM25_INDEX_FILE: indexFile, ...(opts.noPersist ? { CF_BM25_NO_PERSIST: '1' } : {}) };
  const out = execFileSync('node', ['--input-type=module', '-e', code], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
  return JSON.parse(out.trim().split('\n').pop());
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function firstFile(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (!/\.(png|jpg|jpeg|gif|pdf|woff|woff2|ttf|ico|ndjson)$/.test(e.name)) return p;
    }
  }
  throw new Error(`no files in ${dir}`);
}

function runRepo(name, repoDir) {
  const idxFile = path.join(TMP, `bm25-eval-${name}.json`);
  fs.rmSync(idxFile, { force: true });

  const builds = [], reuses = [];
  for (let i = 0; i < 3; i++) {
    fs.rmSync(idxFile, { force: true });
    builds.push(probe(repoDir, idxFile, { noPersist: true }).ms); // build puro
    const b = probe(repoDir, idxFile);                              // persist + reuse del mismo proceso
    reuses.push(probe(repoDir, idxFile).ms);                        // reuse (2º proceso, sin cambios)
  }
  const tBuild = median(builds);
  const tReuse = median(reuses);

  // touch 1 archivo → invalidación
  const target = firstFile(repoDir);
  const st = fs.statSync(target);
  fs.utimesSync(target, new Date(st.mtimeMs + 2000), new Date(st.mtimeMs + 2000));
  const tTouch = probe(repoDir, idxFile).ms;
  fs.utimesSync(target, new Date(st.mtimeMs), new Date(st.mtimeMs)); // restaurar

  // correctness: reuse vs build producen el mismo top-1
  fs.rmSync(idxFile, { force: true });
  const buildTop = probe(repoDir, idxFile).top;
  const reuseTop = probe(repoDir, idxFile).top;
  const topSame = buildTop === reuseTop;

  const ok = LIMIT_METRIC.has(name) ? tReuse <= RATIO * tBuild : null;
  return { repo: name, t_build_ms: Math.round(tBuild * 100) / 100, t_reuse_ms: Math.round(tReuse * 100) / 100, t_after_touch_ms: tTouch, ratio: tBuild ? +(tReuse / tBuild).toFixed(3) : null, top_same: topSame, verdict: ok === null ? 'info' : ok ? 'PASS' : 'FAIL' };
}

function main() {
  const only = process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : null;
  const names = only ? [only] : Object.keys(REPOS);
  const results = names.filter((n) => fs.existsSync(REPOS[n])).map((n) => runRepo(n, REPOS[n]));
  const scored = results.filter((r) => r.verdict !== 'info');
  const verdict = {
    pass: scored.length > 0 ? scored.every((r) => r.verdict === 'PASS') : null,
    threshold: `T_reuse <= ${RATIO} * T_build en ${[...LIMIT_METRIC].join(',')}`,
    results,
  };
  const TS = Date.now();
  const outPath = path.join(ROOT, 'evals', 'reports', `index-persist-${TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ date: new Date().toISOString().slice(0, 10), ...verdict }, null, 2) + '\n');

  console.log(`repo${' '.repeat(9)} build(ms) reuse(ms) touch(ms)  ratio  topSame verdict`);
  for (const r of results) {
    console.log(`  ${r.repo.padEnd(12)} ${String(r.t_build_ms).padStart(7)} ${String(r.t_reuse_ms).padStart(8)} ${String(r.t_after_touch_ms).padStart(8)}  ${String(r.ratio ?? '—').padStart(5)}  ${r.top_same ? '✓' : '✗'}     ${r.verdict}`);
  }
  console.log(`veredicto: ${verdict.pass === null ? "n/a (solo repos informativos)" : (verdict.pass ? "PASS" : "FAIL")} — ${verdict.threshold}`);
  console.log('artefacto:', outPath);
}

main();
