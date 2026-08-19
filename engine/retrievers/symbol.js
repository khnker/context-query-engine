/**
 * engine/retrievers/symbol.js — Symbol retriever (structural) (task CQE-1).
 *
 * Wraps engine/index-ops.js symbolLookup to retrieve code symbols.
 * Returns Candidates for symbol definitions and references.
 */

import { Retriever, Candidate } from '../retriever.js'
import { symbolLookup, ensureIndex } from '../index-ops.js'
import fs from 'node:fs'
import path from 'node:path'

export class SymbolRetriever extends Retriever {
  get name() { return 'symbol' }

  async retrieve(query, opts = {}) {
    const { budget = 8000 } = opts

    // Ensure index exists (may be built on demand)
    try {
      await ensureIndex()
    } catch (e) {
      console.warn('SymbolRetriever: ensureIndex failed:', e.message)
      // Fall back to scripts/search-structure? For now, return empty
      return []
    }

    // Look up symbol by name (query)
    let symbols
    try {
      symbols = await symbolLookup(query)
    } catch (e) {
      console.error('SymbolRetriever: symbolLookup failed:', e.message)
      return []
    }

    if (!symbols || symbols.length === 0) return []

    // Convert symbols to Candidates
    return symbols.map(sym => {
      // Symbol shape from index-ops: { id, name, qualifiedName, filePath, line, ... }
      const filePath = sym.filePath || sym.qualifiedName?.split(':')[0] || ''
      const line = Number(sym.line || sym.startLine || 1)
      
      return new Candidate({
        id: sym.id || `${filePath}:${line}:${sym.name}`,
        path: filePath,
        line_start: line,
        line_end: line,
        score: 1.0, // Symbol matches are high-confidence structural hits
        source: 'symbol-lookup',
        match_type: 'symbol',
        snippet: `${sym.name} (${sym.qualifiedName || ''})`
      })
    }).sort((a, b) => b.score - a.score)
  }
}