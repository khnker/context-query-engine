#!/usr/bin/env node
/**
 * engine/index-layer/manifest.js — File Manifest (deliverable 2).
 * Escanea el repo (exclusiones), hashea contenido → diff vs store →
 * {added, changed, removed}. Base del indexador incremental (deliverable 12).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.tmp', '.cqe', 'openspec', '.frigg']);
const MAX_BYTES = 256 * 1024;

export function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

export function statFile(p, root) {
  try {
    const st = fs.statSync(p);
    if (st.size > MAX_BYTES) return null;
    return { path: path.relative(root, p).split(path.sep).join('/'), size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}

export function sha256Of(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function scanManifest(repoDir, storeFiles) {
  const before = new Map(storeFiles.map((f) => [f.path, f]));
  const now = new Map();
  const added = [], changed = [], removed = [];
  for (const p of walkFiles(repoDir)) {
    const rec = statFile(p, repoDir);
    if (!rec) continue;
    const prev = before.get(rec.path);
    now.set(rec.path, rec);
    if (!prev) added.push(rec);
    else if (prev.size !== rec.size || prev.mtimeMs !== rec.mtimeMs) {
      const h = sha256Of(path.join(repoDir, rec.path));
      rec.sha256 = h;
      changed.push({ ...rec, sha256: h });
    } else {
      rec.sha256 = prev.sha256;
    }
  }
  for (const [p] of before) if (!now.has(p)) removed.push(p);
  return { added, changed, removed };
}