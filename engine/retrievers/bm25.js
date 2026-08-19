/**
 * engine/retrievers/bm25.js — BM25 lexical retrieval (task CQE-1).
 *
 * Concrete Retriever that wraps the engine's existing BM25 index + scripts/search-code.
 * Lexical search returns file-level matches → converted to Candidates.
 */

import { Retriever, Candidate } from '../retriever.js'
import { score as bm25Score } from '../bm25.js'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const SCRIPTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts')

export class Bm25Retriever extends Retriever {
  get name() { return 'bm25' }

  async retrieve(query, opts = {}) {
    const { budget = 8000 } = opts

    // Use existing scripts/search-code (rg) for lexical retrieval
    let raw = ''
    try {
      raw = execFileSync(
        path.join(SCRIPTS_DIR, 'search-code'),
        ['-n', '-l', '-d', '.', String(query)],
        { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }
      )
    } catch (e) {
      // rg returns exit 1 on no matches — not an error for us
      if (e.status === 1) return []
      console.error('Bm25Retriever: search-code failed:', e.message)
      return []
    }

    const lines = raw.split('\n').filter(Boolean)
    const candidates = lines.map(line => {
      // Format: path:line:content
      const m = line.match(/^(.+?):(\d+):(.*)$/)
      if (!m) return null
      return new Candidate({
        id: `${m[1]}:${m[2]}:0`,
        path: m[1],
        line_start: Number(m[2]),
        line_end: Number(m[2]),
        score: 0.0, // will be filled by BM25 scoring
        source: 'search-code',
        match_type: 'substring',
        snippet: m[3].slice(0, 200)
      })
    }).filter(Boolean)

    // Apply BM25 scoring if index available
    if (candidates.length > 0) {
      try {
        const scores = await bm25Score(query, candidates.map(c => c.path))
        if (scores && typeof scores === 'object') {
          candidates.forEach((c, i) => {
            if (scores[c.path] != null) c.score = scores[c.path]
          })
        }
      } catch (e) {
        // BM25 index may not exist — use rg's default scoring (0 or 1)
      }
    }

    // If BM25 didn't provide scores, use a simple rank (position-based)
    if (candidates.every(c => c.score === 0)) {
      candidates.forEach((c, i) => { c.score = 1.0 - i / Math.max(candidates.length, 1) })
    }

    return candidates.sort((a, b) => b.score - a.score)
  }
}
