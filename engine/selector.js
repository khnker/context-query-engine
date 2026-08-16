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

export function select(rows, budget = BUDGET) {
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

  for (const { r } of scored) {
    const t = r.token_estimate ?? 10;
    if (used + t > budget) continue;
    selected.push(r);
    used += t;
    selectedTiers.add(r.evidence_tier ?? 3);
    selectedDirs.add(path.dirname(r.path ?? '/'));
    selectedScores.push(r.score_final ?? 0.5);
  }
  return { selected, used };
}

export function applySelector(inputLines, budget = BUDGET) {
  const rows = inputLines
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean)
    .map((r) => ({ ...r, score_final: r.score_final ?? r.score ?? 0.5, evidence_tier: r.evidence_tier ?? (r.match_type === 'semantic' ? 2 : (r.match_type === 'test' || r.match_type === 'config' ? 3 : 0)) }));
  const { selected, used } = select(rows, budget);
  const stats = JSON.stringify({ budget, tokens_used: used, kept: selected.length, selector: 'marginal', dropped: rows.length - selected.length });
  const lines = selected.map((r) => JSON.stringify(r));
  return { stats, lines };
}

// CLI: node engine/selector.js [BUDGET] < ranked.ndjson
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;