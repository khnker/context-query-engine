#!/usr/bin/env node
/**
 * engine/evidence.js — Evidence Packet Standard (change evidence-packet-standard).
 * Cada resultado de retrieval es un packet tipado:
 *   {evidence_id, subject:{file, symbol, lines:{start,end}}, claim,
 *    evidence_type, certainty, source, provenance:{operator, parser, index_version},
 *    cost:{tokens, latency_ms}}
 * Aditivo: conserva los campos flat (path/match_type/score/token_estimate/source)
 * que consume assemble-context jq y los selectores — la migración no rompe el contrato.
 * certainty = tipo epistémico: determinista (tier0) vs estimación probabilística.
 */
const CERTAINTY = {
  exact: 1.0, filename: 1.0, structural: 1.0,
  reference: 0.8, git: 0.8,
  semantic: 0.6, bm25: 0.6,
  test: 0.4, config: 0.3,
};

export function certaintyOf(matchType) {
  return CERTAINTY[matchType] ?? 0.5;
}

export function toPacket(row, i, opts = {}) {
  if (row.evidence_id) return row; // ya es packet (idempotente)
  const { operator = row.source ?? 'unknown', parser = null, index_version = null, target = null, query = null } = opts;
  const certainty = certaintyOf(row.match_type);
  const tier = row.evidence_tier ?? (row.match_type === 'semantic' ? 2 : (row.match_type === 'test' || row.match_type === 'config' ? 3 : 0));
  const det = certainty === 1.0;
  return {
    ...row,
    evidence_id: `${operator}:${row.path}:${row.line_start ?? 1}:${i}`,
    subject: {
      file: row.path,
      symbol: target?.name ?? null,
      lines: row.line_start ? { start: row.line_start, end: row.line_end ?? row.line_start } : null,
    },
    claim: `${operator} reporta ${row.match_type} en ${row.path}`,
    evidence_type: row.match_type,
    certainty,
    // Score<T> (B13): namespaces separados — evidence (determinista) vs estimate
    // (probabilístico). El flat `score` se conserva solo como compat legacy
    // (assemble-context jq y selectores lo leen); score_t es el modelo tipado.
    score_t: {
      evidence: det ? (row.score ?? certainty) : null,
      estimate: det ? null : (row.score ?? null),
    },
    evidence_tier: tier,
    provenance: { operator, parser, index_version, query, tier },
    cost: { tokens: row.token_estimate ?? 8, latency_ms: 0 },
  };
}

export function packetStats(rows) {
  const byType = {};
  const byCertainty = {};
  for (const r of rows) {
    const t = r.evidence_type ?? r.match_type ?? 'unknown';
    byType[t] = (byType[t] ?? 0) + 1;
    const c = r.certainty;
    const bucket = c >= 0.95 ? 'deterministic' : c >= 0.6 ? 'strong' : 'weak';
    byCertainty[bucket] = (byCertainty[bucket] ?? 0) + 1;
  }
  return { by_type: byType, by_certainty: byCertainty };
}