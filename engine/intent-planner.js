/**
 * engine/intent-planner.js — Intent classification + planning (task CQE-2).
 *
 * Maps natural language queries to structured query_type + confidence (Phase 2).
 * The planner extends the Interpreter's regex-based classification with:
 *   - richer intent taxonomy (definitions, callers, references, decisions, etc.)
 *   - fallback chain for low-confidence inputs
 *   - budget estimation based on intent type
 *
 * Integrates with the existing Interpreter (engine/interpreter.js) but provides
 * a richer planning layer that selects retrievers + reranker strategy.
 *
 * Intent taxonomy aligned to CQE Phase 2:
 *   Architecture_decision  → ADR/RFC docs (lexical + semantic)
 *   symbol-definition      → code symbol lookup (structural)
 *   callers                → callers of a function/method (structural)
 *   references             → references to a term (lexical + semantic)
 *   definition             → generic definition (lexical + structural)
 *   changelog              → git history (git-log)
 *   services-active        → structured data / API (federated planes)
 *   similar-decision       → embeddings (semantic retrieval)
 */

// Intent → query_type mapping (mirrors optimizer.js plansForQueryType)
const INTENT_TO_QUERY_TYPE = {
  'architecture_decision': 'definitions',
  'symbol_definition': 'symbol',
  'callers': 'callers',
  'references': 'references',
  'definition': 'definitions',
  'changelog': 'history',
  'services_active': 'definitions',
  'similar_decision': 'semantic'
}

// Default budget per intent (tokens)
const INTENT_BUDGET = {
  'architecture_decision': 8000,
  'symbol_definition': 4000,
  'callers': 6000,
  'references': 8000,
  'definition': 6000,
  'changelog': 3000,
  'services_active': 4000,
  'similar_decision': 10000
}

/**
 * Regex patterns for intent classification (Phase 2 — intent taxonomy).
 * Each pattern: { regex, intent, confidence }
 */
