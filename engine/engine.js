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
import { decompose } from './decompose.js';
import { interpret } from './interpreter.js';
import { optimize, recordExecution } from './optimizer.js';
import { record, setFingerprint } from './statistics.js';
import { available as modelAvailable, rerankSync } from './local-model.js';
import { score as bm25Score } from './bm25.js';
import { compile as irCompile, irStats } from './ir.js';
import * as claimMod from './claim.js';
import * as receiptMod from './receipt.js';
import { rrfFuse } from './rrf.js';
import { toPacket } from './evidence.js';
import { structuralRefine } from './structural-refine.js';
import { repoFingerprint, walkFiles } from './index-layer/manifest.js';
import { ensureIndex, symbolLookup, lexicalLookup, dependencyExpand } from './index-ops.js';
import { select as selectorSelect } from './selector.js';

const ENGINE_DIR = fileURLToPath(new URL('.', import.meta.url));
const SCRIPTS = path.join(ENGINE_DIR, '..', 'scripts');
const CACHE_FILE = path.join(ENGINE_DIR, '.cache.json');
// override de presupuesto por env (eval-quality por niveles de budget; si no, usa el plan)
const CF_BUDGET = Number(process.env.CF_BUDGET) || 0;
const effectiveBudget = (lp) => (CF_BUDGET > 0 ? CF_BUDGET : lp.budget ?? 8000);
const CACHE_TTL = 5 * 60 * 1000; // 13.4 — TTL 5 min
const RELEVANT = new Set(['exact', 'filename', 'structural']); // 13.1 — match types que satisfacen

// reranker-context-diagnosis — CF_STAGES_FILE: snapshots del pipeline por etapas
// (pre-rerank / post-rerank / post-fuse) para atribuir pérdidas de recall.
const STAGES_FILE = process.env.CF_STAGES_FILE ?? '';
function stageSnap(name, rows) {
  if (!STAGES_FILE) return;
  try {
    fs.appendFileSync(STAGES_FILE, JSON.stringify({ stage: name, rows: rows.map((r) => ({ path: r.path, mt: r.match_type, s: r.score ?? null })) }) + '\n');
  } catch { /* best-effort */ }
}

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
    const fp = useFp() ? repoFp(process.cwd()) : null;
    for (const [k, v] of Object.entries(raw)) {
      if (Date.now() - v.ts < CACHE_TTL && (!v.fp || v.fp === fp)) cache.set(k, v);
    }
  } catch { /* sin cache previa */ }
}

function persistCache() {
  try {
    const entries = [...cache.entries()].slice(-50);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* best-effort */ }
}

// repo-fingerprint-consistency — fingerprint del repo (provenance de cache/stats).
// Barato: walk+stat sin contenido. Activo si CF_FINGERPRINT=1 o existe catálogo.
const fpMemo = new Map();
const useFp = () => process.env.CF_FINGERPRINT === '1' || fs.existsSync(path.join(process.cwd(), '.cqe', 'catalog.db'));
const repoFp = (dir) => {
  const key = path.resolve(dir);
  if (!fpMemo.has(key)) fpMemo.set(key, repoFingerprint(key));
  return fpMemo.get(key);
};

