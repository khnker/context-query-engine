#!/usr/bin/env node
/**
 * evals/scripts/eval-indexing.js — indexing cost & break-even (openspec change indexing-cost-breakeven, tasks 3.1-3.5).
 *
 * Mide por repo (t1-basic, t1-modular, polar, dev):
 *   3.1 T_index    — build BM25 cold (proceso fresh, index lazy per-process) 3x → median;
 *                    T_incremental — touch 5 files + 1 build fresh (impl actual reindexa full por proceso → proxy);
 *                    RAM pico (rss tras build), disk (bytes de archivos indexados), CPU (proxy = wall time).
 *   3.2 T_query cold/warm — engine.js sobre cqp representativo del repo; cold = rm cache; warm = cache hit persistido.
 *   3.3 N_break_even = T_index / (baseline_rg − T_query_warm); si denominador <= 0 → N=0. Alternativa vs BM25-only cold.
 *   3.4 artefacto evals/reports/indexing-cost-<TS>.json + tabla en README (sección manual post-run).
 *   3.5 veredicto por repo vs umbral N>100: "usar rg para workloads < N queries".
 *
 * Node.js ESM, stdlib SOLO. Uso: TMPDIR=$PWD/.tmp node evals/scripts/eval-indexing.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const BM25 = path.join(ROOT, 'engine', 'bm25.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STATS = path.join(ROOT, 'engine', 'statistics.ndjson');

// sistema /tmp lleno (EDQUOT) → siempre TMPDIR propio para subprocesos
process.env.TMPDIR = process.env.TMPDIR ?? path.join(ROOT, '.tmp');
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
try {
  TASKS.push(...JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks-dev.json'), 'utf8')));
} catch { /* sin tasks-dev */ }

const REPOS = {
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'),
  polar: '/home/nicolas/dev/polar',
  dev: '/home/nicolas/dev',
};
const THRESHOLD = 100; // 3.5 — umbral de queries para pagar setup
const REPO_TIMEOUT_MS = 590_000; // ~600s por repo

