#!/usr/bin/env node
/**
 * engine/soundex.js — Soundex Fallback (change soundex-fallback / B17).
 * Segunda pasada fonética: cuando la fusión devuelve 0 filas, recupera
 * contenido que suene parecido al target (typos). Node.js ESM, stdlib SOLO.
 *
 * - soundexCode: American Soundex 4-char (vocal/H/W separan duplicados).
 * - similarity: prefix-match sobre códigos [1→0.25, 2→0.5, 3→0.8, 4→1.0].
 * - buildCorpus: identificadores del repo — (a) CF_SOUNDEX_CORPUS override,
 *   (b) índice bm25 (.bm25-index.json), (c) walk de paths. Nunca crash.
 * - soundexFind: top-5 candidatos con similarity >= threshold.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CODE = {
  B: 1, F: 1, P: 1, V: 1,
  C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2,
  D: 3, T: 3,
  L: 4,
  M: 5, N: 5,
  R: 6,
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.tmp', '.cqe', 'openspec', 'vendor', 'target']);

export function soundexCode(input) {
  const s = String(input ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  let out = s[0];
  let prev = CODE[s[0]];
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const v = CODE[s[i]];
    if (v === undefined) { prev = 0; continue; } // vocal/H/W separa duplicados
    if (v !== prev) out += v;
    prev = v;
  }
  return (out + '000').slice(0, 4);
}

export function similarity(codeA, codeB) {
  if (!codeA || !codeB) return 0;
  let m = 0;
  const n = Math.min(codeA.length, codeB.length);
  while (m < n && codeA[m] === codeB[m]) m++;
  return [0, 0.25, 0.5, 0.8, 1][m] ?? 0;
}

const basenameToken = (p) => {
  const base = path.basename(String(p)).replace(/\.[^.]+$/, '');
  return base.length >= 3 ? base.toLowerCase() : '';
};

const camelTokens = (tok) => {
  const parts = String(tok).split(/(?=[A-Z])/).map((p) => p.toLowerCase());
  const set = new Set(parts.filter((p) => p.length >= 3));
  if (tok.length >= 3) set.add(tok.toLowerCase());
  return [...set];
};

function enrich(found) {
  const byTok = new Map();
  for (const { token, path: p } of found) {
    for (const t of camelTokens(token)) {
      const ex = byTok.get(t);
      if (ex === undefined) byTok.set(t, p);
      else if (!ex && p) byTok.set(t, p);
    }
  }
  const all = [...byTok];
  const cap = Number(process.env.CF_SOUNDEX_CORPUS_CAP ?? 50000);
  return all.slice(0, cap).map(([token, p]) => ({ token, path: p }));
}

export function buildCorpus(repoDir) {
  const found = [];
  const seen = new Set();
  const push = (tok, p) => {
    const t = String(tok).toLowerCase();
    if (t.length < 3 || seen.has(t)) return;
    seen.add(t);
    found.push({ token: t, path: p });
  };
  try {
    if (process.env.CF_SOUNDEX_CORPUS) {
      const arr = JSON.parse(fs.readFileSync(process.env.CF_SOUNDEX_CORPUS, 'utf8'));
      for (const x of arr) push(String(x), null);
    } else {
      const bm25File = process.env.CF_BM25_INDEX_FILE
        || path.join(path.dirname(fileURLToPath(import.meta.url)), '.bm25-index.json');
      if (fs.existsSync(bm25File)) {
        const idx = JSON.parse(fs.readFileSync(bm25File, 'utf8'));
        const key = Object.keys(idx).find((k) => path.resolve(k) === path.resolve(repoDir));
        const rec = key ? idx[key] : null;
        if (rec) {
          for (const f of rec.files || []) push(basenameToken(f.p), f.p);
          for (const [f, m] of Object.entries(rec.tf || {})) {
            for (const t of Object.keys(m)) push(t, f);
          }
        }
      }
    }
  } catch { /* best-effort */ }
  if (found.length) return enrich(found);
  try {
    const walk = (dir) => {
      let es = [];
      try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        if (e.name.startsWith('.') && e.name !== '.env') continue;
        if (SKIP_DIRS.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) push(basenameToken(e.name), p);
      }
    };
    walk(path.resolve(repoDir));
  } catch { /* best-effort */ }
  return enrich(found);
}

const splitIdent = (s) => String(s).split(/[^A-Za-z0-9]+/).flatMap((w) => camelTokens(w)).filter((t) => t.length >= 3);

export function soundexFind(target, repoDir, threshold = 0.8) {
  const targetCode = soundexCode(target);
  if (!targetCode) return [];
  const parts = splitIdent(target);
  const corpus = buildCorpus(repoDir);
  const cands = [];
  for (const { token, path: p } of corpus) {
    const tCode = soundexCode(token);
    const full = similarity(targetCode, tCode);
    let best = full;
    let bestPart = null;
    if (full < threshold) {
      for (const part of parts) {
        const s = similarity(soundexCode(part), tCode);
        if (s > best) { best = s; bestPart = part; }
      }
    }
    if (best >= threshold) {
      cands.push({ path: p, token, code: tCode, similarity: best, matched_part: bestPart });
    }
  }
  cands.sort((a, b) => b.similarity - a.similarity);
  return cands.slice(0, 5);
}

// CLI: node engine/soundex.js '<target>' [threshold] [repoDir]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, thr, repo] = process.argv.slice(2);
  const res = soundexFind(target ?? '', repo ?? process.cwd(), Number(thr ?? 0.8));
  console.log(JSON.stringify({ target, threshold: Number(thr ?? 0.8), candidates: res }, null, 2));
}