loadCache(); // tras definir helpers (TDZ: useFp/repoFp son const)

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
      if (!o || typeof o !== 'object' || typeof o.path !== 'string') return null; // skip línea stats de assemble-context (sin path)
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
      const gargs = ['--files', '.'];
      if (process.env.CF_SEARCH_NO_IGNORE === '1') gargs.unshift('--no-ignore'); // M2 opt-in generated-code
      const r = runScript('rg', gargs);
      const q = name.toLowerCase();
      return r.out.split('\n').filter(Boolean)
        .filter((p) => !/node_modules/.test(p))
        .filter((p) => p.toLowerCase().includes(q))
        .map((p) => ({ source: 'rg-files', path: p, line_start: 1, line_end: 1, match_type: 'filename', score: 0.8, token_estimate: 10 }));
    }
    case 'bm25': {
      // hybrid-retrieval-comparison — BM25 propio (engine/bm25.js, stdlib).
      // Paths relativos al repo (cwd); snippet = primeras líneas del archivo.
      const hits = bm25Score(process.cwd(), name, plan.limit ?? 8);
      return hits.map(({ path: p, score: sc }) => {
        let content = '';
        try {
          content = fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
        } catch {
          content = '';
        }
        const snippet = content.slice(0, 200); // acotado: snippets grandes comen el budget de fuse
        return {
          source: 'bm25', path: p, line_start: 1, line_end: Math.min(20, content.split('\n').length),
          content: snippet, match_type: 'semantic', score: sc,
          token_estimate: Math.max(8, Math.ceil(snippet.length / 4)),
        };
      });
    }
    case 'symbol-lookup': {
      // context-query-ir — access path sobre catálogo (SQLite): símbolos deterministas
      return symbolLookup(process.cwd(), name, plan.limit ?? 10);
    }
    case 'lexical-index': {
      return lexicalLookup(process.cwd(), name, plan.limit ?? 10);
    }
    case 'dependency-expand': {
      return dependencyExpand(process.cwd(), name, plan.limit ?? 10);
    }
    case 'read-span': {
      // read-span-op — operador físico READ_SPAN: materializa SOLO el span
      // (path + [line_start, line_end]) de un row de evidencia, no el archivo.
      // args: [path, startLine, endLine]; fallback al archivo completo si no hay span.
      const [rpath, start, end] = op.args ?? [];
      if (!rpath) return [];
      let content = '';
      try {
        content = fs.readFileSync(path.resolve(process.cwd(), String(rpath)), 'utf8');
      } catch {
        return [];
      }
      const lines = content.split('\n');
      const s = Number(start) || 1;
      const e = Math.min(Number(end) || s, lines.length);
      const span = lines.slice(s - 1, e).join('\n');
      return [{
        source: 'read-span', path: String(rpath), line_start: s, line_end: e,
        content: span, match_type: 'reference', score: 0.7,
        token_estimate: Math.max(4, Math.ceil(span.length / 4)), span_only: true,
      }];
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
            out.push({ source: 'include', path: p, line_start: 1, line_end: 1, match_type: 'test', score: 0.5, token_estimate: 10 });
          } else if (inclusions.includes('config') && /(^config|\.env|\.ya?ml$|\.toml$|\.json$)/i.test(base)) {
            out.push({ source: 'include', path: p, line_start: 1, line_end: 1, match_type: 'config', score: 0.4, token_estimate: 10 });
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
  const fb = process.env.CF_FLOOD_BOOST ?? '0';
  const r = runScript(path.join(SCRIPTS, 'assemble-context'), [String(budget), fb], input);
  if (r.out) return parseNdjson(r.out);
  return pool; // fallback: pool crudo sin tiers
}

