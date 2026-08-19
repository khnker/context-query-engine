/**
 * engine/retriever.js — Retriever interface + implementations (task CQE-1).
 *
 * The Retriever abstracts away different search strategies (lexical, structural,
 * semantic, symbol lookup). Each retriever implements `retrieve(query, opts)`
 * and returns a standardized Candidate[] that the optimizer + reranker can process.
 *
 * Candidate shape:
 *   { id, path, line_start, line_end, score, source, match_type, snippet }
 *
 * Retrievers can be combined via hybrid retrieval (parallel execution, then
 * reranking). The design intentionally avoids a single embedding-based approach
 * in favor of hybrid lexical + semantic + structural signals (see CQE phases 1–3).
 */

export class Retriever {
  /**
   * Retrieve candidates for a given query.
   * @param {string} query - The user query / intent
   * @param {object} opts - Optional: {budget, limit, context}
   * @returns {Promise<Candidate[]>} Sorted by descending score (pre-rerank)
   */
  retrieve(query, opts = {}) {
    throw new Error(`retrieve() not implemented in ${this.constructor.name}`)
  }

  /** Human-readable name of this retriever (for logs/debugging) */
  get name() { return this.constructor.name }
}

/**
 * Standardized candidate result from any retriever.
 * All scores are pre-rerank (raw tool output values).
 */
export class Candidate {
  /**
   * @param {object} fields
   * @param {string} fields.id - Unique identifier (usually `path:line_start:line_end`)
   * @param {string} fields.path - File path relative to repo root
   * @param {number} fields.line_start - 1-indexed start line
   * @param {number} fields.line_end - 1-indexed end line
   * @param {number} fields.score - Raw relevance score (pre-rerank)
   * @param {string} fields.source - e.g. "search-code", "symbol-lookup", "bm25"
   * @param {string} fields.match_type - e.g. "substring", "symbol", "semantic"
   * @param {string} fields.snippet - Short text excerpt around the match
   */
  constructor({ id, path, line_start, line_end, score, source, match_type, snippet } = {}) {
    this.id = id || ''
    this.path = path || ''
    this.line_start = line_start != null ? Math.max(1, line_start) : 1
    this.line_end = line_end != null ? Math.max(this.line_start, line_end) : this.line_start
    this.score = Number.isFinite(score) ? score : 0
    this.source = source || 'unknown'
    this.match_type = match_type || 'unknown'
    this.snippet = snippet || ''
  }

  /** Full file path + line range for display */
  get key() { return `${this.path}:${this.line_start}-${this.line_end}` }

  /** Human-readable description */
  get desc() { return `${this.source} @ ${this.key} (score: ${this.score.toFixed(2)})` }
}

/**
 * Score contributions used by the Reranker.
 * Each retriever may expose its own score schema; the reranker normalizes
 * them into a unified { relevance, coverage, sourceQuality, confidence } model.
 */
export const ScoreContribution = {
  /** Lexical match quality (0–1, from tool output) */
  relevance: 0,
  /** How much of the query is addressed (0–1, estimated from matches) */
  coverage: 0,
  /** Source trustworthiness / quality (0–1, from config / metadata) */
  sourceQuality: 0,
  /** Intent / planning confidence (0–1, from Interpreter) */
  confidence: 0
}

/**
 * Reranker — combines multiple ScoreContribution sources into a final rank.
 * Supports interchangeable strategies: rule-based, CrossEncoder, LLM-based.
 *
 * The default implementation is a weighted sum:
 *   final = w_relevance * relevance
 *         + w_coverage * coverage
 *         + w_sourceQuality * sourceQuality
 *         + w_confidence * confidence
 *
 * Weights default to [0.4, 0.3, 0.2, 0.1] favoring relevance + coverage.
 */
export class Reranker {
  constructor({ weights } = {}) {
    // Weights: [relevance, coverage, sourceQuality, confidence]
    this.weights = weights || [0.4, 0.3, 0.2, 0.1]
    if (this.weights.length !== 4) {
      console.warn('Reranker: weights should be an array of 4 numbers')
    }
  }

  /**
   * Rerank a list of Candidates using combined scores.
   * @param {Candidate[]} candidates - Unsorted (pre-rerank scores)
   * @param {object} context - Additional context: { intentConfidence, ... }
   * @returns {Candidate[]} Sorted by descending final score
   */
  rerank(candidates, context = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return candidates

    return candidates.map(c => {
      // Normalize each contribution to 0–1 if not already
      const rel = Math.max(0, Math.min(1, c.score))
      const cov = Math.max(0, Math.min(1, context.coverage || 0.5))
      const sq = Math.max(0, Math.min(1, context.sourceQuality || 0.5))
      const cf = Math.max(0, Math.min(1, context.intentConfidence || 0.5))

      // Weighted sum
      const final =
        this.weights[0] * rel +
        this.weights[1] * cov +
        this.weights[2] * sq +
        this.weights[3] * cf

      // Preserve original score but attach final
      c.score = final
      return c
    }).sort((a, b) => b.score - a.score)
  }
}

/**
 * Hybrid retrieval entry point.
 * Runs multiple retrievers in parallel, gathers candidates, then reranks.
 *
 * @param {Retriever[]} retrievers - List of initialized retrievers
 * @param {string} query - The user query
 * @param {object} opts - { budget, limit, intentConfidence?, sourceQuality? }
 * @returns {Promise<{candidates: Candidate[], reranker: Reranker, perRetriever: Record<string, Candidate[]}>}}
 */
export async function hybridRetrieval(retrievers, query, opts = {}) {
  const { budget = 8000, limit = 50, intentConfidence = 0.5, sourceQuality = 0.5 } = opts

  // Run all retrievers in parallel
  const retrievePromises = retrievers.map(r => r.retrieve(query, { budget }))
  const results = await Promise.allSettled(retrievePromises)

  // Collect candidates per retriever
  const perRetriever = {}
  retrievers.forEach((r, i) => {
    if (results[i].status === 'fulfilled') {
      perRetriever[r.name] = results[i].value
    } else {
      console.error(`Retriever ${r.name} failed:`, results[i].reason)
      perRetriever[r.name] = []
    }
  })

  // Flatten, deduplicate by id, then rerank
  const all = []
  const seenIds = new Set()

  for (const r of retrievers) {
    for (const c of perRetriever[r.name] || []) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id)
        all.push(c)
      }
    }
  }

  // Apply reranker
  const reranker = new Reranker({
    weights: [0.4, 0.3, 0.2, 0.1],
    // Inject context from planning
    sourceQuality: sourceQuality,
    intentConfidence: intentConfidence
  })

  const ranked = reranker.rerank(all, { coverage: 0.5, intentConfidence: intentConfidence })

  // Limit results
  return {
    candidates: ranked.slice(0, limit),
    reranker,
    perRetriever
  }
}