#!/usr/bin/env node
/**
 * engine/ir.js — Context Compilation IR (B6).
 * Lowering CQP lógico → plan físico de operadores IR (estilo SQL):
 *   SCAN / SYMBOL_LOOKUP / LEXICAL_LOOKUP / DEPENDENCY_EXPAND / CALLER_EXPAND /
 *   SEMANTIC_SEARCH / HISTORY_LOOKUP / TEST_LOOKUP / READ_SPAN / MERGE / DEDUP.
 * Cada operador tiene una implementación física (impl tool del engine) y un
 * costo estimado {tokens, latency_ms}; access_path = index | disk según haya
 * catálogo (index-layer). La selección de implementación es cost-based.
 */
// IR operator → implementación física + costos (espejo de COST_TABLE del engine)
export const IR_OPERATORS = {
  SCAN:               { impl: 'rg-files',          tokens: 100, latency_ms: 10,  evidence_type: 'filename', access_path: 'disk' },
  LEXICAL_LOOKUP:     { impl: 'lexical-index',     tokens: 60,  latency_ms: 5,   evidence_type: 'exact',    access_path: 'index' },
  SYMBOL_LOOKUP:      { impl: 'symbol-lookup',     tokens: 40,  latency_ms: 2,   evidence_type: 'structural', access_path: 'index' },
  DEPENDENCY_EXPAND:  { impl: 'dependency-expand', tokens: 80,  latency_ms: 4,   evidence_type: 'reference', access_path: 'index' },
  CALLER_EXPAND:      { impl: 'search-structure',  tokens: 300, latency_ms: 20,  evidence_type: 'structural', access_path: 'disk' },
  SEMANTIC_SEARCH:    { impl: 'bm25',              tokens: 120, latency_ms: 60,  evidence_type: 'semantic',  access_path: 'index' },
  HISTORY_LOOKUP:     { impl: 'git-log',           tokens: 300, latency_ms: 150, evidence_type: 'git',       access_path: 'disk' },
  TEST_LOOKUP:        { impl: 'include',           tokens: 200, latency_ms: 20,  evidence_type: 'test',      access_path: 'disk' },
  READ_SPAN:          { impl: 'read-span',         tokens: 40,  latency_ms: 2,   evidence_type: 'reference', access_path: 'disk' },
  MERGE:              { impl: 'assemble-context',  tokens: 50,  latency_ms: 5,   evidence_type: 'merge',     access_path: 'disk' },
  DEDUP:              { impl: 'assemble-context',  tokens: 0,   latency_ms: 0,   evidence_type: 'dedup',     access_path: 'disk' },
};

// query_type → secuencia IR por defecto (lowering lógico→físico)
const DEFAULT_PIPELINES = {
  definitions: ['SYMBOL_LOOKUP', 'LEXICAL_LOOKUP', 'SCAN', 'READ_SPAN', 'MERGE', 'DEDUP'],
  references:  ['DEPENDENCY_EXPAND', 'CALLER_EXPAND', 'SYMBOL_LOOKUP', 'MERGE', 'DEDUP'],
  implementation: ['SYMBOL_LOOKUP', 'LEXICAL_LOOKUP', 'SCAN', 'READ_SPAN', 'MERGE', 'DEDUP'],
  filename:    ['LEXICAL_LOOKUP', 'SCAN', 'MERGE', 'DEDUP'],
  concept:     ['SEMANTIC_SEARCH', 'SYMBOL_LOOKUP', 'CALLER_EXPAND', 'MERGE', 'DEDUP'],
  pattern:     ['SCAN', 'LEXICAL_LOOKUP', 'MERGE', 'DEDUP'],
  default:     ['SYMBOL_LOOKUP', 'SCAN', 'MERGE', 'DEDUP'],
};

/**
 * Lowering: logicalPlan → plan físico IR con costos y access_path elegido.
 * hasCatalog → operadores index disponibles (acceso index); si no → disk.
 */
export function compile(logicalPlan, { hasCatalog = false, relations = [], inclusions = [] } = {}) {
  const qtype = logicalPlan.query_type ?? 'default';
  const pipeline = DEFAULT_PIPELINES[qtype] ?? DEFAULT_PIPELINES.default;
  const physical = [];
  for (const ir of pipeline) {
    const meta = IR_OPERATORS[ir];
    // access path: index si hay catálogo y el op lo soporta; si no → impl disk equivalente
    const useIndex = hasCatalog && meta.access_path === 'index';
    const impl = useIndex ? meta.impl : DISK_FALLBACK[ir] ?? meta.impl;
    const est = useIndex ? { tokens: meta.tokens, latency_ms: meta.latency_ms } : { tokens: meta.tokens + 40, latency_ms: meta.latency_ms + 5 };
    const op = {
      ir, impl,
      args: ir === 'READ_SPAN' ? [logicalPlan.target?.name ?? ''] : [logicalPlan.target?.name ?? ''],
      access_path: useIndex ? 'index' : 'disk',
      evidence_type: meta.evidence_type,
      est_cost: est,
      relations: ir === 'CALLER_EXPAND' ? relations : undefined,
      inclusions: ir === 'TEST_LOOKUP' ? inclusions : undefined,
    };
    physical.push(op);
  }
  const total = physical.reduce((a, o) => ({ tokens: a.tokens + o.est_cost.tokens, latency_ms: a.latency_ms + o.est_cost.latency_ms }), { tokens: 0, latency_ms: 0 });
  return { logical: { query_type: qtype, target: logicalPlan.target }, physical, total_est: total, has_catalog: hasCatalog };
}

const DISK_FALLBACK = {
  SYMBOL_LOOKUP: 'search-code',
  LEXICAL_LOOKUP: 'search-code',
  DEPENDENCY_EXPAND: 'search-structure',
  SEMANTIC_SEARCH: 'search-semantic',
};

export function irStats(irPlan) {
  const byPath = {};
  for (const o of irPlan.physical) byPath[o.access_path] = (byPath[o.access_path] ?? 0) + 1;
  return { operators: irPlan.physical.length, access_paths: byPath, total_est_tokens: irPlan.total_est.tokens };
}