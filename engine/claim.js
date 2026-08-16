#!/usr/bin/env node
/**
 * engine/claim.js — Claim-Level Context (B3): la unidad es el claim, no el archivo.
 * Cada resultado materializado con span se convierte en un claim
 * {claim_id, subject, text, evidence:[{path, lines}], evidence_type, certainty,
 * source, cost{latency_ms, tokens}} — spans mínimos, nunca archivos completos.
 */
let seq = 0;

export function buildClaims(results) {
  const seen = new Set();
  const claims = [];
  for (const r of results) {
    const ls = Number(r.line_start ?? 1);
    const le = Math.max(ls, Number(r.line_end ?? ls));
    const key = `${r.path}|${ls}|${le}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const spanLines = le - ls + 1;
    seq += 1;
    claims.push({
      claim_id: `c${seq}`,
      subject: r.path,
      text: typeof r.content === 'string' ? r.content.slice(0, 240) : '',
      evidence: [{ path: r.path, lines: [ls, le] }],
      evidence_type: r.match_type ?? 'semantic',
      certainty: r.certainty ?? (r.match_type === 'exact' || r.match_type === 'filename' || r.match_type === 'structural' ? 1.0 : 0.6),
      source: r.source ?? 'unknown',
      cost: { latency_ms: 0, tokens: spanLines * 5 },
    });
  }
  return claims;
}

export function claimStats(claims) {
  const spanTokens = claims.reduce((a, c) => a + c.cost.tokens, 0);
  const byType = {};
  for (const c of claims) byType[c.evidence_type] = (byType[c.evidence_type] ?? 0) + 1;
  return { claims: claims.length, span_tokens: spanTokens, by_type: byType };
}