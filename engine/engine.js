#!/usr/bin/env node
/**
 * engine/engine.js — Execution Engine + Result Fusion (task 13).
 * Pipeline: parseCQP → interpret (--intent) → optimize → ejecución ordenada de ops
 * con early termination (13.1) → fusión con scripts/assemble-context (13.2) →
 * cache intra-sesión Map en memoria, TTL 5 min (13.4).
 * Node.js ESM, stdlib SOLO.
 *
 * Uso CLI:
 *   node engine/engine.js 'FIND definitions OF symbol parseConfig'
 *   node engine/engine.js --intent 'donde está definido parseConfig' --stats
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseCQP } from './cqp.js';
import { interpret } from './interpreter.js';
import { optimize, recordExecution } from './optimizer.js';
import { record } from './statistics.js';

const ENGINE_DIR = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = path.join(ENGINE_DIR, '..', 'scripts');
const CACHE_FILE = path.join(ENGINE_DIR, '.cache.json');
const CACHE_TTL = 5 * 60 * 1000; // 13.4 — TTL 5 min
const RELEVANT = new Set(['exact', 'filename', 'structural']); // 13.1 — match types que satisfacen

// 13.4 — cache intra-sesión: Map en memoria + persistencia a .cache.json
// (persistencia permite cache hits entre CLIs consecutivas; mcp-server usa el Map directo)
const cache = new Map();

export function clearCache() {
  cache.clear();
  try { fs.rmSync(CACHE_FILE, { force: true }); } catch { /* best-effort */ }
}

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (Date.now() - v.ts < CACHE_TTL) cache.set(k, v);
    }
  } catch { /* sin cache previa */ }
}

function persistCache() {
  try {
    const entries = [...cache.entries()].slice(-50);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* best-effort */ }
}

loadCache();

