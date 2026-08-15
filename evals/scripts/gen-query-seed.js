#!/usr/bin/env node
/**
 * evals/scripts/gen-query-seed.js — Amplía evals/datasets/queries-labeled.jsonl
 * (Phase 11.2). Mantiene las queries reales de tasks.json y añade filas sintéticas
 * por plantilla × banco de tokens, hasta CAP por clase (≥100). Determinista.
 * Clases: LEXICAL STRUCTURAL SEMANTIC DEPENDENCY CONFIGURATION TEST GIT SYMBOL REFERENCE COMPOSITE
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'evals/datasets/queries-labeled.jsonl');
const CAP = 100;

const SYMBOLS = [
  'parseConfig', 'ModelRouter', 'CylinderType', 'PricesCascadeService', 'DeclararVentaService',
  'JwtAuthGuard', 'VentaComercioService', 'DashboardService', 'SalesService', 'AuthService',
  'AppDataSource', 'DefaultEntitiesService', 'InvoiceStorageService', 'FacturacionLocalService',
  'ConciliacionMinoristaService', 'RendicionSinCargaService', 'VentaLocalService', 'fallback',
  'connect', 'shutdown', 'handleRequest', 'retryWithBackoff', 'normalize', 'validateToken',
  'checkout', 'sendInvoice', 'applyDiscount', 'calculateTotal', 'renderTable', 'loadConfig',
  'fetchProducts', 'parseResponse', 'serialize', 'deserialize', 'cacheGet', 'cacheSet',
  'logError', 'detectLanguage', 'readFileAsync', 'writeFileAsync',
];

const CONCEPTS = [
  'provider fallback', 'retry behavior', 'payment processing', 'token validation',
  'price cascade', 'sales declaration', 'invoice storage', 'billing report',
  'authentication flow', 'database connection', 'rental inventory', 'order checkout',
  'shipping cost', 'currency conversion', 'notification service', 'user permissions',
  'dashboard metrics', 'product catalog', 'test coverage', 'migration script',
  'log rotation', 'cache invalidation', 'rate limiting', 'data export',
];

const FILES = ['config', 'database', 'auth', 'sales', 'invoice', 'migration', 'types', 'utils'];

// plantillas por clase: placeholders {s}=symbol {c}=concept {f}=file {u}=función/callable
const TEMPLATES = {
  LEXICAL: [
    'Where is {s} defined?', 'Find the definition of {s}.', '¿Dónde está definido {s}?',
    'Locate the constant {s}.', 'Where is MAX_RETRIES set?', 'Find the enum {s}.',
    'Where is the literal {c} used?', 'Search for the string "{c}".',
      '¿Dónde está definido {s}?',
    '¿Dónde se define {s}?',
    'Busca la definición de {s}.',
    '¿Dónde está la constante {s}?',
    'Encuentra el enum {s}.',
    '¿Dónde aparece {s}?',
],
  STRUCTURAL: [
    'Which classes implement {s}?', 'What interfaces extend {s}?',
    'Show the class hierarchy of {s}.', 'Which files declare {s}?',
    'Find classes related to {c}.', 'What is the structure of module {f}?',
    'Show the components of {f}.', 'Which entity defines {s}?',
      '¿Qué clases implementan {s}?',
    '¿Qué interfaces extienden {s}?',
    '¿Qué archivos declaran {s}?',
    '¿Cuál es la jerarquía de {s}?',
    'Muestra los componentes de {f}.',
    '¿Qué entidad define {s}?',
],
  SEMANTIC: [
    'How does {c} work?', 'Why was {c} introduced?', 'Explain the logic behind {c}.',
    'What is the purpose of {s}?', 'How is {c} implemented?',
    'Which code handles {c}?', 'Describe the behavior of {s}.',
      '¿Cómo funciona {c}?',
    '¿Por qué se introdujo {c}?',
    '¿Qué código maneja {c}?',
    '¿Qué hace {s}?',
    '¿Cuál es el propósito de {s}?',
    'Explica {c}.',
    '¿Cómo se implementa {c}?',
],
  DEPENDENCY: [
    'Who depends on {s}?', 'What does {s} import?', 'Which modules use {s}?',
    'List the callers of {u}.', 'What are the dependencies of {f}?',
    'Which services depend on {s}?', 'How does {s} relate to {f}?',
      '¿Quién usa {s}?',
    '¿Qué módulos dependen de {s}?',
    '¿De qué depende {s}?',
    '¿Qué importa {s}?',
    '¿Qué servicios usan {s}?',
    '¿De qué depende el módulo {f}?',
    '¿Qué módulos importan {s}?',
],
  CONFIGURATION: [
    'Where is the {f} configuration?', 'How is {f} configured?',
    'Which file sets up {f}?', 'Where are the env vars for {f}?',
    'How is the connection to {f} configured?', 'Show the settings for {c}.',
      '¿Dónde está la configuración de {f}?',
    '¿Cómo se configura {f}?',
    '¿Dónde están las env vars de {f}?',
    '¿Qué archivo configura {f}?',
    'Muestra los settings de {c}.',
    '¿Dónde se conecta {f}?',
],
  TEST: [
    'Which tests cover {s}?', 'Where are the specs for {f}?',
    'Show the test file for {s}.', 'Which spec tests {c}?',
    'Where is {s} tested?', 'Find the e2e tests for {f}.',
      '¿Qué tests cubren {s}?',
    '¿Dónde está el spec de {f}?',
    '¿Qué spec prueba {c}?',
    '¿Dónde se testea {s}?',
    'Muestra los tests de {s}.',
    '¿Qué pruebas hay para {c}?',
],
  GIT: [
    'What changed recently in {f}?', 'Show the recent commits touching {s}.',
    'Who modified {s} last?', 'Which files changed in the last release?',
    'Show the history of {s}.', 'What was the last change to {f}?',
      '¿Qué cambió recientemente en {f}?',
    '¿Quién modificó {s} la última vez?',
    '¿Qué archivos cambiaron en la última release?',
    '¿Qué se cambió en {f}?',
    'Muestra el historial de {s}.',
    '¿Qué commits tocaron {s}?',
],
  SYMBOL: [
    'Where is the definition of {s}?', 'Find symbol {s}.', 'Locate {s} declaration.',
    'Which file contains {s}?', 'Show the source of {s}.', 'Find the symbol {s}.',
      '¿Dónde está la definición de {s}?',
    'Encuentra el símbolo {s}.',
    '¿Qué archivo contiene {s}?',
    'Muestra el source de {s}.',
    'Localiza la declaración de {s}.',
    '¿Dónde está la clase {s}?',
],
  REFERENCE: [
    'Who calls {u}?', 'Where is {s} referenced?', 'Find all references to {s}.',
    'Which code uses {u}?', 'List the callers of {s}.', 'Where is {s} used?',
      '¿Quién llama a {u}?',
    '¿Dónde se referencia {s}?',
    '¿Dónde se usa {s}?',
    '¿Qué código usa {s}?',
    '¿Quién referencia {s}?',
    '¿En qué archivos se usa {s}?',
    'Lista los callers de {u}.',
    '¿Quién invoca a {u}?',
    '¿Qué funciones llaman a {u}?',
    '¿Dónde se invoca {s}?',
    '¿Qué métodos llaman a {u}?',
],
  COMPOSITE: [
    'Find {s} and its callers.', 'Show {s} with related tests.', 'Explain {c} and who uses it.',
    'Find the definition of {s} and its references.', 'Trace {c} from config to usage.',
      'Encuentra {s} y sus llamadores.',
    'Explica {c} y quién lo usa.',
    'Traza {c} desde la config hasta el uso.',
    'Muestra {s} con sus tests.',
    'Encuentra la definición de {s} y sus referencias.',
    '¿Qué es {c} y quién lo usa?',
],
};

const CLASSES = Object.keys(TEMPLATES);

function readExisting() {
  if (!fs.existsSync(OUT)) return [];
  return fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.source !== 'synthetic'); // regenera sintéticas desde cero
}

function gen() {
  const rows = readExisting();
  const counts = {};
  for (const cls of CLASSES) counts[cls] = rows.filter((r) => r.label === cls).length;
  const tokens = (s) => s.replace(/[^A-Za-z0-9]/g, '');
  const seed = [];
  const banks = [SYMBOLS, CONCEPTS, FILES];
  for (const cls of CLASSES) {
    // recorrer TODAS las plantillas en round-robin (las últimas del array —p.ej. ES—
    // también se generan; antes el CAP se llenaba con las primeras y las ES quedaban fuera)
    const combos = [];
    for (const tpl of TEMPLATES[cls]) for (const bank of banks) combos.push([tpl, bank]);
    let n = counts[cls];
    let i = 0;
    while (n < CAP && i < combos.length * CAP * 2) {
      const [tpl, bank] = combos[i % combos.length];
      const tok = bank[Math.floor(i / combos.length) % bank.length];
      const text = tpl
        .replace(/\{s\}/g, tok)
        .replace(/\{c\}/g, tok)
        .replace(/\{f\}/g, tok)
        .replace(/\{u\}/g, tokens(tok));
      if (!rows.some((r) => r.text === text) && !seed.some((r) => r.text === text)) {
        seed.push({ text, label: cls, source: 'synthetic' });
        n += 1;
      }
      i += 1;
    }
  }
  return { rows, seed };
}

const { rows, seed } = gen();
const all = [...rows, ...seed];
fs.writeFileSync(OUT, all.map((r) => JSON.stringify(r)).join('\n') + '\n');

// 11.3 — split train/val/test 70/15/15 estratificado por clase (determinista: hash del texto)
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
const byLabel = {};
for (const r of all) (byLabel[r.label] ??= []).push(r);
const parts = { train: [], val: [], test: [] };
for (const cls of Object.keys(byLabel)) {
  const group = byLabel[cls].slice().sort((a, b) => hash(a.text) - hash(b.text));
  const n = group.length;
  group.forEach((r, i) => {
    if (i < Math.round(n * 0.7)) parts.train.push(r);
    else if (i < Math.round(n * 0.85)) parts.val.push(r);
    else parts.test.push(r);
  });
}
for (const [k, v] of Object.entries(parts)) {
  fs.writeFileSync(path.join(ROOT, `evals/datasets/queries-${k}.jsonl`), v.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const dist = {};
for (const r of all) dist[r.label] = (dist[r.label] ?? 0) + 1;
console.log(`total: ${all.length} rows (reales ${rows.length} + sintéticas ${seed.length})`);
console.log('split:', Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length])));
console.log(JSON.stringify(dist, null, 2));
