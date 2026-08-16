#!/usr/bin/env node
/**
 * engine/voi.js — Information Acquisition (VoI) (change information-acquisition-voi).
 * VoI(op) = P(nuevo evidence | op, qc) · utility_marginal − cost(op).
 * - P_new: successRate aprendido por (tool|queryClass) desde statistics (n≥5),
 *   fallback 0.7 sin evidencia.
 * - utility_marginal: relevance del op (espejo COST_TABLE) × VALUE (env CF_VOI_VALUE, default 100).
 * - cost: tokens·WT + latency·WL (env CF_VOI_WT/WL, defaults 0.02/0.001).
 * - Ordena las ops del plan por VoI desc y PODA las de VoI ≤ 0 (abstención por VoI).
 * Node.js ESM, stdlib SOLO.
 */
const RELEVANCE = {
  'search-code': 0.8, 'search-structure': 0.9, 'search-semantic': 0.7,
  'assemble-context': 0.5, 'rg-files': 0.85, follow: 0.6, include: 0.4,
  'git-log': 0.6, bm25: 0.45, 'symbol-lookup': 0.9, 'lexical-index': 0.85,
  'dependency-expand': 0.8, 'read-span': 0.5,
};
const COST = {
  'search-code': { tokens: 200, latency_ms: 15 }, 'search-structure': { tokens: 300, latency_ms: 20 },
  'search-semantic': { tokens: 800, latency_ms: 150 }, 'assemble-context': { tokens: 50, latency_ms: 5 },
  'rg-files': { tokens: 100, latency_ms: 10 }, follow: { tokens: 300, latency_ms: 25 },
  include: { tokens: 200, latency_ms: 20 }, 'git-log': { tokens: 300, latency_ms: 150 },
  bm25: { tokens: 120, latency_ms: 60 }, 'symbol-lookup': { tokens: 40, latency_ms: 2 },
  'lexical-index': { tokens: 60, latency_ms: 5 }, 'dependency-expand': { tokens: 80, latency_ms: 4 },
  'read-span': { tokens: 40, latency_ms: 2 },
};

export function voiConfig() {
  return {
    value: Number(process.env.CF_VOI_VALUE ?? 100),
    wt: Number(process.env.CF_VOI_WT ?? 0.02),
    wl: Number(process.env.CF_VOI_WL ?? 0.001),
  };
}

/** VoI por op; stats = Map load() de statistics.js (successRate por tool|qc). */
export function opVoI(op, queryType, stats, cfg) {
  const key = `${op.tool}|${queryType}`;
  const e = stats?.get?.(key);
  const pNew = e && e.n >= 5 ? Math.max(0.1, Math.min(0.99, e.successRate || 0.5)) : 0.7;
  const rel = RELEVANCE[op.tool] ?? 0.5;
  const c = COST[op.tool] ?? { tokens: 100, latency_ms: 10 };
  return pNew * rel * cfg.value - c.tokens * cfg.wt - c.latency_ms * cfg.wl;
}

/** Ordena las ops por VoI desc y poda las de VoI ≤ 0 (abstención). */
export function orderByVoI(ops, queryType, stats, cfg) {
  const scored = ops
    .map((op) => ({ op, voi: op.tool === 'assemble-context' ? Infinity : opVoI(op, queryType, stats, cfg) }))
    .sort((a, b) => b.voi - a.voi);
  const kept = scored.filter((s) => s.voi > 0);
  return {
    ordered: kept.map((s) => s.op),
    pruned: scored.filter((s) => s.voi <= 0).map((s) => ({ tool: s.op.tool, voi: +s.voi.toFixed(2) })),
    voi_by_op: Object.fromEntries(scored.map((s) => [s.op.tool, +s.voi.toFixed(2)])),
  };
}