#!/usr/bin/env node
/**
 * engine/index-layer/indexer.js — Incremental Indexer (deliverables 6-10, 12).
 * Reconciliación: diff del manifest → indexar SOLO {added, changed} (removed se
 * purga). Por archivo: symbols + deps + FTS5. Bump de index_version por ronda.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanManifest, walkFiles, sha256Of } from './manifest.js';
import { extractSymbols, extractDeps, needsLexical } from './extractors.js';
import { openStore, upsertFile, replaceSymbols, replaceDeps, replaceLex, removeFile, getFiles, metaSet, bumpIndexVersion, tableCounts, indexVersion } from './store.js';

export function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function indexFile(db, repoDir, rec) {
  const abs = rec.path.startsWith('/') ? rec.path : path.join(repoDir, rec.path);
  const content = readFileSafe(abs);
  if (content == null) return null;
  const symbols = extractSymbols(rec.path, content);
  const deps = extractDeps(rec.path, content);
  replaceSymbols(db, rec.path, symbols);
  replaceDeps(db, rec.path, deps);
  if (needsLexical(rec.path)) replaceLex(db, rec.path, content);
  else replaceLex(db, rec.path, '');
  upsertFile(db, { ...rec, sha256: rec.sha256 ?? sha256Of(abs), indexed_at_ms: Date.now() });
  return { path: rec.path, symbols: symbols.length, deps: deps.length };
}

export function buildIndex(repoDir, dbPath = null) {
  const abs = path.resolve(repoDir);
  const db = openStore(dbPath ?? path.join(abs, '.cqe', 'catalog.db'));
  const plan = reconcile(db, abs);
  const counts = tableCounts(db);
  db.close();
  return { repo: abs, ...plan, index_version: indexVersion(db), counts };
}

export function reconcile(db, repoDir) {
  const scan = scanManifest(repoDir, getFiles(db));
  let indexedChanged = 0;
  for (const rec of scan.added) {
    rec.sha256 = sha256Of(path.join(repoDir, rec.path));
    if (indexFile(db, repoDir, rec)) indexedChanged++;
  }
  for (const rec of scan.changed) {
    if (indexFile(db, repoDir, rec)) indexedChanged++;
  }
  for (const p of scan.removed) removeFile(db, p);
  const v = bumpIndexVersion(db);
  metaSet(db, 'indexed_files', String(indexedChanged));
  return { added: scan.added.length, changed: scan.changed.length, removed: scan.removed.length, indexed_changed: indexedChanged, index_version: v };
}