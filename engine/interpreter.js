#!/usr/bin/env node
/**
 * engine/interpreter.js — heurísticas intención → query_type + confidence (sin ML).
 * Task 11.1. Node.js ESM, stdlib SOLO.
 *
 * Familias de patrones regex sobre el texto. Reglas de confidence:
 *   - 2+ keywords de la misma familia      → 0.95
 *   - combinación ambigua (varias familias, 1 hit c/u) → familia de mayor score, confidence 0.5
 *   - 1 sola familia, 1 hit                → score base de la familia
 *   - sin match                            → default implementation, 0.3
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 11.7 — clase de intención (ML) → query_type del interpreter (fallback regex intacto)
const CLASS_TO_TYPE = {
  LEXICAL: 'definitions',
  SYMBOL: 'definitions',
  STRUCTURAL: 'implementation',
  REFERENCE: 'references',
  DEPENDENCY: 'references',
  SEMANTIC: 'concept',
  CONFIGURATION: 'pattern',
  TEST: 'pattern',
  GIT: 'implementation',
  COMPOSITE: 'concept',
};

// 11.7 — clasificador local opcional (CF_MODEL_CMD sirviendo 'classify-query').
// Mismo contrato que engine/local-model.js: <bin> classify-query '<json>'. Si
// confidence >= umbral → query_type del modelo; si no/falla → regex heurístico.
function mlQueryType(text) {
  const cmd = process.env.CF_MODEL_CMD;
  if (!cmd) return null;
  const [bin, ...args] = cmd.split(/\s+/);
  try {
    const out = execFileSync(bin, [...args, 'classify-query', JSON.stringify({ query: text })], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const r = JSON.parse(out);
    if (r?.label && r.confidence >= 0.6 && CLASS_TO_TYPE[r.label]) {
      return { query_type: CLASS_TO_TYPE[r.label], confidence: r.confidence, matched: [`ml:${r.label}`], ml: true };
    }
  } catch { /* modelo ausente/roto → heurístico */ }
  return null;
}

const FAMILIES = [
  {
    type: 'definitions',
    score: 0.8,
    patterns: [
      [/\bdefine/i, 'define'],
      [/dónde está definid/i, 'dónde está definid'],
      [/\bdeclara/i, 'declara'],
      [/where is[\s\S]{0,40}defin/i, 'where is defin'],
    ],
  },
  {
    type: 'references',
    score: 0.8,
    patterns: [
      [/\busos\b/i, 'usos'],
      [/referencias/i, 'referencias'],
      [/quién usa/i, 'quién usa'],
      [/\bcallers\b/i, 'callers'],
      [/who calls/i, 'who calls'],
      [/dónde se usa/i, 'dónde se usa'],
      [/\breferences\b/i, 'references'],
    ],
  },
  {
    type: 'implementation',
    score: 0.75,
    patterns: [
      [/implementa/i, 'implementa'],
      [/implementation/i, 'implementation'],
      [/implementación/i, 'implementación'],
      [/cómo funciona/i, 'cómo funciona'],
      [/how does/i, 'how does'],
    ],
  },
  {
    type: 'filename',
    score: 0.8,
    patterns: [
      [/archivo/i, 'archivo'],
      [/filename/i, 'filename'],
      [/file[\s\S]{0,40}llamad/i, 'file llamado'],
      [/dónde está el archivo/i, 'dónde está el archivo'],
    ],
  },
  {
    type: 'pattern',
    score: 0.6,
    patterns: [
      [/patrón/i, 'patrón'],
      [/pattern/i, 'pattern'],
      [/estructura/i, 'estructura'],
      [/código que hace/i, 'código que hace'],
      [/\b(if|try|catch|while|for)\b/i, 'keyword if/try/catch'],
    ],
  },
  {
    type: 'concept',
    score: 0.6,
    patterns: [
      [/concepto/i, 'concepto'],
      [/subsystem/i, 'subsystem'],
      [/módulo que/i, 'módulo que'],
      [/qué hace/i, 'qué hace'],
      [/\bconcept\b/i, 'concept'],
    ],
  },
];

const STOP_WORDS = new Set(['de', 'el', 'la', 'lo', 'los', 'las', 'del', 'un', 'una', 'que', 'y', 'a', 'en', 'se', 'con', 'para']);

// Extraer nombre de símbolo/concepto: string entre comillas → camelCase/PascalCase → tras "de/el/la".
function extractName(text) {
  const q = /"([^"]+)"/.exec(text);
  if (q) return q[1];
  const cc = /\b([a-z]+[A-Z][A-Za-z0-9]*)\b|\b([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/.exec(text);
  if (cc) return cc[1] || cc[2];
  const after = /\b(?:de|el|la|lo)\s+([a-zA-ZáéíóúñÁÉÍÓÚÑ][a-zA-ZáéíóúñÁÉÍÓÚÑ0-9]*(?:\s+[a-zA-ZáéíóúñÁÉÍÓÚÑ0-9]+){0,2})/.exec(text);
  if (after) {
    const name = after[1].trim();
    if (!STOP_WORDS.has(name.toLowerCase())) return name;
  }
  return null;
}

export function interpret(text) {
  const src = String(text ?? '').trim();
  if (src === '') {
    return { query_type: 'implementation', confidence: 0.3, matched: [] };
  }

  // 11.7 — si hay clasificador local y confía (≥0.6), gana; si no, regex heurístico
  const ml = mlQueryType(src);
  if (ml) return ml;

  const hits = [];
  for (const fam of FAMILIES) {
    for (const [re, label] of fam.patterns) {
      re.lastIndex = 0;
      if (re.test(src)) hits.push({ type: fam.type, label, score: fam.score });
    }
  }

  const matched = [...new Set(hits.map((h) => h.label))];

  let query_type;
  let confidence;
  if (hits.length === 0) {
    query_type = 'implementation';
    confidence = 0.3;
  } else {
    const byType = new Map();
    for (const h of hits) {
      if (!byType.has(h.type)) byType.set(h.type, []);
      byType.get(h.type).push(h);
    }
    const families = [...byType.entries()].map(([type, hs]) => ({ type, count: hs.length, score: hs[0].score }));
    families.sort((a, b) => b.count - a.count || b.score - a.score);
    const best = families[0];
    query_type = best.type;
    if (best.count >= 2) {
      confidence = 0.95;
    } else if (families.length > 1) {
      confidence = 0.5;
    } else {
      confidence = best.score;
    }
  }

  const result = { query_type, confidence, matched };
  const name = extractName(src);
  if (name) result.name = name;
  return result;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const text = process.argv.slice(2).join(' ');
  console.log(JSON.stringify(interpret(text)));
}
