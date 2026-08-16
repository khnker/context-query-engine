#!/usr/bin/env node
/**
 * engine/receipt.js — Execution Receipts (B4): separa evidencia determinista
 * (seen), inferida (inferred) y desconocida (unknown), y traza la cadena
 * evidencia→claim→acción→outcome con provenance (evidence_id).
 */
export const TIER0 = new Set(['exact', 'filename', 'structural']);

export function buildReceipt({ results = [], pool = [], belief = null, plan = null, query = '' } = {}) {
  const seen = [];
  const inferred = [];
  for (const r of results) {
    const rec = {
      evidence_id: r.evidence_id ?? null,
      path: r.path,
      lines: [r.line_start ?? 1, r.line_end ?? r.line_start ?? 1],
      match_type: r.match_type ?? null,
      certainty: r.certainty ?? (TIER0.has(r.match_type) ? 1.0 : 0.6),
      source: r.source ?? null,
      cost_tokens: r.token_estimate ?? 0,
    };
    (TIER0.has(r.match_type) ? seen : inferred).push(rec);
  }
  const unknown = [];
  if (!results.length) unknown.push('no-candidates');
  else if (belief && belief.agreement_rate == null && belief.sources != null && belief.sources < 2) unknown.push('single-source');
  else if (belief && belief.agreement_rate != null && belief.agreement_rate < 0.5) unknown.push('low-agreement');
  const claimMap = new Map();
  for (const r of results) {
    const k = `${r.path}:${r.line_start ?? 1}:${r.line_end ?? r.line_start ?? 1}`;
    if (!claimMap.has(k)) claimMap.set(k, []);
    claimMap.get(k).push(r.evidence_id ?? null);
  }
  return {
    ts: Date.now(),
    query,
    plan: plan ? { id: plan.selected ?? null, reason: plan.reason ?? null } : null,
    seen, inferred, unknown,
    evidence_used: seen.length + inferred.length,
    files_touched: [], // post-acción: el agente anota los archivos que editó
    tests_run: [],     // post-acción: el agente anota los tests ejecutados
    claims: [...claimMap.entries()].map(([k, ids]) => ({ span: k, evidence_ids: ids })),
  };
}

export function receiptStats(receipt) {
  return {
    seen: receipt.seen.length,
    inferred: receipt.inferred.length,
    unknown: receipt.unknown,
    evidence_used: receipt.evidence_used,
    claims: receipt.claims.length,
  };
}