// evidence-state — belief state por query: fuentes, agreement cross-source
// (soporte top-5 con paths normalizados), coverage de evidencia determinista.
function beliefFromPool(pool) {
  const bySource = {};
  for (const r of pool) {
    const s = r.source ?? r.match_type ?? 'unknown';
    (bySource[s] ??= []).push({ p: String(r.path ?? '').replace(/^\.\//, ''), t: r.match_type ?? '', s: r.score ?? 0 });
  }
  const keys = Object.keys(bySource).filter((k) => bySource[k].length > 0);
  const N = 5;
  const cands = new Map();
  for (const k of keys) for (const { p } of bySource[k].slice(0, N)) cands.set(p, (cands.get(p) ?? 0) + 1);
  const agreement = keys.length > 1 && cands.size
    ? [...cands.values()].reduce((a, c) => a + (c - 1) / (keys.length - 1), 0) / cands.size : null;
  const tier01 = pool.filter((r) => RELEVANT.has(r.match_type) || r.match_type === 'reference' || r.match_type === 'git').length;
  return {
    sources: keys.length,
    agreement_rate: agreement == null ? null : +agreement.toFixed(4),
    coverage_estimate: pool.length ? +(tier01 / pool.length).toFixed(4) : 0,
    n_pool: pool.length,
  };
}

// --- pipeline principal ---
function runPlan(logicalPlan, rawText, opts = {}) {
  const planT0 = Date.now();
  const fp = useFp() ? repoFp(process.cwd()) : null;
  setFingerprint(fp);
  const stats = { tokens_used: 0, tool_calls: 0, early_terminated: false, cache_hits: 0 };
  const key = `${rawText}|${effectiveBudget(logicalPlan)}`;
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

  const forcePlan = process.env.FORCE_PLAN;
  if (forcePlan) {
    const fp = phys.plans.find((p) => p.id === forcePlan);
    if (fp) {
      phys.selected = fp.id;
      phys.reason = `FORCE_PLAN=${forcePlan}`;
    }
  }
  const selected = phys.plans.find((p) => p.id === phys.selected) ?? phys.plans[0];
  const pool = [];
  // hybrid-retrieval-comparison — CF_RETRIEVAL=bm25 → solo BM25; hybrid → plan + BM25 fusionado
  const retrieval = process.env.CF_RETRIEVAL ?? '';
  // context-query-ir — CF_INDEX=1: access paths materializados (catálogo SQLite)
  // en vez de rg sobre filesystem. Construye el índice una vez por repo si falta.
  const INDEX_MAP = process.env.CF_INDEX === '1' && ['definitions', 'references', 'implementation', 'filename'].includes(logicalPlan.query_type)
    ? { 'search-code': 'lexical-index', 'rg-files': 'lexical-index', 'search-structure': 'dependency-expand' }
    : null;
  if (INDEX_MAP) ensureIndex(process.cwd());
  // AQP v2 — ops léxicas marcadas como saltadas (sin mutar el array en iteración:
  // for..of sobre array mutado desincroniza el iterator y re-ejecuta ops)
  const skippedOps = new Set();

  // 13.1 — ejecución ordenada con early termination
  for (const op of selected.ops) {
    if (retrieval === 'bm25') break; // bm25 puro: no ejecutar ops del plan
    if (op.tool === 'assemble-context') continue;
    if (skippedOps.has(op.tool)) continue;
    stats.tool_calls += 1;
    const t0 = Date.now();
    const effOp = INDEX_MAP && INDEX_MAP[op.tool] ? { ...op, tool: INDEX_MAP[op.tool] } : op;
    const results = execOp(effOp, logicalPlan, pool);
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
    // AQP v2 (adaptive-query-processing, flag-gated): re-optimizar el plan restante
    // a partir del resultado OBSERVADO. Off por defecto (CF_REOPT=1 lo activa).
    // Invariante v2: SOLO ops léxicas (search-code/structure/semantic) son candidatas
    // a skip; git-log/follow/include NUNCA se saltan (git-log = única fuente de
    // queries git; follow/include = D14 semántico). Sin early_terminated: el plan
    // continúa, solo se descartan re-búsquedas redundantes del mismo término.
    if (process.env.CF_REOPT === '1' && !stats.early_terminated) {
      const estC = op.est_candidates ?? 0;
      const actC = results.length;
      const dev = estC > 0 ? Math.abs(estC - actC) / Math.max(estC, 1) : 0;
      const reoptTh = Number(process.env.CF_REOPT_THRESHOLD ?? 0.5);
      const lexical = (o) => ['search-code', 'search-structure', 'search-semantic'].includes(o.tool);
      const under = actC === 0 && estC > 0;
      const over = actC > estC && relevant.length > 0;
      if (dev > reoptTh && (under || over)) {
        const redundant = selected.ops.slice(selected.ops.indexOf(op) + 1).filter((o) => o.tool !== 'assemble-context' && lexical(o));
        if (redundant.length) {
          for (const o of redundant) skippedOps.add(o.tool);
          stats.reoptimized = `lexical-skip (est ${estC} vs actual ${actC})`;
        }
      }
    }
    if (relevant.length > 0 && process.env.CF_DISAGREE_ALL !== '1') {
      // D14 — early termination solo si no quedan ops dependientes (FOLLOW/INCLUDE)
      const pending = selected.ops.slice(selected.ops.indexOf(op) + 1)
        .some((o) => o.tool === 'follow' || o.tool === 'include');
      if (!pending) {
        stats.early_terminated = true; // op satisfizo → no ejecutar el resto
        break;
      }
    }
  }

  // M1 (adversarial-mitigations) — escalación concept con 0 resultados:
  // evidencia exacta primero (filename por palabra + estructural), semántica al final
  if (retrieval !== 'bm25' && logicalPlan.target?.kind === 'concept' && pool.length === 0) {
    const concept = String(logicalPlan.target.name ?? '').trim();
    if (concept) {
      // 1) filename por palabra: 'http handlers' → rg-files 'http' matchea http.py
      const words = String(concept).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3).slice(0, 4);
      for (const w of words) {
        const rows = execOp({ tool: 'rg-files', args: [w] }, logicalPlan, []);
        if (rows.length) {
          pool.push(...rows);
          stats.escalated_filename = w;
          break;
        }
      }
      // 2) estructural (sg): DI containers, decorators, etc.
      if (pool.length === 0) {
        const rows = execOp({ tool: 'search-structure', args: [concept] }, logicalPlan, []);
        if (rows.length) {
          pool.push(...rows);
          stats.escalated_structural = true;
        }
      }
      // 3) semántica como último recurso (probe ausente → degrada sin crash)
      if (pool.length === 0) {
        stats.tool_calls += 1;
        const t0 = Date.now();
        try {
          const semantic = execOp({ tool: 'search-semantic', args: [concept] }, logicalPlan, []);
          const latencyMs = Date.now() - t0;
          pool.push(...semantic);
          stats.escalated_semantic = true;
          recordExecution(logicalPlan.query_type, 'search-semantic', {
            tokens: 800, latency_ms: latencyMs, results: semantic.length,
            relevant: semantic.filter((r) => RELEVANT.has(r.match_type)).length,
            satisfied: semantic.length > 0, cache_hit: false,
          }, phys.pred_class);
        } catch { /* probe ausente o roto — sin crash */ }
      }
    }
  }

  // semantic-structural-operator (CeQe/dc-13) — post-loop: si el pool de un concept
  // NO tiene filas estructurales y es MAYORÍA docs (.md/skills/docs), la implementación
  // estructural no se encontró léxicamente → anclas de framework (@Module, providers:,
  // app.use...) como evidencia estructural (solo implementación, no docs).
  if (logicalPlan.target?.kind === 'concept' && pool.length >= 3) {
    const structuralRows = pool.some((r) => r.match_type === 'structural');
    const docLike = (r) => /\.(md|markdown|rst|txt)$/i.test(r.path) || /(^|\/)(docs?|skills?|rules?|guides?)(\/|$)/i.test(r.path);
    const docs = pool.filter(docLike).length;
    if (!structuralRows && docs / pool.length > 0.5) {
      try {
        const ref = structuralRefine(process.cwd(), Number(process.env.CF_STRUCTURAL_TOP ?? 15));
        if (ref.length) {
          pool.push(...ref);
          stats.structural_refined = ref.length;
        }
      } catch { /* best-effort */ }
    }
  }

  // hybrid-retrieval-comparison — CF_RETRIEVAL: bm25 puro | híbrido (bm25 + plan)
  if (retrieval === 'bm25' || retrieval === 'hybrid') {
    const t0 = Date.now();
    const bmRows = execOp({ tool: 'bm25', args: [logicalPlan.target?.name ?? rawText] }, logicalPlan, pool);
    const seen = new Set(pool.map((r) => r.path));
    for (const r of bmRows) if (!seen.has(r.path)) pool.push(r);
    stats.bm25_rows = bmRows.length;
    stats.bm25_latency_ms = Date.now() - t0;
  }

  // 12.2 — rerank opcional (tinybert-reranker): si hay modelo local, reordena el
  // pool por relevancia (scores) antes de la fusión; null/fallo → orden heurístico.
  // filename = match exacto: el heurístico ya ordena por tiering; el reranker añade ruido → se omite.
  stageSnap('pre_rerank', pool);
  if (modelAvailable() && pool.length > 1 && logicalPlan.query_type !== 'filename') {
    try {
      const t0 = Date.now();
      const rr = rerankSync(pool, logicalPlan.target?.name ?? rawText);
      if (rr?.scores?.length) {
        // reranker-fuse-alignment — el modelo reordena SOLO la cola débil; los
        // matches anclados (exact/filename/structural) conservan evidencia fuerte.
        // Sin anclaje: el modelo puntúa GT exacto con ~0.003 → fuse (score>=0.2) lo elimina.
        const ANCHORED = new Set(['exact', 'filename', 'structural']);
        const scored = pool.map((r, i) => ({ r, s: rr.scores[i] ?? 0 }));
        scored.sort((a, b) => {
          const am = ANCHORED.has(a.r.match_type);
          const bm = ANCHORED.has(b.r.match_type);
          if (am !== bm) return am ? -1 : 1;        // anclados siempre arriba
          if (am && bm) return (b.r.score ?? 0) - (a.r.score ?? 0); // entre anclados: heurístico
          return b.s - a.s;                          // cola débil: score del modelo
        });
        pool.length = 0;
        for (const { r, s } of scored) {
          // 07A evidence model — tier0 determinista SIEMPRE eligible (fuse no filtra por
          // score); tier2+ semántico conserva el score crudo del modelo (belief, se
          // umbraliza por eligibility en fuse, no por floor).
          r.score = ANCHORED.has(r.match_type) ? Math.max(r.score ?? 0, 0.5) : s;
          pool.push(r);
        }
        stats.reranked = true;
        stats.rerank_latency_ms = rr.latencyMs ?? Date.now() - t0;
      }
    } catch { /* fallback heurístico */ }
  }
  stageSnap('post_rerank', pool);

  // plan-variant-confidence — telemetría por plan: success = matches relevantes en
  // el pool final (NO candidates>0); skipBlend → no contamina el blend de cardinalidad
  try {
    record({
      operator: `plan:${phys.selected}`,
      queryClass: logicalPlan.query_type,
      scope: opts.scope ?? '',
      skipBlend: true,
      estimated: {
        candidates: selected.ops.reduce((a, o) => a + (o.est_candidates ?? 0), 0),
        tokens: selected.ops.reduce((a, o) => a + (o.tokens ?? 0), 0),
        latencyMs: selected.ops.reduce((a, o) => a + (o.latency_ms ?? 0), 0),
      },
      actual: {
        candidates: pool.length,
        tokens: stats.tokens_used,
        latencyMs: Date.now() - planT0,
        success: pool.some((r) => RELEVANT.has(r.match_type)) ? 1 : 0,
      },
    });
  } catch { /* telemetría best-effort */ }

  // retriever-disagreement — snapshot por query si CF_DISAGREEMENT_FILE:
  // rank por fuente (lexical/structural/semantic/graph → source/match_type),
  // agreement_rate (Jaccard top-10 entre pares de fuentes), rank_dispersion,
  // margen top1-top2 (fuente dominante) y candidate density — antes de fuse.
  if (process.env.CF_DISAGREEMENT_FILE) {
    try {
      const bySource = {};
      for (const r of pool) {
        const s = r.source ?? r.match_type ?? 'unknown';
        (bySource[s] ??= []).push({ p: r.path, s: r.score ?? 0 });
      }
      // CF_DISAGREE_ALL — incluir bm25 como fuente extra (sin mutar el pool)
      if (process.env.CF_DISAGREE_ALL === '1' && !bySource.bm25) {
        try {
          const bm = execOp({ tool: 'bm25', args: [logicalPlan.target?.name ?? rawText] }, logicalPlan, []);
          if (bm.length) bySource.bm25 = bm.map((r) => ({ p: r.path, s: r.score ?? 0 }));
        } catch { /* best-effort */ }
      }
      const top = (arr) => [...new Map(arr.map((x) => [x.p.replace(/^\.\//, ''), x.s])).entries()].filter(([, s]) => s > 0)
        .sort((a, b) => b[1] - a[1]).slice(0, 3) // top-3: solapamiento significativo, no top-10 (disjuntos por construcción)
        .map(([p, sc]) => ({ p, s: +sc.toFixed(4) }));
      const lists = Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, top(v)]));
      const keys = Object.keys(lists).filter((k) => lists[k].length > 0);
      const N = 5;
      const cands = new Map(); // path → número de fuentes que lo rankean en top-N
      for (const k of keys) for (const { p } of lists[k].slice(0, N)) cands.set(p, (cands.get(p) ?? 0) + 1);
      const nSrc = keys.length;
      // agreement = soporte medio: 1 = todas las fuentes rankean los mismos archivos;
      // 0 = cada fuente tiene candidatos únicos; null si <2 fuentes con candidatos.
      const agreement = nSrc > 1 && cands.size ? [...cands.values()].reduce((a, c) => a + (c - 1) / (nSrc - 1), 0) / cands.size : null;
      const primary = keys.find((k) => /bm25/.test(k)) ?? keys.find((k) => /rg/.test(k)) ?? keys[0];
      const pm = lists[primary] ?? [];
      const margin = pm.length >= 2 ? pm[0].s - pm[1].s : null;
      const poolTokens = pool.reduce((a, r) => a + (r.token_estimate ?? 0), 0);
      const snapshot = {
        ts: Date.now(), query: rawText, query_type: logicalPlan.query_type,
        sources: keys.length,
        agreement_rate: agreement == null ? null : +agreement.toFixed(4),
        top1_top2_margin: margin == null ? null : +margin.toFixed(4),
        candidate_density: +(pool.length / Math.max(1, poolTokens)).toFixed(4),
        n_pool: pool.length, per_source: lists,
      };
      fs.appendFileSync(process.env.CF_DISAGREEMENT_FILE, JSON.stringify(snapshot) + '\n');
    } catch { /* best-effort */ }
  }

  stats.belief = beliefFromPool(pool);

  // adaptive-plan-selection — CF_ADAPTIVE=1: el belief state decide adquisición
  // extra ANTES de fuse (determinista, opt-in).
  // Flood risk: coverage alta + pool grande + agreement bajo → símbolo común
  // inundado por rg (score 1 uniforme, ej. 'main') → symbol-lookup (pins el def).
  // Low agreement: fuentes divergen → bm25 + dependency-expand como adquisición.
  if (process.env.CF_ADAPTIVE === '1') {
    const b = stats.belief;
    const floodCov = Number(process.env.CF_ADAPTIVE_FLOOD_COV ?? 0.85);
    const agreeTh = Number(process.env.CF_ADAPTIVE_AGREE ?? 0.5);
    const actions = [];
    const seenPath = (p) => pool.some((x) => String(x.path) === String(p));
    const flood = b.coverage_estimate > floodCov && b.n_pool > 30 && (b.agreement_rate === null || b.agreement_rate < agreeTh);
    const diverge = b.agreement_rate !== null && b.agreement_rate < agreeTh && !flood;
    if (flood) {
      // NEGATIVO (probado): descartar la fuente inundada rompe correctness (0.839→0.710)
      // — la fuente flood suele CONTENER el GT (logger/env multi-hit); el problema real
      // es el budget consumido por ruido antes del GT (adv-po-30 35k rows). La vía
      // correcta es boost de prioridad de evidencia adquirida en fuse (tarea derivada).
      try {
        const sym = execOp({ tool: 'symbol-lookup', args: [logicalPlan.target?.name ?? rawText] }, logicalPlan, pool);
        for (const r of sym) if (!seenPath(r.path)) pool.push(r);
        actions.push('symbol-lookup');
      } catch { /* best-effort */ }
    }
    if (diverge || flood) {
      if (!pool.some((r) => r.source === 'bm25')) {
        try {
          const bm = execOp({ tool: 'bm25', args: [logicalPlan.target?.name ?? rawText] }, logicalPlan, pool);
          for (const r of bm) if (!seenPath(r.path)) pool.push(r);
          actions.push('bm25');
        } catch { /* best-effort */ }
      }
      if (logicalPlan.target?.kind === 'symbol' || logicalPlan.target?.kind === 'function') {
        try {
          const de = execOp({ tool: 'dependency-expand', args: [logicalPlan.target?.name ?? rawText] }, logicalPlan, pool);
          for (const r of de) if (!seenPath(r.path)) pool.push(r);
          actions.push('dependency-expand');
        } catch { /* best-effort */ }
      }
    }
    stats.adaptive = { flood, actions };
  }

  // evidence-packet-standard — todo row del pool es un packet tipado (aditivo,
  // no rompe el contrato flat de assemble-context; certainty = tipo epistémico).
  const packetOpts = { operator: phys.selected ?? null, target: logicalPlan.target };
  for (let i = 0; i < pool.length; i++) pool[i] = toPacket(pool[i], i, packetOpts);

  // typed-rank-fusion (B1) — CF_RRF=1: reordenar pool por RRF multi-fuente
  // con pesos por query_type; assemble-context respeta .rrf (CF_RRF_RANK).
  if (process.env.CF_RRF === '1' && pool.length > 1) {
    const fused = rrfFuse(pool, logicalPlan.query_type);
    pool.length = 0;
    pool.push(...fused);
    stats.rrf_fused = true;
  }

  let results = fuse(pool, effectiveBudget(logicalPlan));

  // 07B context selection submodular — CF_SELECTOR=marginal|mmr: selección bajo
  // budget duro (engine/selector.js). Off por defecto (fuse legacy).
  if (process.env.CF_SELECTOR === 'marginal' || process.env.CF_SELECTOR === 'mmr') {
    const st0 = Date.now();
    const sel = selectorSelect(results, effectiveBudget(logicalPlan), process.env.CF_SELECTOR);
    stats.selector = process.env.CF_SELECTOR;
    stats.selector_kept = sel.selected.length;
    stats.selector_dropped = results.length - sel.selected.length;
    stats.selector_latency_ms = Date.now() - st0;
    results = sel.selected;
  }

  stats.tokens_used = results.reduce((a, r) => a + (r.token_estimate ?? 0), 0);
  stageSnap('post_fuse', results);

  // abstain-no-answer — CF_ABSTAIN=1: si no hay evidence relevante (exact/filename/
  // structural), no devolver resultados débiles → {abstained:true, reason}.
  // Señal de confianza: conteo de matches con match_type relevante post-fusión.
  if (process.env.CF_ABSTAIN === '1') {
    // abstain-calibration conformal — CF_ABSTAIN_CONFORMAL=1: umbral calibrado θ
    // (split-conformal), strength por match_type; null → lógica binaria legacy.
    if (process.env.CF_ABSTAIN_CONFORMAL === '1') {
      const STRENGTH = { exact: 1, filename: 1, structural: 1, reference: 0.8, git: 0.8, semantic: 0.6, test: 0.4, config: 0.3 };
      const th = Number(process.env.CF_ABSTAIN_THRESHOLD ?? 0.6);
      const maxStr = results.reduce((a, r) => Math.max(a, STRENGTH[r.match_type] ?? 0.5), 0);
      if (maxStr < th) {
        return {
          plan: phys, results: [], cached: false, abstained: true,
          reason: `no-answer: max evidence ${maxStr.toFixed(2)} < θ ${th.toFixed(2)} (conformal)`,
          stats: { ...stats, abstained: true, tokens_used: 0, conformal: { max_strength: maxStr, threshold: th } },
        };
      }
    } else {
      const relevantMatches = results.filter((r) => RELEVANT.has(r.match_type)).length;
      const selectedPlan = phys.plans.find((p) => p.id === phys.selected);
      const hasGitOp = selectedPlan?.ops.some((o) => o.tool === 'git-log') ?? false;
      const gitEvidence = hasGitOp && results.length > 0; // git-log: filas 'git' son evidencia legítima
      if (relevantMatches === 0 && !gitEvidence) {
        return {
          plan: phys, results: [], cached: false, abstained: true,
          reason: `no-answer: 0 relevant matches (${results.length} weak results descartados)`,
          stats: { ...stats, abstained: true, tokens_used: 0 },
        };
      }
    }
  }

  cache.set(key, { results, ts: Date.now(), fp });
  persistCache();

  // claim-level-context (B3) — CF_CLAIMS=1: materializar como claims con spans
  // mínimos (unidad = claim, no archivo); aditivo al pipeline (cache no afectado).
  if (process.env.CF_CLAIMS === '1') {
    const { buildClaims, claimStats } = claimMod;
    const claims = buildClaims(results);
    stats.claims = claimStats(claims);
    results = claims;
  }

  // explorer-solver-separation (FastContext) — CF_EXPLORER=1: el explorador
  // devuelve REFERENCES (path, line range, reason, certainty) + next_actions
  // (operador, target, eig), NO dumps de contenido. Modo headless del solver.
  if (process.env.CF_EXPLORER === '1') {
    try {
      const belief = stats.belief ?? null;
      const name = logicalPlan.target?.name ?? '';
      const actions = [];
      if (belief?.agreement != null && belief.agreement < 0.5) actions.push({ operator: 'symbol-lookup', target: name, eig: 0.7 });
      if (logicalPlan.relations?.length && !results.some((r) => r.match_type === 'reference')) actions.push({ operator: 'follow', target: name, eig: 0.5 });
      if (logicalPlan.inclusions?.length && !results.some((r) => r.match_type === 'test' || r.match_type === 'config')) actions.push({ operator: 'read_span', target: results[0]?.path ?? name, eig: 0.4 });
      if (!actions.length && results.length) actions.push({ operator: 'read_span', target: results[0].path, eig: 0.3 });
      return {
        plan: phys, results, stats, cached: false,
        explorer: {
          evidence: results.map((r) => ({
            path: r.path,
            lines: [r.line_start ?? 1, r.line_end ?? 1],
            reason: `${r.match_type}:${r.source ?? ''}`,
            certainty: r.certainty ?? 0.6,
          })),
          next_actions: actions,
        },
      };
    } catch { /* best-effort — fallback al contrato normal */ }
  }

  // execution-receipts (B4) — CF_RECEIPT=1: receipt {seen, inferred, unknown}
  // + claims (provenance evidencia→claim) — aditivo, cache intacto.
  if (process.env.CF_RECEIPT === '1') {
    const { buildReceipt, receiptStats } = receiptMod;
    try {
      const receipt = buildReceipt({ results, pool, belief: stats.belief ?? null, plan: phys, query: rawText });
      stats.receipt = receiptStats(receipt);
      return { plan: phys, results, stats, cached: false, receipt };
    } catch { /* best-effort — fallback al contrato normal */ }
  }

  return { plan: phys, results, stats, cached: false };
}


function mergeRuns(runs) {
  const results = [];
  const seen = new Set();
  for (const r of runs) for (const x of r.results ?? []) {
    const k = `${x.path}:${x.line_start ?? 0}`;
    if (!seen.has(k)) { seen.add(k); results.push(x); }
  }
  return {
    plan: runs[0].plan,
    results,
    stats: {
      ...runs[0].stats,
      tokens_used: runs.reduce((a, r) => a + (r.stats?.tokens_used ?? 0), 0),
      tool_calls: runs.reduce((a, r) => a + (r.stats?.tool_calls ?? 0), 0),
    },
    cached: false,
  };
}

// cheap-query-bypass — optimizar tiene costo: queries triviales (filename
// inequívoco + repo chico) van directo a rg-files + fuse, sin optimize().
function trivialGate(logicalPlan) {
  if (process.env.CF_BYPASS !== '1') return null;
  const name = String(logicalPlan.target?.name ?? '').trim();
  if (!name || /[\s"'*?\[\](){}|\\]/u.test(name)) return null;
  if (logicalPlan.query_type !== 'filename') return null;
  let files;
  try { files = walkFiles(process.cwd()); } catch { return null; }
  if (files.length > Number(process.env.CF_BYPASS_MAX_FILES ?? 500)) return null;
  return { name, files: files.length };
}

function runBypass(logicalPlan, rawText) {
  const stats = { tokens_used: 0, tool_calls: 0, early_terminated: false, cache_hits: 0, bypassed: true };
  const t0 = Date.now();
  const rows = execOp({ tool: 'rg-files', args: [logicalPlan.target.name] }, logicalPlan, []);
  stats.tool_calls = 1;
  stats.tokens_used = rows.reduce((a, r) => a + (r.token_estimate ?? 0), 0);
  const results = fuse(rows, effectiveBudget(logicalPlan));
  const plan = { selected: 'bypass', plans: [], reason: 'cheap-query-bypass: filename inequívoco, repo chico' };
  return { plan, results, stats, cached: false, bypassed: true, bypass_latency_ms: Date.now() - t0 };
}

export function runCQP(cqpText, opts = {}) {
  // physical-query-decomposition (02): CF_DECOMPOSE=1 → sub-consultas físicas
  // (symbol/callers/impl) ejecutadas por separado y fusionadas sin LLM.
  if (process.env.CF_DECOMPOSE === '1' && !opts._nested) {
    const { facets, sub_queries } = decompose(cqpText);
    if (sub_queries.length > 1) {
      const runs = sub_queries.map((q) => runCQP(q, { ...opts, _nested: true }));
      return { ...mergeRuns(runs), stats: { ...runs[0].stats, tokens_used: mergeRuns(runs).stats.tokens_used, tool_calls: mergeRuns(runs).stats.tool_calls, decomposed: { facets, sub_queries, runs: runs.length } }, plan: runs[0].plan };
    }
  }
  const logicalPlan = parseCQP(cqpText); // lanza Error si input inválido
  if (trivialGate(logicalPlan)) return runBypass(logicalPlan, cqpText);
  const res = runPlan(logicalPlan, cqpText, opts);
  attachIr(res, logicalPlan);
  return res;
}

// context-compilation-ir (B6) — CF_IR=1: adjunta el plan físico IR compilado
// (lowering lógico→físico con access paths y costos) al resultado, sin cambiar
// la ejecución (parity; la selección de implementación por costo es el puente).
function attachIr(res, logicalPlan) {
  if (process.env.CF_IR !== '1' || !res || !res.plan) return;
  try {
    const irPlan = irCompile(logicalPlan, {
      hasCatalog: useFp(),
      relations: logicalPlan.relations ?? [],
      inclusions: logicalPlan.inclusions ?? [],
    });
    res.plan.ir = irPlan;
    res.plan.ir_stats = irStats(irPlan);
  } catch { /* best-effort */ }
}

export function runIntent(intentText, opts = {}) {
  const src = String(intentText ?? '').trim();
  const interp = interpret(src);
  const q = /"([^"]+)"/.exec(src);
  const GENERIC = /^(buscar|find|dónde|donde|está|esta|is|the|file|archivo|carpeta|código|codigo|funcion|función|qué|que|como|cómo|hace|se|usa|usar|usos|referencias|definiciones|symbol|concept)$/i;
  const fallbackName = () => {
    const sw = new Set(['de', 'el', 'la', 'lo', 'los', 'las', 'del', 'un', 'una', 'que', 'y', 'a', 'en', 'se', 'con', 'para']);
    const toks = src.split(/\s+/).filter((t) => !sw.has(t.toLowerCase()) && !GENERIC.test(t));
    return toks[toks.length - 1] || src.slice(0, 60);
  };
  const name = interp.name ?? (q ? q[1] : fallbackName());
  const logicalPlan = {
    query_type: interp.query_type,
    target: { kind: 'symbol', name },
    relations: [], inclusions: [],
    limit: 20, budget: 8000,
    confidence: interp.confidence,
    raw: src,
  };
  if (process.env.CF_DECOMPOSE === '1' && !opts._nested) {
    const { facets, sub_queries } = decompose(src, name, [logicalPlan.query_type]);
    if (sub_queries.length > 1) {
      const runs = [runPlan(logicalPlan, src, opts)]; // original: intent (no CQP)
      for (const q of sub_queries.slice(1)) runs.push(runCQP(q, { ...opts, _nested: true }));
      return { ...mergeRuns(runs), stats: { ...mergeRuns(runs).stats, decomposed: { facets, sub_queries, runs: runs.length } } };
    }
  }
  if (trivialGate(logicalPlan)) return runBypass(logicalPlan, src);
  const res = runPlan(logicalPlan, src, opts);
  attachIr(res, logicalPlan);
  return res;
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
