#!/usr/bin/env node
/**
 * engine/decompose.js — descomposición física de queries (change 02).
 * Reglas deterministas (keywords + schema del target) → sub-consultas físicas
 * {definitions, references, implementation} SIN LLM. Reserva semántica/LLM solo
 * para ambigüedad no cubierta por reglas (retorna la query original intacta).
 * Multi-facet: "se valida Y persiste un usuario" → symbol + callers + impl.
 */
const FACET_A = new Set(['validate', 'validar', 'persist', 'guardar', 'persistir', 'save', 'store', 'handle', 'manage', 'process', 'procesar', 'register', 'registrar', 'create', 'crear', 'update', 'actualizar', 'usa', 'usar', 'uses', 'use', 'consume', 'consumir']);
const FACET_B = new Set(['caller', 'callers', 'usage', 'usages', 'who', 'quien', 'quienes', 'referenced', 'referencia', 'usado', 'llama', 'llaman', 'llamar', 'called', 'invoca', 'invocado']);
const FACET_C = new Set(['implement', 'implementation', 'implementacion', 'define', 'definir', 'defined', 'definido', 'where', 'donde']);

export function parseName(rawText) {
  const m = /OF\s+(?:symbol|file|function|class|constant|concept)\s+["']?([A-Za-z0-9_./-]+)["']?\s*(?:LIMIT\s+\d+)?/i.exec(rawText);
  if (m) return m[1];
  const id = /([A-Za-z_][A-Za-z0-9_]{2,})/g.exec(String(rawText).replace(/\b(donde|where|who|que|cual|define|valida|persiste|llama|usa|usado|called|used|validate|persist|save|store)\b/gi, ''));
  return id ? id[1] : null;
}

const FACET_COVER = { persistence: 'implementation', callers: 'references', definition: 'definitions' };

export function decompose(rawText, nameHint, coveredTypes = []) {
  const name = nameHint ?? parseName(rawText);
  if (!name) return { facets: [], sub_queries: [rawText] };
  const words = rawText.toLowerCase().split(/\W+/).filter(Boolean);
  const hitA = words.some((w) => FACET_A.has(w));
  const hitB = words.some((w) => FACET_B.has(w));
  const hitC = words.some((w) => FACET_C.has(w));
  const facets = [];
  if (hitA) facets.push('persistence');
  if (hitB) facets.push('callers');
  if (hitC) facets.push('definition');
  const sub = [rawText];
  if (hitB && !coveredTypes.includes('references')) sub.push(`FIND references OF symbol ${name} LIMIT 8`);
  if (hitC && !coveredTypes.includes('definitions')) sub.push(`FIND definitions OF symbol ${name} LIMIT 8`);
  if (hitA && !coveredTypes.includes('implementation') && !/implementation|concept/.test(rawText)) sub.push(`FIND implementation OF symbol ${name} LIMIT 8`);
  return { facets, sub_queries: [...new Set(sub)] };
}