const INTENT_PATTERNS = [
  // Architecture decisions (ADR, RFC, por qué elegimos X)
  {
    regex: /\b(ADR|architecture decision|why (did|we) (choose|use|pick)|decision\b).*\b(choose|use|select|pick)\b.*\b(system|tool|approach|library|database|tech|nosis)\b/i,
    intent: 'architecture_decision',
    confidence: 0.9,
    query_type: 'definitions'
  },
  {
    regex: /\b(ADR-\d+|architecture decision record)\b/i,
    intent: 'architecture_decision',
    confidence: 0.95,
    query_type: 'definitions'
  },
  {
    regex: /\bpor qué\b.*\b(usamos|usar|elegir)\b.*\b(oauth|postgres|microservice|monolito|react|angular)\b/i,
    intent: 'architecture_decision',
    confidence: 0.85,
    query_type: 'definitions'
  },
  // Symbol definition (definido, implementado, existe, clases, funciones)
  {
    regex: /\b(dónde está|definición de|implementado|existe)\s+(\w+)\b/i,
    intent: 'symbol_definition',
    confidence: 0.9,
    query_type: 'symbol'
  },
  {
    regex: /\b(clase|función|método|módulo)\b.*?\b(\w+)\b/i,
    intent: 'symbol_definition',
    confidence: 0.8,
    query_type: 'symbol'
  },
  // Callers (quién llama a / llama a)
  {
    regex: /\b(quién llama|llama a|callers|callers of)\s+(['"]?\w+['"]?)\b/i,
    intent: 'callers',
    confidence: 0.9,
    query_type: 'callers'
  },
  {
    regex: /\b(quién invoca|invocan)\b/i,
    intent: 'callers',
    confidence: 0.85,
    query_type: 'callers'
  },
  // Changelog / git history
  {
    regex: /\b(qué cambió|cambio entre|git log|historia|commits|release)\b/i,
    intent: 'changelog',
    confidence: 0.85,
    query_type: 'history'
  },
  // Similar decision (similar a / embeddings)
  {
    regex: /\b(decisión similar|similar a la decisión|como la decisión)\b/i,
    intent: 'similar_decision',
    confidence: 0.8,
    query_type: 'semantic'
  },
  // Services active (API / servicios / endpoints)
  {
    regex: /\b(servicios? activos?|endpoints?|API disponible|microservice)\b/i,
    intent: 'services_active',
    confidence: 0.8,
    query_type: 'definitions'
  }
]

/**
 * Parse an IntentPlan from a query.
 *
 * @param {string} query - Natural language query (e.g., "where is UserService defined?")
 * @param {object} opts - Optional overrides
 * @returns {IntentPlan}
 */
export function parseIntent(query, opts = {}) {
  const q = String(query || '').trim().toLowerCase()

  // Try patterns in order, return first match
  for (const pat of INTENT_PATTERNS) {
    if (pat.regex.test(q)) {
      return new IntentPlan({
        intent: pat.intent,
        query_type: pat.query_type,
        confidence: opts.confidence != null ? opts.confidence : pat.confidence,
        budget: INTENT_BUDGET[pat.intent],
        target: extractTarget(q, pat.intent),
        raw: query
      })
    }
  }

  // Fallback: use keyword heuristics (mirrors Interpreter.js families)
  const fallback = fallbackIntent(q)

  return new IntentPlan({
    intent: fallback.intent,
    query_type: fallback.query_type,
    confidence: 0.4, // low — user should clarify
    budget: INTENT_BUDGET[fallback.intent] || 6000,
    target: extractTarget(q, fallback.intent),
    raw: query,
    flagged: true // signal to planner: confidence below threshold
  })
}

/**
 * Fallback heuristic classification (keyword-based).
 * Lower confidence — used when regex patterns don't match.
 */
function fallbackIntent(q) {
  if (/\b(definición|definido|implementado|clase|función)\b/.test(q))
    return { intent: 'symbol_definition', query_type: 'symbol' }

  if (/\b(llama|llamado|callers|call)\b/.test(q))
    return { intent: 'callers', query_type: 'callers' }

  if (/\b(ADR|decision|arquitectura|why|por qué)\b/.test(q))
    return { intent: 'architecture_decision', query_type: 'definitions' }

  if (/\b(cambio|commit|historia|release)\b/.test(q))
    return { intent: 'changelog', query_type: 'history' }

  // Default: treat as references (lexical + semantic)
  return { intent: 'references', query_type: 'references' }
}

/**
 * Extract the target entity from the query (symbol name, decision number, etc.).
 */
function extractTarget(q, intent) {
  // Extract ADR-NNN number
  if (intent === 'architecture_decision') {
    const m = q.match(/ADR-(\d+)/i)
    if (m) return { kind: 'adr', name: m[0].toUpperCase() }

    // Extract tool/system name (heuristic: last significant token)
    const m2 = q.match(/(?:choose|usamos|usar|elegir).*\b(\w+)\b/i)
    if (m2) return { kind: 'system', name: m2[1] }
    return { kind: 'unspecified' }
  }

  // For symbol_definition / callers: extract identifier-like token
  if (intent === 'symbol_definition' || intent === 'callers') {
    // Look for quoted or backtoacked identifiers
    const m = q.match(/['"`]([^'"`]+)['"`]/)
    if (m) return { kind: 'symbol', name: m[1] }

    // Look for identifier after keywords
    const m2 = q.match(/(?:de|del|para)\s+(\w[\w.]*)/)
    if (m2) return { kind: 'symbol', name: m2[1] }
    return { kind: 'unspecified' }
  }

  // Default: extract last significant token (non-stopword)
  const stopwords = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'para', 'con', 'por', 'en', 'que', 'qué', 'dónde', 'cómo', 'cuándo', 'cuál', 'quién', 'cuánto'])
  const tokens = q.replace(/[^\w\sáéíóúñ]/gi, ' ').split(/\s+/).filter(t => t.length > 2 && !stopwords.has(t.toLowerCase()))
  const name = tokens[tokens.length - 1] || q.replace(/\s+/g, '-')
  return { kind: 'term', name: name }
}

/**
 * IntentPlan — structured representation of a classified query.
 */
export class IntentPlan {
  constructor({ intent, query_type, confidence, budget, target, raw, flagged = false }) {
    this.intent = intent
    this.query_type = query_type
    this.confidence = confidence
    this.budget = budget
    this.target = target
    this.raw = raw
    this.flagged = flagged
  }

  /** True if confidence is below a usable threshold */
  isLowConfidence(threshold = 0.6) {
    return this.confidence < threshold
  }

  /** Serialized form for logging / debugging */
  toJSON() {
    return {
      intent: this.intent,
      query_type: this.query_type,
      confidence: this.confidence,
      budget: this.budget,
      target: this.target,
      raw: this.raw,
      flagged: this.flagged
    }
  }
}

/**
 * Select retrievers appropriate for a given IntentPlan.
 * This is the Phase 2 planning step: map intent + query_type → retriever list.
 *
 * @param {IntentPlan} plan
 * @param {object} registry - Map of name → Retriever class/factory
 * @returns {Retriever[]} instantiated retrievers for parallel execution
 */
export function planRetrievers(plan, registry) {
  const retrieverNames = selectRetrieverNames(plan)
  return retrieverNames
    .map(name => registry[name])
    .filter(Boolean)
    .map(factory => typeof factory === 'function' ? (factory.length ? factory(plan) : new factory(plan)) : factory)
    .filter(r => r instanceof RetrieverClass())
}

function RetrieverClass() {
  // Import lazily to avoid circular dependency
  return class {
    retrieve() {}
  }
}

/**
 * Intent → retrievers mapping (Phase 2 planning table).
 */
function selectRetrieverNames(plan) {
  const qt = plan.query_type
  const intent = plan.intent

  // Architecture decisions: lexical + semantic
  if (intent === 'architecture_decision' || qt === 'semantic') {
    return ['bm25', 'lexical', 'symbol']
  }

  // Symbol definitions: structural + lexical
  if (qt === 'symbol') {
    return ['symbol', 'lexical', 'bm25']
  }

  // Callers / references: structural + lexical + semantic
  if (qt === 'callers' || qt === 'references' || qt === 'definitions') {
    return ['bm25', 'symbol', 'lexical']
  }

  // Changelog: git log (special retriever)
  if (qt === 'history') {
    return ['git-history']
  }

  // Services active: structured
  if (qt === 'services_active') {
    return ['federated', 'symbol']
  }

  // Fallback: lexical breadth
  return ['bm25', 'lexical']
}

export { selectRetrieverNames }
