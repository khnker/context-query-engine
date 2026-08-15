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

import { spawn } from 'node:child_process';

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

export default { CAPACITIES, available, run };

// --- CLI (diagnóstico) ---
import { pathToFileURL } from 'node:url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [task = 'classify-query', payload = '{}'] = process.argv.slice(2);
  const out = await run(task, JSON.parse(payload));
  process.stdout.write(JSON.stringify({ available: available(), result: out }) + '\n');
}