// --- helpers de ejecución de scripts (stdlib, execFileSync) ---
function runScript(script, args, input) {
  try {
    const out = execFileSync(script, args, { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
    return { out };
  } catch (e) {
    // exit != 0 puede traer stdout válido (ej. rg sin matches → exit 1); si no, cero resultados
    if (e.stdout) return { out: e.stdout };
    return { out: '' };
  }
}

function parseNdjson(out) {
  return out.split('\n').filter(Boolean).map((l) => {
    try {
      const o = JSON.parse(l);
      if (!o || typeof o !== 'object') return null;
      if (o.token_estimate == null) {
        o.token_estimate = Math.max(8, Math.ceil((o.content ?? o.snippet ?? '').length / 4));
      }
      return o;
    } catch { return null; }
  }).filter(Boolean);
}

// search-code (rg -n) → "path:line:content" → NDJSON
function parseGrep(out) {
  const results = [];
  for (const line of out.split('\n')) {
    const m = /^([^:]+):(\d+):(.*)$/s.exec(line);
    if (m) {
      results.push({
        source: 'rg', path: m[1], line: Number(m[2]), line_start: Number(m[2]), line_end: Number(m[2]), content: m[3],
        match_type: 'exact', score: 1, token_estimate: Math.max(8, Math.ceil(m[3].length / 4)),
      });
    }
  }
  return results;
}

// search-structure (sg run) → "path:line:col:content" o "path\n  line:col:content" → NDJSON
function parseStructural(out) {
  const results = [];
  const lines = out.split('\n');
  let pendingPath = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m1 = /^([^:]+):(\d+):(\d+):(.*)$/s.exec(line);
    if (m1) {
      results.push({
        source: 'sg', path: m1[1], line: Number(m1[2]), line_start: Number(m1[2]), line_end: Number(m1[2]), content: m1[4],
        match_type: 'structural', score: 0.9, token_estimate: Math.max(8, Math.ceil(m1[4].length / 4)),
      });
      continue;
    }
    const m2 = /^(\d+):(\d+):(.*)$/.exec(line.trim());
    if (m2 && pendingPath) {
      results.push({
        source: 'sg', path: pendingPath, line: Number(m2[1]), line_start: Number(m2[1]), line_end: Number(m2[1]), content: m2[3],
        match_type: 'structural', score: 0.9, token_estimate: Math.max(8, Math.ceil(m2[3].length / 4)),
      });
      continue;
    }
    pendingPath = line.trim();
  }
  return results;
}

// 13.1 — ejecuta una op del plan físico (pool = resultados acumulados, usado por FOLLOW/INCLUDE)
function execOp(op, plan, pool = []) {
  const name = String(op.args?.[0] ?? plan.target?.name ?? '').trim();
  if (!name) return [];
  switch (op.tool) {
    case 'search-code': {
      const r = runScript(path.join(SCRIPTS, 'search-code'), ['-d', '.', name]);
      return parseGrep(r.out);
    }
    case 'search-structure': {
      const r = runScript(path.join(SCRIPTS, 'search-structure'), ['-d', '.', name]);
      return parseStructural(r.out);
    }
    case 'search-semantic': {
      const r = runScript(path.join(SCRIPTS, 'search-semantic'), ['-d', '.', '-n', String(plan.limit ?? 10), name]);
      return parseNdjson(r.out);
    }
    case 'rg-files': {
      const r = runScript('rg', ['--files', '.']);
      const q = name.toLowerCase();
      return r.out.split('\n').filter(Boolean)
        .filter((p) => p.toLowerCase().includes(q))
        .map((p) => ({ source: 'rg-files', path: p, match_type: 'filename', score: 0.8, token_estimate: 10 }));
    }
    case 'assemble-context':
      return []; // op de fusión — se resuelve en fuse()
    case 'git-log': {
      // git-operator — historial: git log --name-only --oneline -10 (+ -S<kw> / -- <path>)
      const kw = op.keyword || (op.args?.[0] && !String(op.args[0]).includes('/') ? String(op.args[0]) : null);
      const pathArg = (op.args?.[0] && String(op.args[0]).includes('/')) ? String(op.args[0]) : null;
      let gargs = ['log', '--name-only', '--oneline', '-10'];
      if (pathArg) gargs = [...gargs, '--', pathArg];
      else if (kw && kw !== 'recent changes') gargs = [...gargs, '-S' + kw];
      let out = '';
      try {
        out = execFileSync('git', gargs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return []; // repo sin git o sin commits — 0 resultados, no crash
      }
      const seen = new Set();
      const rows = [];
      for (const l of out.split('\n')) {
        const f = l.trim();
        if (!f || !/[./]/.test(f) || f.includes(' ')) continue;
        if (seen.has(f)) continue;
        seen.add(f);
        rows.push({ source: 'git-log', path: f, line_start: 1, line_end: 1, match_type: 'git', score: 0.6, token_estimate: 5, reason: 'git history: file changed in recent commits' });
      }
      return rows;
    }
    case 'follow': {
      // D14 — FOLLOW: resuelve relations (references/definitions/usages) sobre candidatos del SEARCH
      const relations = op.relations ?? [];
      const targets = pool.slice(0, 5).map((r) => r.path).filter(Boolean);
      const out = [];
      for (const file of targets) {
        for (const rel of relations) {
          const res = runScript('rg', ['-n', name, file]);
          out.push(...parseGrep(res.out).map((m) => ({ ...m, source: 'follow', match_type: rel })));
        }
      }
      return out;
    }
    case 'include': {
      // D14 — INCLUDE: incorpora inclusions (tests/config) relacionadas con candidatos
      const inclusions = op.inclusions ?? [];
      const targets = pool.slice(0, 5).map((r) => r.path).filter(Boolean);
      const out = [];
      for (const file of targets) {
        const dir = path.dirname(file);
        const res = runScript('rg', ['--files', dir]);
        for (const p of res.out.split('\n').filter(Boolean)) {
          const base = path.basename(p);
          if (inclusions.includes('tests') && /test|spec/i.test(base) && !/node_modules/.test(p)) {
            out.push({ source: 'include', path: p, match_type: 'test', score: 0.5, token_estimate: 10 });
          } else if (inclusions.includes('config') && /(^config|\.env|\.ya?ml$|\.toml$|\.json$)/i.test(base)) {
            out.push({ source: 'include', path: p, match_type: 'config', score: 0.4, token_estimate: 10 });
          }
        }
      }
      return out;
    }
    case 'git-log': {
      // D32 — historial: git log --name-only --oneline -10 (+ -- <path> | -S<kw>)
      const kw = op.keyword && op.keyword !== 'recent changes' ? op.keyword : null;
      const pathArg = op.args?.[0] && op.args[0].includes('/') ? op.args[0] : null;
      let args;
      if (pathArg) args = ['log', '--name-only', '--oneline', '-10', '--', pathArg];
      else if (kw) args = ['log', '--name-only', '--oneline', '-10', '-S' + kw];
      else args = ['log', '--name-only', '--oneline', '-10'];
      let out = '';
      try {
        out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return []; // repo sin commits o git ausente
      }
      const files = [...new Set(out.split('\n').filter((l) => l && !l.startsWith('commit') && !/^[0-9a-f]{7,}\s/.test(l) && (l.includes('.') || l.includes('/'))))];
      return files.map((p) => ({ source: 'git-log', path: p, line_start: 1, line_end: 1, match_type: 'git', score: 0.6, token_estimate: 5, reason: 'git history: changed in recent commits' }));
    }
    default:
      return [];
  }
}

// 13.2 — fusión: NDJSON de todas las ops → assemble-context (dedup + ranking + budget + tiers)
function fuse(pool, budget) {
  if (pool.length === 0) return [];
  const input = pool.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const r = runScript(path.join(SCRIPTS, 'assemble-context'), [String(budget)], input);
  if (r.out) return parseNdjson(r.out);
  return pool; // fallback: pool crudo sin tiers
}

// --- pipeline principal ---
function runPlan(logicalPlan, rawText, opts = {}) {
  const stats = { tokens_used: 0, tool_calls: 0, early_terminated: false, cache_hits: 0 };
  const key = `${rawText}|${logicalPlan.budget ?? 8000}`;
  const phys = optimize(logicalPlan);

  // 13.4 — cache hit → skip ejecución completa
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    stats.cache_hits = 1;
    stats.tokens_used = cached.results.reduce((a, r) => a + (r.token_estimate ?? 0), 0);
    recordExecution(logicalPlan.query_type, 'cache', {
      tokens: 0, latency_ms: 0, results: cached.results.length,
      relevant: cached.results.length, satisfied: true, cache_hit: true,
    }, phys.pred_class);
    return { plan: phys, results: cached.results, stats, cached: true };
  }

  const selected = phys.plans.find((p) => p.id === phys.selected) ?? phys.plans[0];
  const pool = [];

  // 13.1 — ejecución ordenada con early termination
  for (const op of selected.ops) {
    if (op.tool === 'assemble-context') continue;
    stats.tool_calls += 1;
    const t0 = Date.now();
    const results = execOp(op, logicalPlan, pool);
    const latencyMs = Date.now() - t0;
    // optimizer-statistics: registrar estimated vs actual (best-effort, nunca rompe el pipeline)
    try {
      record({
        operator: op.tool,
        queryClass: logicalPlan.query_type,
        scope: opts.scope ?? '',
        estimated: { candidates: op.est_candidates, tokens: op.tokens, latencyMs: op.latency_ms },
        actual: {
          candidates: results.length,
          tokens: Math.max(1, Math.ceil(results.map((r) => r.content ?? r.snippet ?? '').join('\n').length / 4)),
          latencyMs,
        },
      });
    } catch { /* telemetría best-effort */ }
    const relevant = results.filter((r) => RELEVANT.has(r.match_type));
    pool.push(...results);
    recordExecution(logicalPlan.query_type, op.tool, {
      tokens: op.tokens ?? 0, latency_ms: op.latency_ms ?? 0,
      results: results.length, relevant: relevant.length,
      satisfied: relevant.length > 0, cache_hit: false,
    }, phys.pred_class);
    if (relevant.length > 0) {
      // D14 — early termination solo si no quedan ops dependientes (FOLLOW/INCLUDE)
      const pending = selected.ops.slice(selected.ops.indexOf(op) + 1)
        .some((o) => o.tool === 'follow' || o.tool === 'include');
      if (!pending) {
        stats.early_terminated = true; // op satisfizo → no ejecutar el resto
        break;
      }
    }
  }

  const results = fuse(pool, logicalPlan.budget ?? 8000);
  stats.tokens_used = results.reduce((a, r) => a + (r.token_estimate ?? 0), 0);
  cache.set(key, { results, ts: Date.now() });
  persistCache();
  return { plan: phys, results, stats, cached: false };
}

export function runCQP(cqpText, opts = {}) {
  const logicalPlan = parseCQP(cqpText); // lanza Error si input inválido
  return runPlan(logicalPlan, cqpText, opts);
}

export function runIntent(intentText, opts = {}) {
  const src = String(intentText ?? '').trim();
  const interp = interpret(src);
  const q = /"([^"]+)"/.exec(src);
  const name = interp.name ?? (q ? q[1] : src.slice(0, 60));
  const logicalPlan = {
    query_type: interp.query_type,
    target: { kind: 'symbol', name },
    relations: [], inclusions: [],
    limit: 20, budget: 8000,
    confidence: interp.confidence,
    raw: src,
  };
  return runPlan(logicalPlan, src, opts);
}

// --- CLI ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const showStats = args.includes('--stats');
  const intentIdx = args.indexOf('--intent');
  const q = args.find((a) => !a.startsWith('--'));
  try {
    if (!q) throw new Error('uso: node engine/engine.js "<CQP>" [--json] [--stats] | --intent "<texto>" [--stats]');
    const out = intentIdx >= 0 ? runIntent(args[intentIdx + 1] ?? q) : runCQP(q);
    process.stdout.write(JSON.stringify(out) + '\n');
    if (showStats) process.stderr.write(JSON.stringify(out.stats) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(1);
  }
}
