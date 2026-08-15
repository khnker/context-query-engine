#!/usr/bin/env node
/**
 * engine/local-model.js — Interfaz estable para modelo local opcional (Phase 10).
 * TinyBERT (fases 11-13) se conecta aquí: classification, reranking, relevance,
 * embedding, cardinality. Sin modelo configurado → run() devuelve null y el
 * optimizer opera 100% heurístico. Nunca bloquea el hot path (timeout duro).
 * Node.js ESM, stdlib SOLO.
 *
 * Config: CF_MODEL_CMD="<bin> [args...]" → se invoca: <bin> <task> '<payload-json>'
 * Salida esperada del binario: JSON con scores/features (JSON.stringify en stdout).
 */

import { spawn, execFileSync } from 'node:child_process';

// Capacidades soportadas por la interfaz (se sirven via run()).
export const CAPACITIES = ['classification', 'reranking', 'relevance', 'embedding', 'cardinality'];

const MODEL_TIMEOUT_MS = 2000;

// Hay un modelo configurable vía CF_MODEL_CMD.
export function available() {
  return Boolean(process.env.CF_MODEL_CMD);
}

/**
 * run(task, payload) → Promise<{scores?, features?, latencyMs} | null>
 * task: 'classify-query' | 'rerank' | 'estimate-cardinality' | ...
 * null ⇒ modelo ausente o fallo → el caller usa el fallback heurístico.
 */
export async function run(task, payload = {}) {
  const cmd = process.env.CF_MODEL_CMD;
  if (!cmd) return null;

  const t0 = Date.now();
  const [bin, ...args] = cmd.split(/\s+/);
  return new Promise((resolve) => {
    const child = spawn(bin, [...args, task, JSON.stringify(payload)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MODEL_TIMEOUT_MS,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));           // binario ausente/permiso → fallback
    child.on('timeout', () => { child.kill(); resolve(null); });
    child.on('close', () => {
      if (!out.trim()) return resolve(null);
      try {
        resolve({ ...JSON.parse(out), latencyMs: Date.now() - t0 });
      } catch {
        resolve(null);                                 // salida corrupta → fallback
      }
    });
  });
}

function sanitizeScores(raw, n) {
  return Array.from({ length: n }, (_, i) => {
    const s = Number(raw?.[i]);
    return Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0;
  });
}

function rerankPayload(results, query) {
  return {
    query,
    results: results.map((r) => (r?.content ?? r?.snippet ?? r?.path ?? '').slice(0, 400)),
  };
}

/**
 * rerank(results, query) — contrato del task 'rerank' (fase 12).
 * Envía los results al modelo y devuelve {scores[], latencyMs} alineado a results
 * (0..1 por result, rellena con 0 si el modelo devuelve menos). null ⇒ sin modelo
 * o salida inválida → el caller mantiene el orden heurístico.
 */
export async function rerank(results, query = '') {
  if (!Array.isArray(results) || results.length === 0) return { scores: [], latencyMs: 0 };
  const out = await run('rerank', rerankPayload(results, query));
  if (!out || !Array.isArray(out.scores)) return null;
  return { scores: sanitizeScores(out.scores, results.length), latencyMs: out.latencyMs ?? 0 };
}

/**
 * rerankSync(results, query) — variante síncrona para el execution engine
 * (engine.js es 100% sync: execFileSync). Mismo contrato; timeout duro interno.
 */
export function rerankSync(results, query = '') {
  if (!Array.isArray(results) || results.length === 0) return { scores: [], latencyMs: 0 };
  const cmd = process.env.CF_MODEL_CMD;
  if (!cmd) return null;
  const [bin, ...args] = cmd.split(/\s+/);
  const t0 = Date.now();
  let raw;
  try {
    raw = execFileSync(bin, [...args, 'rerank', JSON.stringify(rerankPayload(results, query))], {
      encoding: 'utf8',
      timeout: MODEL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // binario ausente / timeout / error → fallback heurístico
  }
  if (!raw || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // salida corrupta → fallback
  }
  if (!Array.isArray(parsed.scores)) return null;
  return { scores: sanitizeScores(parsed.scores, results.length), latencyMs: Date.now() - t0 };
}

export default { CAPACITIES, available, run, rerank, rerankSync };

// --- CLI (diagnóstico) ---
import { pathToFileURL } from 'node:url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [task = 'classify-query', payload = '{}'] = process.argv.slice(2);
  const out = await run(task, JSON.parse(payload));
  process.stdout.write(JSON.stringify({ available: available(), result: out }) + '\n');
}
