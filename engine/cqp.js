#!/usr/bin/env node
/**
 * engine/cqp.js — CQP (Context Query Language) parser → AST → logical query plan.
 * Tasks 10.1 + 10.2 + frontier AST (change optimizer-statistics).
 * Node.js ESM, stdlib SOLO (sin dependencias nuevas).
 *
 * Gramática (case-insensitive, orden flexible entre cláusulas):
 *   FIND <target>              target: implementation|definitions|references|usages|filename|pattern|concept|symbol (default implementation)
 *   OF <kind> [<name>]         kind: concept|symbol|file|function|class|constant (default symbol), name obligatorio
 *   AND FOLLOW <relations>     relations: references|callers|callees|imports|dependents (lista por comas u otro AND)
 *   AND INCLUDE <inclusions>   inclusions: tests|config|docs|generated (lista)
 *   LIMIT <n>                  n entero >= 1 (default 20)
 *   BUDGET <n>                 n en {2000,8000,20000,30000} (default 8000).
 *
 * parseAST(text) → AST {operator:'find', target:{type,value,kind}, relations:[{operator:'follow',type}],
 *                       include:[...], budget, limit}
 *   - target.type: de FIND <type> OF <kind> <name>. kind mapea:
 *     concept→concept, symbol→symbol, file→filename, function/class/constant→definitions.
 * toLogicalPlan(ast) → plan lógico (misma forma que devolvía parseCQP).
 * parseCQP(text) = toLogicalPlan(parseAST(text)) — compat total con callers.
 *
 * Mapeo BUDGET (documentado): el valor pedido se redondea al nivel más cercano
 * INFERIOR del set {2000, 8000, 20000, 30000}. ej. 5000→2000, 15000→8000,
 * 12000→8000, 40000→30000, 100→2000 (piso = nivel mínimo).
 */

import { fileURLToPath } from 'node:url';

const FIND_TARGETS = new Set(['implementation', 'definitions', 'references', 'usages', 'filename', 'pattern']);
const FIND_TYPES = new Set(['implementation', 'definitions', 'references', 'usages', 'filename', 'pattern', 'concept', 'symbol']);
const KINDS = new Set(['concept', 'symbol', 'file', 'function', 'class', 'constant']);
const RELATIONS = new Set(['references', 'callers', 'callees', 'imports', 'dependents']);
const INCLUSIONS = new Set(['tests', 'config', 'docs', 'generated']);
// kind → target.type (cuando FIND no trae type explícito)
const KIND_MAP = {
  concept: 'concept',
  symbol: 'symbol',
  file: 'filename',
  function: 'definitions',
  class: 'definitions',
  constant: 'definitions',
};

// Niveles de presupuesto permitidos, ascendentes. mapBudget elige el mayor nivel <= n pedido.
const BUDGET_LEVELS = [2000, 8000, 20000, 30000];
const DEFAULT_BUDGET = 8000;
const DEFAULT_LIMIT = 20;

class CqpError extends Error {}

function mapBudget(n) {
  let mapped = BUDGET_LEVELS[0];
  for (const level of BUDGET_LEVELS) {
    if (n >= level) mapped = level;
    else break;
  }
  return mapped;
}

/**
 * parseAST(text) → AST front-end:
 *   { operator:'find', target:{type,value,kind}, relations:[{operator:'follow',type}],
 *     include:[...], budget, limit }
 * value = nombre buscado; kind = kind de OF (para toLogicalPlan).
 */