// --- réplica de walkFiles de engine/bm25.js (mismos límites: MAX_FILES=1000, MAX_FILE_BYTES=256KB)
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.woff', '.woff2', '.ttf', '.ico', '.ndjson', '.bin', '.zip', '.gz']);
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'openspec', '.tmp', 'dist', 'build']);
function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return out;
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (!SKIP_EXT.has(path.extname(e.name))) {
      try {
        if (fs.statSync(p).size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      out.push(p);
    }
  }
  return out;
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const stats = (a) => ({ mean: mean(a), median: median(a) });

function pickQuery(repo) {
  const t = TASKS.find((x) => x.repo === repo);
  return t ? { cqp: t.cqp, query: t.query } : null;
}

/** 3.1 — build BM25 cold en proceso fresh (index lazy per-process) → {ms, rss, n} */
function indexProbe(repoDir, q) {
  const code = [
    `import { score } from ${JSON.stringify('file://' + BM25)};`,
    `const t0 = process.hrtime.bigint();`,
    `const r = score(${JSON.stringify(repoDir)}, ${JSON.stringify(q)});`,
    `const t1 = process.hrtime.bigint();`,
    `console.log(JSON.stringify({ ms: Number(t1 - t0) / 1e6, rss: process.memoryUsage().rss, n: r.length }));`,
  ].join('\n');
  const stdout = execFileSync('node', ['--input-type=module', '-e', code], {
    cwd: repoDir, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

/** 3.2 — engine.js; cold=true → rm cache (fresh spawn). Devuelve {ms, cache_hits} */
function runEngine(repoDir, cqp, cold, extraEnv = {}) {
  if (cold && fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, CF_STATS_FILE: STATS, ...extraEnv };
  const t0 = Date.now();
  const stdout = execFileSync('node', [ENGINE, cqp], {
    cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim().split('\n').pop());
  return { ms: Date.now() - t0, cache_hits: parsed.stats?.cache_hits ?? 0 };
}

/** baseline rg (mismo shape que eval-baselines runRaw) → ms o null si rg no disponible */
function runRg(repoDir, query) {
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (!words.length) return null;
  const t0 = Date.now();
  try {
    // solo importa el wall time: stdout descartado (queries con stopwords → GB de matches)
    execFileSync('rg', ['-n', '--no-ignore', '-g', '!node_modules', ...words.flatMap((w) => ['-e', w]), '.'], {
      cwd: repoDir, stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (e) {
    if (e.status !== 1) return null; // 1 = sin matches, tiempo igualmente válido
  }
  return Date.now() - t0;
}

const artifact = { date: new Date().toISOString().slice(0, 10), repos: {}, verdict: {} };
const lines = [];
for (const [name, repoDir] of Object.entries(REPOS)) {
  const started = Date.now();
  const left = () => REPO_TIMEOUT_MS - (Date.now() - started);
  const q = pickQuery(name);
  const repo = { cqp: q.cqp, query: q.query, note: {} };
  console.log(`\n=== ${name} (${repoDir})`);

  try {
    if (!fs.existsSync(repoDir)) throw new Error('repo dir no existe');
    const files = walkFiles(repoDir);
    repo.file_count = files.length;
    repo.total_bytes = files.reduce((a, f) => { try { return a + fs.statSync(f).size; } catch { return a; } }, 0);
    console.log(`  files: ${files.length}, bytes: ${repo.total_bytes}`);

    // 3.1 — T_index cold 3x + RAM pico
    const idx = [];
    let rssPeak = 0;
    for (let i = 0; i < 3 && left() > 0; i++) {
      const res = indexProbe(repoDir, q.query);
      idx.push(res.ms);
      rssPeak = Math.max(rssPeak, res.rss);
      console.log(`  index run ${i + 1}: ${res.ms.toFixed(0)}ms rss=${(res.rss / 1048576).toFixed(0)}MB`);
    }
    if (left() <= 0) throw new Error('timeout en index build');
    repo.index_ms = stats(idx);
    repo.rss_peak_mb = Math.round((rssPeak / 1048576) * 10) / 10;

    // 3.1 — T_incremental: touch 5 archivos (mtime, sin contenido) + 1 build fresh
    // impl actual reindexa full por proceso → proxy = un build completo más
    for (const f of files.slice(0, 5)) {
      try { const s = fs.statSync(f); fs.utimesSync(f, new Date(s.mtimeMs + 2000), new Date(s.mtimeMs + 2000)); } catch { /* best-effort */ }
    }
    const inc = indexProbe(repoDir, q.query).ms;
    repo.t_incremental_ms = inc;
    repo.note.t_incremental = 'impl actual reindexa full por proceso; touch 5 files no reduce coste (proxy = build completo)';
    console.log(`  incremental (touch 5 files + full rebuild proxy): ${inc.toFixed(0)}ms`);

    // 3.2 — T_query cold 3x (rm cache) / warm 3x (cache persistido)
    const cold = [], warm = [];
    for (let i = 0; i < 3 && left() > 0; i++) {
      const r = runEngine(repoDir, q.cqp, true);
      cold.push(r.ms);
      console.log(`  query cold ${i + 1}: ${r.ms}ms`);
    }
    if (left() <= 0) throw new Error('timeout en query cold');
    for (let i = 0; i < 3 && left() > 0; i++) {
      const r = runEngine(repoDir, q.cqp, false);
      warm.push(r.ms);
      if (r.cache_hits !== 1) console.warn(`  ! warm run ${i + 1} sin cache_hit`);
      console.log(`  query warm ${i + 1}: ${r.ms}ms cache_hits=${r.cache_hits}`);
    }
    if (left() <= 0) throw new Error('timeout en query warm');
    repo.query_cold_ms = stats(cold);
    repo.query_warm_ms = stats(warm);

    // 3.3 — baseline rg (3x median)
    const rg = [];
    for (let i = 0; i < 3 && left() > 0; i++) {
      const m = runRg(repoDir, q.query);
      rg.push(m);
      console.log(`  rg baseline ${i + 1}: ${m}ms`);
    }
    repo.baseline_rg_ms = stats(rg.filter((x) => x !== null));
    if (rg.some((x) => x === null)) repo.note.rg = 'rg no disponible en alguna corrida; median sobre corridas válidas';

    // 3.3 — alternativa vs BM25-only cold (reindexa por proceso; 2x median)
    const bm25 = [];
    for (let i = 0; i < 2 && left() > 0; i++) {
      const r = runEngine(repoDir, q.cqp, true, { CF_RETRIEVAL: 'bm25' });
      bm25.push(r.ms);
      console.log(`  bm25-only cold ${i + 1}: ${r.ms}ms`);
    }
    repo.bm25_cold_ms = stats(bm25);

    // 3.3 — N_break_even
    const tIndex = repo.index_ms.median;
    const tWarm = repo.query_warm_ms.median;
    const tBaseline = repo.baseline_rg_ms.median;
    const denom = tBaseline - tWarm;
    repo.n_break_even = denom > 0 ? tIndex / denom : 0;
    repo.note.n_break_even = denom <= 0
      ? `denominador <= 0: CQE warm no es más barato por query que el baseline (overhead node+engine ~${tWarm.toFixed(0)}ms domina en repos chicos) → setup nunca se amortiza; N=0 por regla 3.3`
      : `N = T_index(${tIndex.toFixed(0)}ms) / (rg ${tBaseline.toFixed(0)}ms − warm ${tWarm.toFixed(0)}ms)`;
    const denomB = repo.bm25_cold_ms.median - tWarm;
    repo.n_break_even_bm25 = denomB > 0 ? tIndex / denomB : 0;
    repo.note.n_break_even_bm25 = 'vs BM25-only cold (reindexa por proceso cada query): CQE evita re-indexar → quiebre en ~1 query';

    // 3.5 — veredicto vs umbral
    const n = repo.n_break_even;
    repo.verdict = n === 0
      ? `CQE warm (${tWarm.toFixed(0)}ms) >= rg (${tBaseline.toFixed(0)}ms) por query; setup nunca se amortiza (N=0, regla 3.3); en repos chicos conviene rg directo`
      : n <= THRESHOLD
        ? `CQE paga su setup tras <=${THRESHOLD} queries (N=${n.toFixed(1)}); indexación recomendable`
        : `N_break_even=${n.toFixed(0)} > ${THRESHOLD}: usar rg para workloads < ${n.toFixed(0)} queries`;

    lines.push(
      `${name.padEnd(10)} files=${String(files.length).padStart(5)} bytes=${String(repo.total_bytes).padStart(9)} ` +
      `T_index=${tIndex.toFixed(0).padStart(5)}ms RSS=${repo.rss_peak_mb.toFixed(1).padStart(6)}MB ` +
      `qCold=${repo.query_cold_ms.median.toFixed(0).padStart(4)}ms qWarm=${tWarm.toFixed(0).padStart(3)}ms ` +
      `rg=${tBaseline.toFixed(0).padStart(4)}ms bm25=${repo.bm25_cold_ms.median.toFixed(0).padStart(5)}ms ` +
      `N_be=${repo.n_break_even.toFixed(1).padStart(7)}`
    );
  } catch (e) {
    repo.error = String(e.message ?? e);
    repo.verdict = `ERROR: ${repo.error}`;
    console.error(`  ! ${name}: ${repo.error}`);
  }
  artifact.repos[name] = repo;
}

artifact.verdict = {
  threshold: THRESHOLD,
  rule: `repos con N_break_even > ${THRESHOLD}: usar rg para workloads < N queries`,
  per_repo: Object.fromEntries(Object.entries(artifact.repos).map(([k, r]) => [k, r.verdict])),
};

const outPath = path.join(ROOT, 'evals', 'reports', `indexing-cost-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log('\n--- resumen ---');
console.log(lines.join('\n'));
console.log(`\nveredicto (umbral N>${THRESHOLD}):`);
for (const [k, v] of Object.entries(artifact.verdict.per_repo)) console.log(`  ${k.padEnd(10)} ${v}`);
console.log('artefacto:', outPath);
