#!/usr/bin/env node
/**
 * engine/bm25.js — BM25 propio en node (stdlib SOLO, zero deps).
 * Op de retrieval para hybrid-retrieval-comparison: index por directorio
 * (lazy, cache en módulo), scorer Okapi BM25 k1=1.5 b=0.75.
 * Emite paths RELATIVOS al dir indexado (mismo shape que rg/parseGrep).
 */
import fs from 'node:fs';
import path from 'node:path';

const K1 = 1.5;
const B = 0.75;
const STOP = new Set(['the', 'and', 'or', 'for', 'of', 'in', 'to', 'a', 'is', 'on', 'at', 'with', 'this', 'that', 'from', 'it', 'as', 'by', 'be', 'are', 'was', 'were', 'an']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.woff', '.woff2', '.ttf', '.ico', '.ndjson', '.bin', '.zip', '.gz']);
// límites de indexación (repos enormes tipo dev=/home/nicolas/dev → OOM sin cap)
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 256 * 1024;

function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return out;
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'openspec' || e.name === '.tmp' || e.name === 'dist' || e.name === 'build') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (!SKIP_EXT.has(path.extname(e.name))) {
      try {
        if (fs.statSync(p).size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      out.push(p);
    }
  }
  return out;
}

const indexCache = new Map(); // dir → { n, avgdl, df, docLen, tf }

function getIndex(dir) {
  const key = path.resolve(dir);
  if (indexCache.has(key)) return indexCache.get(key);
  const files = walkFiles(key);
  const df = new Map();      // term → doc count
  const docLen = new Map();  // file → token count
  const tf = new Map();      // file → Map(term → count)
  let totalLen = 0;
  for (const f of files) {
    let content = '';
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const terms = tokenize(content);
    if (!terms.length) continue;
    const counts = new Map();
    for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
    tf.set(f, counts);
    docLen.set(f, terms.length);
    totalLen += terms.length;
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = docLen.size;
  const index = { files, dir: key, n, avgdl: n ? totalLen / n : 0, df, docLen, tf };
  indexCache.set(key, index);
  return index;
}

function idf(index, term) {
  const df = index.df.get(term) ?? 0;
  return Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
}

/** topK paths rankeados por BM25, score normalizado a [0,1] por el máximo. */
export function score(dir, queryWords, topK = 8) {
  const index = getIndex(dir);
  if (!index.n) return [];
  const q = [...new Set(tokenize(String(queryWords ?? '').replace(/[_/\\]+/g, ' ')))].slice(0, 8);
  if (!q.length) return [];
  const scored = [];
  for (const f of index.files) {
    const len = index.docLen.get(f) ?? 0;
    if (!len) continue;
    const counts = index.tf.get(f);
    let s = 0;
    for (const t of q) {
      const tfCount = counts.get(t) ?? 0;
      if (!tfCount) continue;
      s += idf(index, t) * (tfCount * (K1 + 1)) / (tfCount + K1 * (1 - B + B * len / index.avgdl));
    }
    if (s > 0) scored.push({ path: f, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);
  const max = top.length ? top[0].score : 0;
  return top.map((r) => ({ path: path.relative(index.dir, r.path), score: max ? r.score / max : 0 }));
}