export function parseAST(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new CqpError('empty input: se espera una query CQP');
  }
  const raw = input;

  // 1) Enmascarar strings entre comillas → evitan falsos marcadores de cláusula.
  const quoted = [];
  const masked = raw.replace(/"([^"]*)"/g, (_m, s) => {
    quoted.push(s);
    return `\u0000Q${quoted.length - 1}\u0000`;
  });
  const unquote = (s) => s.replace(/\u0000Q(\d+)\u0000/g, (_m, i) => quoted[Number(i)]);

  // 2) Detectar cláusulas por keyword, en orden de aparición.
  const markers = [];
  const kwRe = /\b(find|of|follow|include|limit|budget)\b/gi;
  let m;
  while ((m = kwRe.exec(masked)) !== null) {
    markers.push({ kw: m[1].toLowerCase(), idx: m.index });
  }
  if (markers.length === 0) {
    throw new CqpError('FIND missing: la query no contiene ninguna cláusula CQP (se espera FIND ...)');
  }

  // 3) Segmentar: cada cláusula toma el texto hasta el siguiente marcador.
  const segments = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].idx + markers[i].kw.length;
    const end = i + 1 < markers.length ? markers[i + 1].idx : masked.length;
    segments.push({ kw: markers[i].kw, body: masked.slice(start, end).trim() });
  }

  if (segments[0].kw !== 'find') {
    throw new CqpError(`FIND missing: la primera cláusula debe ser FIND (se encontró "${segments[0].kw.toUpperCase()}")`);
  }

  const ast = {
    operator: 'find',
    target: { type: 'implementation', value: null, kind: 'symbol' },
    relations: [],
    include: [],
    budget: DEFAULT_BUDGET,
    limit: DEFAULT_LIMIT,
  };
  let findWord = null;

  for (const seg of segments) {
    const body = seg.body;
    switch (seg.kw) {
      case 'find': {
        const t = /\b(\w+)\b/.exec(body);
        if (!t) {
          throw new CqpError('FIND missing: falta el target (implementation|definitions|references|usages|filename|pattern|concept|symbol)');
        }
        findWord = t[1].toLowerCase();
        break;
      }
      case 'of': {
        // OF <kind> <name> | OF <name> (kind default: symbol)
        const k = /^\s*(concept|symbol|file|function|class|constant)\b/i.exec(body);
        let rest = body;
        if (k) {
          ast.target.kind = k[1].toLowerCase();
          rest = body.slice(k[0].length);
        }
        const n = /^\s*(?:\u0000Q(\d+)\u0000|([a-zA-Z_][\w.-]*))/.exec(rest);
        if (!n) {
          throw new CqpError(`OF ${ast.target.kind} requiere un name (string entre comillas o bareword)`);
        }
        ast.target.value = n[1] !== undefined ? quoted[Number(n[1])] : n[2];
        break;
      }
      case 'follow': {
        for (const p of body.split(/,|\band\b/i)) {
          const rel = p.trim().toLowerCase();
          if (!rel) continue;
          if (!RELATIONS.has(rel)) throw new CqpError(`invalid FOLLOW relation: ${unquote(rel)}`);
          if (!ast.relations.some((r) => r.type === rel)) ast.relations.push({ operator: 'follow', type: rel });
        }
        break;
      }
      case 'include': {
        for (const p of body.split(/,|\band\b/i)) {
          const inc = p.trim().toLowerCase();
          if (!inc) continue;
          if (!INCLUSIONS.has(inc)) throw new CqpError(`invalid INCLUDE: ${unquote(inc)}`);
          if (!ast.include.includes(inc)) ast.include.push(inc);
        }
        break;
      }
      case 'limit': {
        const lm = /^(\d+)$/.exec(body);
        if (!lm) throw new CqpError('invalid LIMIT: se espera un entero >= 1');
        ast.limit = Number(lm[1]);
        break;
      }
      case 'budget': {
        const bm = /^(\d+)$/.exec(body);
        if (!bm) throw new CqpError('invalid BUDGET: se espera 2000|8000|20000|30000');
        ast.budget = mapBudget(Number(bm[1]));
        break;
      }
      default:
        break;
    }
  }

  // Resolver target.type: FIND <type> explícito gana; si no, kind mapea.
  ast.target.type = FIND_TYPES.has(findWord) ? findWord : (KIND_MAP[ast.target.kind] ?? 'implementation');

  return ast;
}

/**
 * toLogicalPlan(ast) → el MISMO plan lógico que parseCQP devolvía:
 *   {query_type, target:{kind,name}, relations, inclusions, limit, budget, confidence, raw}
 */
export function toLogicalPlan(ast) {
  const type = ast.target.type;
  return {
    query_type: FIND_TARGETS.has(type) ? type : 'implementation',
    target: { kind: ast.target.kind ?? 'symbol', name: ast.target.value ?? null },
    relations: ast.relations.map((r) => r.type),
    inclusions: [...ast.include],
    limit: ast.limit,
    budget: ast.budget,
    confidence: 0.95, // CQP explícito/estructurado → confianza alta
    raw: ast.raw ?? '',
  };
}

// parseCQP(text) = toLogicalPlan(parseAST(text)) — firma/salida idéntica a la previa.
export function parseCQP(input) {
  return toLogicalPlan(parseAST(input));
}

// --- CLI ---
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const showAst = args.includes('--ast');
  const input = args.filter((a) => a !== '--ast').join(' ');
  if (showAst) {
    const ast = parseAST(input);
    process.stdout.write(JSON.stringify({ ast, plan: toLogicalPlan(ast) }, null, 2) + '\n');
  } else {
    process.stdout.write(JSON.stringify(parseCQP(input)) + '\n');
  }
}
