/**
 * engine/retrievers/federated.js — Structured data retriever (task CQE-1).
 *
 * Wraps engine/federated.js planesForQueryType to retrieve structured knowledge
 * about services, connections, decisions, etc. from the knowledge graph.
 */

import { Retriever, Candidate } from '../retriever.js'
import { planesForQueryType } from '../federated.js'
import fs from 'node:fs'
import path from 'node:path'

export class FederatedRetriever extends Retriever {
  get name() { return 'federated' }

  async retrieve(query, opts = {}) {
    const { budget = 8000 } = opts

    // Try to interpret query as a known query_type for federated data
    const qt = this._inferQueryType(query)
    if (!qt) return []

    // Get planes (structured data) for this query_type
    let planes
    try {
      planes = await planesForQueryType(qt)
    } catch (e) {
      console.error('FederatedRetriever: planesForQueryType failed:', e.message)
      return []
    }

    if (!planes || planes.length === 0) return []

    // Convert planes to Candidates
    return planes.map(plane => {
      // Plane shape from federated.js: { id, name, type, ... }
      const id = plane.id || plane.name || 'unknown'
      const name = plane.name || id
      const type = plane.type || 'service'

      return new Candidate({
        id: `${type}:${id}`,
        path: `knowledge/${type}/${id}.json`, // virtual path for display
        line_start: 1,
        line_end: 1,
        score: 0.8, // Structured knowledge is high-quality
        source: 'federated',
        match_type: type,
        snippet: `${name} (${type})${plane.description ? ': ' + plane.description.slice(0,100) : ''}`
      })
    }).sort((a, b) => b.score - a.score)
  }

  /** Heuristically map query to federated query_type */
  _inferQueryType(query) {
    const q = String(query || '').toLowerCase()

    if (/\b(servicio|service|api|endpoint|database|db|cola|queue)\b/.test(q))
      return 'services'

    if (/\b(decisión|decision|adr|arquitecture|architecture)\b/.test(q))
      return 'decisions'

    if (/\b(contrato|contract|api|endpoint|schema)\b/.test(q))
      return 'contracts'

    if (/\b(dominio|domain|business|área)\b/.test(q))
      return 'domains'

    if (/\b(componente|component|clase|class|módulo|module)\b/.test(q))
      return 'components'

    // Default: treat as general knowledge lookup
    return 'definitions'
  }
}