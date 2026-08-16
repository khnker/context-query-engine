#!/usr/bin/env node
/**
 * engine/index-layer/index.js — API pública + CLI del Repository Index Layer.
 * El índice produce EVIDENCIA tipada (determinista vs probabilística), nunca
 * "search results": {source, entity, path, span, certainty, index_version, cost}.
 * Freshness model: snapshot / dirty_scope / live — nunca evidencia vieja silenciosa.
 * Uso CLI: index <repo> | query <repo> <symbol|lexical|dependency|catalog> <term> | freshness <repo>
 */
import path from 'node:path';
import { openStore, getFiles, tableCounts, indexVersion, metaGet } from './store.js';
import { reconcile } from './indexer.js';
import { walkFiles, statFile } from './manifest.js';

const dbPathFor = (repoDir) => path.join(path.resolve(repoDir), '.cqe', 'catalog.db');

export function buildIndex(repoDir) {
  const abs = path.resolve(repoDir);
  const db = openStore(dbPathFor(abs));
  const res = reconcile(db, abs);
  db.close();
  return res;
}

export function freshness(repoDir) {
  const abs = path.resolve(repoDir);
  const db = openStore(dbPathFor(abs));
  const known = new Map(getFiles(db).map((f) => [f.path, { size: f.size, mtimeMs: f.mtimeMs }]));
  const changed = [];
  for (const p of walkFiles(abs)) {
    const rec = statFile(p, abs);
    if (!rec) continue;
    const k = known.get(rec.path);
    if (!k || k.size !== rec.size || k.mtimeMs !== rec.mtimeMs) changed.push(rec.path);
  }
  const diskPaths = new Set();
  for (const p of walkFiles(abs)) { const rec = statFile(p, abs); if (rec) diskPaths.add(rec.path); }
  for (const p of known.keys()) if (!diskPaths.has(p)) changed.push(p); // removed
  const v = indexVersion(db);
  db.close();
  const scope = changed.length ? changed : null;
  const state = scope ? 'dirty_scope' : 'snapshot';
  const decision = scope ? 'reindex' : 'use_index';
  return { state, changed_paths: scope, scope: scope ? { n: scope.length } : null, decision, index_version: v };
}

function evidenceRow(db, r, source, certainty, extra = {}) {
  return {
    source, entity: r.entity ?? null, path: r.path,
    span: r.line_start ? { start: r.line_start, end: r.line_end } : null,
    certainty, index_version: indexVersion(db),
    cost: { latency_ms: 0.02, tokens: 8 }, ...extra,
  };
}

export function queryIndex(repoDir, type, term, limit = 10) {
  const abs = path.resolve(repoDir);
  const db = openStore(dbPathFor(abs));
  const out = [];
  const t0 = Date.now();
  if (type === 'symbol') {
    for (const r of db.prepare('SELECT entity, path, kind, line_start, line_end FROM symbols WHERE entity = ? OR entity LIKE ? LIMIT ?').all(term, `%${term}%`, limit)) {
      out.push(evidenceRow(db, r, 'symbol', 1.0, { kind: r.kind }));
    }
  } else if (type === 'lexical') {
    const q = term.replace(/"/g, '""');
    try {
      for (const r of db.prepare(`SELECT path, tok FROM lex WHERE lex MATCH ? LIMIT ?`).all(`"${q}"`, limit)) {
        out.push(evidenceRow(db, { entity: term, path: r.path }, 'lexical', 0.9));
      }
    } catch { /* FTS5 syntax → 0 resultados */ }
  } else if (type === 'dependency') {
    for (const r of db.prepare('SELECT path, imported FROM deps WHERE imported = ? LIMIT ?').all(term, limit)) {
      out.push(evidenceRow(db, { entity: term, path: r.path }, 'dependency', 1.0, { imported: r.imported }));
    }
  } else if (type === 'catalog') {
    out.push({ source: 'catalog', entity: null, path: null, span: null, certainty: 1.0, index_version: indexVersion(db), cost: { latency_ms: 0.01, tokens: 4 }, counts: tableCounts(db), meta: { indexed_files: metaGet(db, 'indexed_files') } });
  }
  for (const r of out) r.cost.latency_ms = +(r.cost.latency_ms + (Date.now() - t0) / Math.max(1, out.length)).toFixed(2);
  db.close();
  return out;
}

// --- CLI ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
import { pathToFileURL } from 'node:url';
if (isMain) {
  const [cmd, repo, type, term, ...rest] = process.argv.slice(2);
  if (!cmd || !repo) { console.error('uso: index.js <index|query|freshness> <repo> [type term]'); process.exit(2); }
  if (cmd === 'index') {
    const t0 = Date.now();
    const r = buildIndex(repo);
    console.log(JSON.stringify({ ...r, elapsed_ms: Date.now() - t0 }, null, 2));
  } else if (cmd === 'query') {
    const rows = queryIndex(repo, type, term ?? '', Number(rest[0]) || 10);
    console.log(JSON.stringify(rows, null, 2));
  } else if (cmd === 'freshness') {
    console.log(JSON.stringify(freshness(repo), null, 2));
  }
}