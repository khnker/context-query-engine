#!/usr/bin/env node
/**
 * engine/rrf.js — Typed Rank Fusion (RRF) con pesos por query-type (B1).
 * Cada fuente (rg, rg-files, bm25, structural, git-log, index ops) aporta un
 * ranking; la fusión combina por RRF: score(path) = Σ_tier w_tier·1/(k+rank).
 * Las señales NO comparten escala → se fusiona por rango, no por score.
 * Evidence tiers espejo de assemble-context (0 exact/filename/structural,
 * 1 reference/git, 2 semantic, 3 test/config/otro).
 */
const K = 60;

function tierOf(matchType) {
  if (['exact', 'filename', 'structural'].includes(matchType)) return 0;
  if (['reference', 'git'].includes(matchType)) return 1;
  if (['semantic'].includes(matchType)) return 2;
  return 3;
}

// pesos por evidence_tier, dependientes del query_type (B1.2)
const QTYPE_WEIGHTS = {
  definitions: [1.0, 0.6, 0.4, 0.3],
  references: [0.9, 1.0, 0.6, 0.4],
  implementation: [0.7, 0.9, 0.8, 0.5],
  filename: [1.0, 0.5, 0.3, 0.3],
  concept: [0.5, 0.6, 1.0, 0.6],
  pattern: [0.6, 0.7, 0.9, 0.7],
  default: [0.8, 0.8, 0.8, 0.6],
};

export function rrfFuse(pool, queryType) {
  const bySource = {};
  for (const r of pool) {
    const s = r.source ?? r.match_type ?? 'unknown';
    (bySource[s] ??= []).push(r);
  }
  for (const arr of Object.values(bySource)) arr.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const w = QTYPE_WEIGHTS[queryType] ?? QTYPE_WEIGHTS.default;
  const acc = new Map(); // path → { n, row }
  for (const [src, arr] of Object.entries(bySource)) {
    const tier = arr.length ? tierOf(arr[0].match_type) : 3;
    const wt = w[tier] ?? 0.5;
    arr.forEach((r, i) => {
      const p = String(r.path ?? '');
      if (!p) return;
      const cur = acc.get(p) ?? { n: 0, row: r };
      cur.n += wt / (K + i + 1);
      acc.set(p, cur);
    });
  }
  return [...acc.values()]
    .map(({ n, row }) => ({ ...row, rrf: +n.toFixed(6) }))
    .sort((a, b) => b.rrf - a.rrf);
}