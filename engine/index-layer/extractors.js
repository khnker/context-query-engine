#!/usr/bin/env node
/**
 * engine/index-layer/extractors.js — extractores deterministas (regex, stdlib).
 * Símbolos y dependencias por lenguaje (TS/JS/Python mínimo): evidencia
 * determinista (certainty 1.0) de un solo paso, sin tree-sitter (v1).
 */
import path from 'node:path';

const JS_TS = /\.(m?[jt]sx?|cjs|mjs)$/;
const PY = /\.py$/;

const SYMBOL_PATTERNS = [
  [/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gy, 'function'],
  [/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gy, 'class'],
  [/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gy, 'function'],
  [/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gy, 'const'],
  [/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gy, 'interface'],
  [/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/gy, 'type'],
  [/^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/gy, 'enum'],
];
const PY_SYMBOL_PATTERNS = [
  [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gy, 'function'],
  [/^class\s+([A-Za-z_]\w*)/gy, 'class'],
];
const DEP_PATTERNS_TS = [
  /^(?:import\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"])/gm,
  /^require\(\s*['"]([^'"]+)['"]\s*\)/gm,
];
const DEP_PATTERNS_PY = [
  /^(?:import|from)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/gm,
];

const isBinary = (p) => /\.(png|jpe?g|gif|pdf|woff2?|ttf|ico|ndjson|bin|zip|gz|sqlite3?|lock)$/i.test(p);

export function extractSymbols(filePath, content) {
  if (isBinary(filePath)) return [];
  const patterns = PY.test(filePath) ? PY_SYMBOL_PATTERNS : JS_TS.test(filePath) ? SYMBOL_PATTERNS : [];
  const symbols = [];
  const lines = content.split('\n');
  const base = path.basename(filePath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [re, kind] of patterns) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m && m[1]) {
        symbols.push({ entity: m[1], kind: kind === 'function' ? 'function' : kind, lineStart: i + 1, lineEnd: i + 1, path: filePath });
      }
    }
  }
  // si es un archivo de módulo sin símbolos top-level, al menos indexar el propio basename? NO — 0 evidencia es 0 evidencia.
  // (base se indexa igual por FTS5)
  return symbols;
}

export function extractDeps(filePath, content) {
  const re = PY.test(filePath) ? DEP_PATTERNS_PY : JS_TS.test(filePath) ? DEP_PATTERNS_TS : [];
  const deps = [];
  for (const p of re) {
    p.lastIndex = 0;
    let m;
    while ((m = p.exec(content)) !== null) deps.push(m[1].split('/')[0]);
  }
  return [...new Set(deps.filter(Boolean))];
}

export function needsLexical(filePath) {
  return JS_TS.test(filePath) || PY.test(filePath) || /\.(ya?ml|toml|json|md|html|css)$/i.test(filePath);
}