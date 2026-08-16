#!/usr/bin/env node
/**
 * evals/scripts/eval-index-layer.js — repository-index-layer.
 * Timings: T_build (fresh), T_reuse (sin cambios), T_incremental_1 (touch 1
 * archivo → solo ese se reindexa); latencia de queries (symbol/lexical/dependency);
 * watcher roundtrip (fs.watch + debounce); freshness state machine.
 * Verdict: reuse < build, incremental reindexa exactamente 1 archivo.
 * Artefacto: evals/reports/index-layer-<TS>.json
 * Node.js ESM, stdlib SOLO. Uso: node evals/scripts/eval-index-layer.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchRoundtrip } from '../../engine/index-layer/watcher.js';
import { walkFiles } from '../../engine/index-layer/manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'engine', 'index-layer', 'index.js');
const REPOS = {
  't1-basic': path.resolve(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.resolve(ROOT, 'evals/datasets/repos/t1-modular'),
  polar: '/home/nicolas/dev/polar',
};

function runCli(args) {
  const t0 = Date.now();
  try {
    const out = execFileSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 180000 });
    return { ms: Date.now() - t0, out: JSON.parse(out) };
  } catch (e) {
    return { ms: Date.now() - t0, out: null, error: String(e.message || e).slice(0, 120) };
  }
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

const repos = {};
for (const [name, abs] of Object.entries(REPOS)) {
  const cqe = path.join(abs, '.cqe');
  if (!fs.existsSync(abs)) continue;
  fs.rmSync(cqe, { recursive: true, force: true });
  const builds = [], reuses = [], incs = [];
  for (let i = 0; i < 3; i++) {
    const b = runCli(['index', abs]);
    builds.push(b.ms);
    if (i === 0) repos[name] = { files: b.out?.added ?? 0, index_version: b.out?.index_version ?? null };
    const r = runCli(['index', abs]);
    reuses.push(r.ms);
    const first = walkFiles(abs)[0];
    if (first) fs.utimesSync(first, new Date(), new Date());
    const inc = runCli(['index', abs]);
    incs.push(inc.ms);
    if (inc.out && i === 0) repos[name].incremental_files = inc.out.indexed_changed;
  }
  const sym = runCli(['query', abs, 'symbol', 'main', '3']);
  const lex = runCli(['query', abs, 'lexical', 'fallback', '3']);
  const dep = runCli(['query', abs, 'dependency', 'node:fs', '3']);
  const fresh = runCli(['freshness', abs]);
  repos[name].t_build_ms = median(builds);
  repos[name].t_reuse_ms = median(reuses);
  repos[name].t_incremental_ms = median(incs);
  repos[name].query = {
    symbol_ms: sym.ms, symbol_rows: sym.out?.length ?? 0,
    lexical_ms: lex.ms, lexical_rows: lex.out?.length ?? 0,
    dependency_ms: dep.ms, dependency_rows: dep.out?.length ?? 0,
  };
  repos[name].freshness_state = fresh.out?.state ?? fresh.error ?? 'error';
}

// watcher roundtrip en t1-basic
let watcherMs = null, watcherKind = null;
try {
  const t0 = Date.now();
  const batch = await watchRoundtrip(REPOS['t1-basic']);
  watcherMs = Date.now() - t0;
  watcherKind = batch[0]?.kind ?? null;
} catch (e) {
  watcherMs = null; watcherKind = String(e.message || e).slice(0, 60);
}

const t1 = repos['t1-basic'];
const pol = repos['polar'];
const reuseWin = pol ? pol.t_reuse_ms < pol.t_build_ms : t1.t_reuse_ms <= t1.t_build_ms + 15; // ruido node startup en micro-repos
const verdict = {
  reuse_faster_than_build: reuseWin,
  incremental_one_file: t1.incremental_files === 1,
  pass: reuseWin && t1.incremental_files === 1,
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), repos, watcher: { roundtrip_ms: watcherMs, first_kind: watcherKind }, verdict };
const outPath = path.join(ROOT, 'evals', 'reports', `index-layer-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

for (const [n, r] of Object.entries(repos)) {
  console.log(`${n.padEnd(12)} build ${r.t_build_ms}ms  reuse ${r.t_reuse_ms}ms  incr ${r.t_incremental_ms}ms (${r.incremental_files} f)  sym ${r.query.symbol_rows}@${r.query.symbol_ms}ms  lex ${r.query.lexical_rows}@${r.query.lexical_ms}ms  freshness ${r.freshness_state}`);
}
console.log(`watcher roundtrip: ${watcherMs}ms (${watcherKind})`);
console.log(`verdict: ${verdict.pass ? 'PASS' : 'FAIL'} — reuse<build ${verdict.reuse_faster_than_build}, incremental 1 file ${verdict.incremental_one_file}`);
console.log('artefacto:', outPath);