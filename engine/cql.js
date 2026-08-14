#!/usr/bin/env node
/**
 * engine/cql.js — CQL (Context Query Language) parser → logical query plan.
 * Tasks 10.1 + 10.2. Node.js ESM, stdlib SOLO (sin dependencias nuevas).
 *
 * Gramática (case-insensitive, orden flexible entre cláusulas):
 *   FIND <target>              target: implementation|definitions|references|usages|filename|pattern (default implementation)
 *   OF <kind> [<name>]         kind: concept|symbol|file|function|class|constant (default symbol), name obligatorio
 *   AND FOLLOW <relations>     relations: references|callers|callees|imports|dependents (lista por comas u otro AND)
 *   AND INCLUDE <inclusions>   inclusions: tests|config|docs|generated (lista)
 *   LIMIT <n>                  n entero >= 1 (default 20)
 *   BUDGET <n>                 n en {2000,8000,20000,30000} (default 8000).
 *
 * Mapeo BUDGET (documentado): el valor pedido se redondea al nivel más cercano
 * INFERIOR del set {2000, 8000, 20000, 30000}. ej. 5000→2000, 15000→8000,
 * 12000→8000, 40000→30000, 100→2000 (piso = nivel mínimo).
 */

import { fileURLToPath } from 'node:url';

const FIND_TARGETS = new Set(['implementation', 'definitions', 'references', 'usages', 'filename', 'pattern']);
const KINDS = new Set(['concept', 'symbol', 'file', 'function', 'class', 'constant']);
const RELATIONS = new Set(['references', 'callers', 'callees', 'imports', 'dependents']);
const INCLUSIONS = new Set(['tests', 'config', 'docs', 'generated']);

// Niveles de presupuesto permitidos, ascendentes. mapBudget elige el mayor nivel <= n pedido.
const BUDGET_LEVELS = [2000, 8000, 20000, 30000];
const DEFAULT_BUDGET = 8000;
const DEFAULT_LIMIT = 20;

class CqlError extends Error {}

function mapBudget(n) {
  let mapped = BUDGET_LEVELS[0];
  for (const level of BUDGET_LEVELS) {
    if (n >= level) mapped = level;
    else break;
  }
  return mapped;
}

export function parseCQL(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new CqlError('empty input: se espera una query CQL');
  }
  const raw = input;

  // 1) Enmascarar strings entre comillas → evitan falsos marcadores de cláusula.
  const quoted = [];
  const masked = raw.replace(/"([^"]*)"/g, (_m, s) => {
    quoted.push(s);
    return `\u0000Q${quoted.length - 1}\u0000`;
  });

  // 2) Detectar cláusulas por keyword, en orden de aparición.
  const markers = [];
  const kwRe = /\b(find|of|follow|include|limit|budget)\b/gi;
  let m;
  while ((m = kwRe.exec(masked)) !== null) {
    markers.push({ kw: m[1].toLowerCase(), idx: m.index });
  }
  if (markers.length === 0) {
    throw new CqlError('FIND missing: la query no contiene ninguna cláusula CQL (se espera FIND ...)');
  }

  // 3) Segmentar: cada cláusula toma el texto hasta el siguiente marcador.
  const segments = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].idx + markers[i].kw.length;
    const end = i + 1 < markers.length ? markers[i + 1].idx : masked.length;
    segments.push({ kw: markers[i].kw, body: masked.slice(start, end).trim() });
  }

  if (segments[0].kw !== 'find') {
    throw new CqlError(`FIND missing: la primera cláusula debe ser FIND (se encontró "${segments[0].kw.toUpperCase()}")`);
  }

  const plan = {
    query_type: 'implementation',
    target: { kind: 'symbol', name: null },
    relations: [],
    inclusions: [],
    limit: DEFAULT_LIMIT,
    budget: DEFAULT_BUDGET,
    confidence: 0.95, // CQL explícito/estructurado → confianza alta
    raw,
  };

  const unquote = (s) => s.replace(/\u0000Q(\d+)\u0000/g, (_m, i) => quoted[Number(i)]);

  for (const seg of segments) {
    const body = seg.body;
    switch (seg.kw) {
      case 'find': {
        const t = /\b(\w+)\b/.exec(body);
        if (!t) {
          throw new CqlError('FIND missing: falta el target (implementation|definitions|references|usages|filename|pattern)');
        }
        const word = t[1].toLowerCase();
        plan.query_type = FIND_TARGETS.has(word) ? word : 'implementation';
        break;
      }
      case 'of': {
        // OF <kind> <name> | OF <name> (kind default: symbol)
        const k = /^\s*(concept|symbol|file|function|class|constant)\b/i.exec(body);
        let rest = body;
        if (k) {
          plan.target.kind = k[1].toLowerCase();
          rest = body.slice(k[0].length);
        }
        const n = /^\s*(?:\u0000Q(\d+)\u0000|([a-zA-Z_][\w.-]*))/.exec(rest);
        if (!n) {
          throw new CqlError(`OF ${plan.target.kind} requiere un name (string entre comillas o bareword)`);
        }
        plan.target.name = n[1] !== undefined ? quoted[Number(n[1])] : n[2];
        break;
      }
      case 'follow': {
        for (const p of body.split(/,|\band\b/i)) {
          const rel = p.trim().toLowerCase();
          if (!rel) continue;
          if (!RELATIONS.has(rel)) throw new CqlError(`invalid FOLLOW relation: ${unquote(rel)}`);
          if (!plan.relations.includes(rel)) plan.relations.push(rel);
        }
        break;
      }
      case 'include': {
        for (const p of body.split(/,|\band\b/i)) {
          const inc = p.trim().toLowerCase();
          if (!inc) continue;
          if (!INCLUSIONS.has(inc)) throw new CqlError(`invalid INCLUDE: ${unquote(inc)}`);
          if (!plan.inclusions.includes(inc)) plan.inclusions.push(inc);
        }
        break;
      }
      case 'limit': {
        const lm = /^(\d+)$/.exec(body);
        if (!lm) throw new CqlError(`invalid LIMIT: ${unquote(body)}`);
        const n = Number(lm[1]);
        if (!Number.isInteger(n) || n < 1) throw new CqlError(`invalid LIMIT: ${lm[1]} (debe ser entero >= 1)`);
        plan.limit = n;
        break;
      }
      case 'budget': {
        const bm = /^(\d+)$/.exec(body);
        if (!bm) throw new CqlError(`invalid BUDGET: ${unquote(body)}`);
        plan.budget = mapBudget(Number(bm[1]));
        break;
      }
      default:
        break;
    }
  }

  return plan;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const input = process.argv.slice(2).join(' ');
  if (!input) {
    console.error('uso: node cql.js "<query CQL>"');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(parseCQL(input)));
  } catch (err) {
    console.error(`cql.js: ${err.message}`);
    process.exit(1);
  }
}
