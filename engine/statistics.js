#!/usr/bin/env node
/**
 * engine/statistics.js — Aprendizaje por confianza (change optimizer-statistics).
 * Registra ejecuciones reales (estimated vs actual) en NDJSON y produce agregados
 * usados por el optimizer para estimar cardinalidad y reordenar tools.
 * Node.js ESM, stdlib SOLO.
 *
 * CLI:
 *   node engine/statistics.js --record '<json>'  → append + exit 0
 *   node engine/statistics.js --learned          → agregado JSON (keys con n>0)
 *
 * Archivo de stats: engine/statistics.ndjson (override con env CF_STATS_FILE).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGINE_DIR = fileURLToPath(new URL('.', import.meta.url));
const STATS_FILE = process.env.CF_STATS_FILE || path.join(ENGINE_DIR, 'statistics.ndjson');

// Cardinalidad default por clase de query (D13) — usada cuando no hay datos (n=0).
export const DEFAULTS = {
  identifier: 5,
  filename: 3,
  pattern: 20,
  concept: 100,
  symbol: 15,
  repo_map: 1,
};

// obs = { operator, queryClass, scope, estimated:{candidates,tokens,latencyMs}, actual:{candidates,tokens,latencyMs} }
let _fp = null;
export function setFingerprint(fp) { _fp = fp; }

export function record(obs) {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  const line = { ts: new Date().toISOString(), ...(_fp ? { repo_fp: _fp } : {}), ...obs };
  fs.appendFileSync(STATS_FILE, JSON.stringify(line) + '\n');
  return line;
}

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

/**
 * Lee el NDJSON y agrega por clave `operator|queryClass` (y `operator|queryClass|scope`
 * si el record trae scope). Además agrega por `queryClass` plano: estimateCandidates
 * recibe solo (queryClass, scope, stats) y necesita una entrada agregada sin operador
 * para hacer el blend de cardinalidad.
 * Los registros se ponderan por recencia (decay exponencial, τ=7d): stats viejas
 * pesan menos → el cost model se adapta a la evolución del repo (change adaptive-optimizer).
 * Retorna Map key → {n, avgCandidates, p95Tokens, avgLatencyMs, successRate, avgEstCandidates}.
 */
export function load() {
  const map = new Map();
  let lines = [];
  try {
    lines = fs.readFileSync(STATS_FILE, 'utf8').split('\n').filter(Boolean);
  } catch { /* sin archivo → stats vacías */ }

  const ensure = (key) => {
    let e = map.get(key);
    if (!e) {
      e = { n: 0, avgCandidates: 0, p95Tokens: 0, avgLatencyMs: 0, successRate: 0, avgEstCandidates: 0, _tokens: [], _w: 0, _wCand: 0, _wLat: 0, _wEst: 0, _wSuccess: 0 };
      map.set(key, e);
    }
    return e;
  };

  const now = Date.now();
  const DECAY_DAYS = 7;
  const weightFor = (o) => {
    const ts = Date.parse(o?.ts ?? '');
    if (!Number.isFinite(ts)) return 1;
    const days = (now - ts) / 86400000;
    // registros de la misma sesión (< 1h) no decaen: peso 1 exacto (evita drift de ms)
    if (days <= 1 / 24) return 1;
    return Math.exp(-days / DECAY_DAYS);
  };
  const accumulate = (e, o, cand, tokens, latency, estCand, successFlag) => {
    const w = weightFor(o);
    e.n += 1;
    e._w += w;
    e._wCand += cand * w;
    e._wLat += latency * w;
    e._wEst += estCand * w;
    e._tokens.push(tokens);
    if (successFlag !== undefined) e._wSuccess += w * (successFlag ? 1 : 0);
    else if (cand > 0) e._wSuccess += w;
  };

  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const { operator, queryClass, scope } = o;
    if (!operator || !queryClass) continue;
    const actual = o.actual ?? {};
    const estimated = o.estimated ?? {};
    const cand = Number(actual.candidates) || 0;
    const tokens = Number(actual.tokens) || 0;
    const latency = Number(actual.latencyMs) || 0;
    const estCand = Number(estimated.candidates) || 0;
    const successFlag = actual.success; // plan-variant: success explícito (relevant encontrado)
    accumulate(ensure(`${operator}|${queryClass}`), o, cand, tokens, latency, estCand, successFlag);
    if (!o.skipBlend) { // plan:<id> no entra al blend plano de queryClass (contamina cardinalidad)
      accumulate(ensure(queryClass), o, cand, tokens, latency, estCand, successFlag);
    }
    if (scope) {
      accumulate(ensure(`${operator}|${queryClass}|${scope}`), o, cand, tokens, latency, estCand, successFlag);
    }
  }

  for (const e of map.values()) {
    e.avgCandidates = e._w ? e._wCand / e._w : 0;
    e.avgLatencyMs = e._w ? e._wLat / e._w : 0;
    e.avgEstCandidates = e._w ? e._wEst / e._w : 0;
    e.p95Tokens = p95(e._tokens);
    // p50 (mediana) y varianza de tokens reales — distingue "sé" de "creo" (review 06)
    const sorted = [...e._tokens].sort((a, b) => a - b);
    e.p50Tokens = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const mu = e._tokens.length ? e._tokens.reduce((a, b) => a + b, 0) / e._tokens.length : 0;
    e.varianceTokens = e._tokens.length ? e._tokens.reduce((a, b) => a + (b - mu) ** 2, 0) / e._tokens.length : 0;
    e.successRate = e._w ? e._wSuccess / e._w : 0;
    delete e._tokens;
    delete e._w;
    delete e._wCand;
    delete e._wLat;
    delete e._wEst;
    delete e._wSuccess;
  }
  return map;
}

// n<5 → 0.3, 5<=n<=20 → 0.6, n>20 → 0.9
export function confidence(n) {
  if (n < 5) return 0.3;
  if (n <= 20) return 0.6;
  return 0.9;
}

// Blend: con datos → avgCandidates*c + DEFAULT*(1-c); sin datos → DEFAULT.
// Si se pasa operator, prefiere la clave `operator|queryClass` (cardinalidad por
// operador, change cardinality-estimation) y cae a `queryClass` si no hay datos.
export function estimateCandidates(queryClass, scope, stats = new Map(), operator) {
  const d = DEFAULTS[queryClass] ?? 15;
  const keys = operator ? [`${operator}|${queryClass}`, queryClass] : [queryClass];
  for (const k of keys) {
    const entry = stats.get(k);
    if (entry && entry.n > 0) {
      const c = confidence(entry.n);
      return Math.round(entry.avgCandidates * c + d * (1 - c));
    }
  }
  return d;
}

// --- CLI ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--record') {
      const obs = JSON.parse(args[1] ?? '{}');
      record(obs);
      process.stdout.write(JSON.stringify({ ok: true, recorded: obs }) + '\n');
      process.exit(0);
    }
    if (args[0] === '--learned') {
      const out = {};
      for (const [k, v] of load()) {
        if (v.n > 0) {
          out[k] = {
            n: v.n,
            avgCandidates: v.avgCandidates,
            p50Tokens: v.p50Tokens,
            p95Tokens: v.p95Tokens,
            varianceTokens: v.varianceTokens,
            avgLatencyMs: v.avgLatencyMs,
            successRate: v.successRate,
            avgEstCandidates: v.avgEstCandidates,
            confidence: confidence(v.n),
          };
        }
      }
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      process.exit(0);
    }
    throw new Error('uso: node engine/statistics.js --record <json> | --learned');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(1);
  }
}
