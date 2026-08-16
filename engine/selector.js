#!/usr/bin/env node
/**
 * engine/selector.js — Budgeted Context Selection submodular (07B).
 * Tras fusión (asemble-context provee ranking score_final), esta etapa elige el
 * subconjunto S que maximiza utilidad de información bajo budget duro de tokens:
 *
 *   U(S) = Σ marginal_gain(cand | S)
 *   marginal_gain = relevancia (score_final) · tier_bonus
 *                 + cobertura de evidencia (primer tier0/tier1 no duplicado)
 *                 + diversidad (novedad de directorio vs seleccionados)
 *                 − redundancia (path-vecino con score_final similar ya en S)
 *                 − token_cost
 *
 * Restricción dura: Σ tokens(S) ≤ BUDGET. Greedy: en cada paso el candidato de
 * mayor ganancia marginal se añade si cabe en el presupuesto restante (sin
 * cortar a la mitad — el parche de truncación ya se descartó en
 * adversarial-mitigations por regresión en dc-14/mo-26).
 *
 * Activo con CF_SELECTOR=marginal (default: fuse legacy, sin cambios).
 * Node.js ESM, stdlib SOLO. Entrada: NDJSON ranked (fuse), salida: NDJSON seleccionado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CF_SELECTOR = process.env.CF_SELECTOR ?? '';
const BUDGET = Number(process.env.CF_SELECTOR_BUDGET ?? 8000);
const W_DIVERSITY = Number(process.env.CF_SELECTOR_WDIV ?? 0.15);

const TIER_BONUS = [0.2, 0.1, 0, 0];
const SCORE_FLOOR = 0.2;
const LAMBDA = Number(process.env.CF_SELECTOR_LAMBDA ?? 0.7);

// sameRegion (mismo dirname → 1; prefijo compartido ≥1 → 0.5) — mismo esquema que
// la simulación offline de eval-context-selection.js (MMR λ=0.7 ganó +14% gt @400).
function sameRegion(a, b) {
  const da = path.dirname(String(a.path ?? '').replace(/^\.\//, ''));
  const db = path.dirname(String(b.path ?? '').replace(/^\.\//, ''));
  if (da === db) return 1;
  const pa = da.split('/'), pb = db.split('/');
  let shared = 0;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] === pb[i]) shared++; else break;
  return shared >= 1 ? 0.5 : 0;
}

export function selectMMR(rows, budget = BUDGET) {
  const selected = [];
  const scores = rows.map((r) => r.score_final ?? 0.5);
  let used = 0;
  const pool = rows.map((r, i) => ({ r, i })).filter(({ r }) => (r.token_estimate ?? 10) <= budget);
  while (pool.length && used < budget) {
    let best = -1, bestVal = -Infinity;
    for (let j = 0; j < pool.length; j++) {
      const { r, i } = pool[j];
      let maxSim = 0;
      for (const s of selected) {
        const sim = sameRegion(r, s);
        if (sim > maxSim) maxSim = sim;
      }
      const val = LAMBDA * (scores[i] ?? 0.5) - (1 - LAMBDA) * maxSim;
      if (val > bestVal) { bestVal = val; best = j; }
    }
    if (best < 0) break;
    const { r } = pool[best];
    const t = r.token_estimate ?? 10;
    if (used + t > budget) { pool.splice(best, 1); continue; }
    selected.push(r);
    used += t;
    pool.splice(best, 1);
  }
  return { selected, used };
}

export function select(rows, budget = BUDGET, mode = 'marginal', adaptiveTheta = null) {
  if (mode === 'mmr') return selectMMR(rows, budget);
  const selected = [];
  const selectedTiers = new Set();
  const selectedDirs = new Set();
  const selectedScores = [];
  let used = 0;

  const marginalGain = (row) => {
    const base = (row.score_final ?? 0.5) + TIER_BONUS[row.evidence_tier ?? 3];
    const evidenceGain = row.evidence_tier <= 1 && !selectedTiers.has(row.evidence_tier) ? 0.15 : 0;
    const dir = path.dirname(String(row.path ?? '/').replace(/^\.\//, ''));
    const diveGain = !selectedDirs.has(dir) ? W_DIVERSITY : 0;
    let redundancy = 0;
    for (const s of selectedScores) {
      const d = Math.abs(s - (row.score_final ?? 0.5));
      if (d < 0.02) redundancy += 0.1;
    }
    const tokCost = (row.token_estimate ?? 10) / 400;
    return base + evidenceGain + diveGain - redundancy - tokCost;
  };

  const scored = rows.map((r) => ({ r, gain: marginalGain(r) }));
  scored.sort((a, b) => b.gain - a.gain);
  const knee = adaptiveTheta != null && scored.length ? scored[0].gain * adaptiveTheta : -Infinity;

  for (const { r, gain } of scored) {
    // adaptive-k: parada por diminishing returns (knee de la curva de marginal gain)
    if (gain < knee) break;
    const t = r.token_estimate ?? 10;
    if (used + t > budget) continue;
    selected.push(r);
    used += t;
    selectedTiers.add(r.evidence_tier ?? 3);
    selectedDirs.add(path.dirname(r.path ?? '/'));
    selectedScores.push(r.score_final ?? 0.5);
  }
  return { selected, used, adaptive_k: adaptiveTheta != null ? selected.length : null };
}

export function applySelector(inputLines, budget = BUDGET, mode = process.env.CF_SELECTOR ?? 'marginal') {
  const rows = inputLines
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean)
    .map((r) => ({ ...r, score_final: r.score_final ?? r.score ?? 0.5, evidence_tier: r.evidence_tier ?? (r.match_type === 'semantic' ? 2 : (r.match_type === 'test' || r.match_type === 'config' ? 3 : 0)) }));
  // B2 adaptive-k: parada por diminishing returns (CF_ADAPTIVE_K=1, θ=CF_ADAPTIVE_K_THETA 0.10)
  const adaptiveTheta = process.env.CF_ADAPTIVE_K === '1'
    ? Number(process.env.CF_ADAPTIVE_K_THETA ?? 0.10) : null;
  const { selected, used, adaptive_k } = select(rows, budget, mode, adaptiveTheta);
  const stats = JSON.stringify({ budget, tokens_used: used, kept: selected.length, selector: mode, adaptive_k, dropped: rows.length - selected.length });
  const lines = selected.map((r) => JSON.stringify(r));
  return { stats, lines };
}

// CLI: node engine/selector.js [BUDGET] < ranked.ndjson
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;