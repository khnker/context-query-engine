#!/usr/bin/env node
/**
 * engine/repo-stats.js — Snapshot de estadísticas del repositorio (change repository-statistics).
 * Da al cost model el contexto del repo sin escanear completo en cada query:
 * tamaño, distribución por extensión, estimación de tokens y recencia git.
 * Node.js ESM, stdlib SOLO.
 *
 * CLI:
 *   node engine/repo-stats.js --snapshot <dir>  → snapshot JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', 'vendor', 'target']);

// Tokens estimados ≈ bytes / 4 (heurística estándar ~4 chars/token, coherente con
// el fallback bytes/4 de run-contextforge.sh).
const tokensEstimate = (bytes) => Math.max(1, Math.round(bytes / 4));

export function computeSnapshot(dir, { maxFiles = 50000 } = {}) {
  const byExtension = new Map();
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (cur) => {
    if (fileCount >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (fileCount >= maxFiles) return;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      fileCount += 1;
      totalBytes += size;
      const ext = (path.extname(ent.name) || '(none)').toLowerCase();
      const e = byExtension.get(ext) ?? { count: 0, bytes: 0, tokens: 0 };
      e.count += 1;
      e.bytes += size;
      e.tokens += tokensEstimate(size);
      byExtension.set(ext, e);
    }
  };
  walk(dir);

  const byExtensionSorted = {};
  for (const [ext, v] of [...byExtension.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    byExtensionSorted[ext] = v;
  }

  let git = { available: false, recentCommitCount30d: 0, mostRecentCommit: null };
  try {
    const recent = execFileSync('git', ['-C', dir, 'log', '--since=30 days ago', '--pretty=format:%H'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    git.recentCommitCount30d = recent ? recent.split('\n').length : 0;
    const last = execFileSync('git', ['-C', dir, 'log', '-1', '--pretty=format:%cI'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    git.mostRecentCommit = last || null;
    git.available = true;
  } catch {
    /* no es repo git → recencia vacía */
  }

  return {
    dir,
    fileCount,
    totalBytes,
    totalTokensEstimate: tokensEstimate(totalBytes),
    topExtensions: Object.entries(byExtensionSorted).slice(0, 12).map(([ext, v]) => ({ ext, ...v })),
    git,
    generatedAt: new Date().toISOString(),
  };
}

// --- CLI ---
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const args = process.argv.slice(2);
    const i = args.indexOf('--snapshot');
    if (i !== -1) {
      const dir = args[i + 1] ?? '.';
      if (!fs.existsSync(dir)) throw new Error(`dir no existe: ${dir}`);
      process.stdout.write(JSON.stringify(computeSnapshot(dir), null, 2) + '\n');
      process.exit(0);
    }
    throw new Error('uso: node engine/repo-stats.js --snapshot <dir>');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(1);
  }
}
