#!/usr/bin/env node
/**
 * engine/index-ops.js — access paths sobre el Repository Index Layer (context-query-ir).
 * ensureIndex(cwd): construye el catálogo una vez por repo (memo) si falta.
 * Wrappers: symbol-lookup / lexical-index / dependency-expand → rows de evidencia
 * tipada {source, path, line_start, line_end, match_type, score, certainty, token_estimate}.
 * Fallback: catálogo ausente/roto → null (el caller decide: rg o construir).
 */
import path from 'node:path';
import fs from 'node:fs';
import { buildIndex, queryIndex } from './index-layer/index.js';

const built = new Map(); // cwd → true

export function ensureIndex(cwd, { forceBuild = false } = {}) {
  const key = path.resolve(cwd);
  if (built.has(key) && !forceBuild) return 2; // 2 = reuse
  const dbPath = path.join(key, '.cqe', 'catalog.db');
  if (!fs.existsSync(dbPath)) {
    try {
      buildIndex(key);
      built.set(key, true);
      return 1; // 1 = build
    } catch {
      return 0; // 0 = fallback rg
    }
  }
  built.set(key, true);
  return 2;
}

export function symbolLookup(cwd, name, limit = 10) {
  const rows = queryIndex(cwd, 'symbol', name, limit);
  return rows.map((r) => ({
    source: 'index-symbol', path: r.path, line_start: r.span?.start ?? 1, line_end: r.span?.end ?? 1,
    content: '', match_type: 'structural', score: 1, certainty: r.certainty,
    index_version: r.index_version, token_estimate: 12,
  }));
}

export function lexicalLookup(cwd, name, limit = 10) {
  const rows = queryIndex(cwd, 'lexical', name, limit);
  return rows.map((r) => ({
    source: 'index-lexical', path: r.path, line_start: 1, line_end: 1,
    content: '', match_type: 'exact', score: 0.9, certainty: r.certainty,
    index_version: r.index_version, token_estimate: 10,
  }));
}

export function dependencyExpand(cwd, name, limit = 10) {
  const rows = queryIndex(cwd, 'dependency', name, limit);
  return rows.map((r) => ({
    source: 'index-dependency', path: r.path, line_start: 1, line_end: 1,
    content: '', match_type: 'reference', score: 0.9, certainty: r.certainty,
    index_version: r.index_version, token_estimate: 10,
  }));
}