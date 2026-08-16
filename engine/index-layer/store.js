#!/usr/bin/env node
/**
 * engine/index-layer/store.js — SQLite storage (node:sqlite, WAL, FTS5).
 * Schema: meta / files (manifest) / symbols / deps / lex (FTS5).
 * Sin deps nuevas. Persistencia en <repo>/.cqe/catalog.db (override: CQE_CATALOG_DB).
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

export function openStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      indexed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS symbols (
      entity TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      PRIMARY KEY (entity, path, line_start)
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
    CREATE TABLE IF NOT EXISTS deps (
      path TEXT NOT NULL,
      imported TEXT NOT NULL,
      PRIMARY KEY (path, imported)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS lex USING fts5(path UNINDEXED, tok, tokenize='unicode61');
  `);
  if ((db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')?.value) !== String(SCHEMA_VERSION)) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
}

export function metaGet(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
}
export function metaSet(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

export function indexVersion(db) {
  return Number(metaGet(db, 'index_version') ?? 0);
}
export function bumpIndexVersion(db) {
  const v = indexVersion(db) + 1;
  metaSet(db, 'index_version', String(v));
  return v;
}

export function upsertFile(db, rec) {
  db.prepare(`INSERT OR REPLACE INTO files (path, size, mtime_ms, sha256, indexed_at_ms)
              VALUES (?, ?, ?, ?, ?)`)
    .run(rec.path, rec.size, rec.mtimeMs, rec.sha256, Date.now());
}

export function getFiles(db) {
  return db.prepare('SELECT path, size, mtime_ms AS mtimeMs, sha256 FROM files').all();
}

export function removeFile(db, path) {
  db.prepare('DELETE FROM files WHERE path=?').run(path);
  db.prepare('DELETE FROM symbols WHERE path=?').run(path);
  db.prepare('DELETE FROM deps WHERE path=?').run(path);
  db.prepare("DELETE FROM lex WHERE path=?").run(path);
}

export function replaceSymbols(db, path, symbols) {
  db.prepare('DELETE FROM symbols WHERE path=?').run(path);
  const ins = db.prepare('INSERT OR REPLACE INTO symbols (entity, path, kind, line_start, line_end) VALUES (?, ?, ?, ?, ?)');
  for (const s of symbols) ins.run(s.entity, s.path, s.kind, s.lineStart, s.lineEnd);
}

export function replaceDeps(db, path, deps) {
  db.prepare('DELETE FROM deps WHERE path=?').run(path);
  const ins = db.prepare('INSERT OR REPLACE INTO deps (path, imported) VALUES (?, ?)');
  for (const d of deps) ins.run(path, d);
}

export function replaceLex(db, path, content) {
  db.prepare('DELETE FROM lex WHERE path=?').run(path);
  // prepend del path: FTS por basename (query filename usa phrase del nombre completo)
  if (content.trim()) db.prepare('INSERT INTO lex (path, tok) VALUES (?, ?)').run(path, `${path} ${content}`);
}

export function tableCounts(db) {
  const c = (t) => db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;
  return { files: c('files'), symbols: c('symbols'), deps: c('deps'), lex_rows: c('lex') };
}