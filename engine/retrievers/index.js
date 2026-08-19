/**
 * engine/retrievers/index.js — Export all retriever implementations
 * Used by engine/engine.js and intent-planner.js for dynamic loading
 */

export { Bm25Retriever } from './bm25.js'
export { SymbolRetriever } from './symbol.js'
export { FederatedRetriever } from './federated.js'
// TODO: semantic, lexical (alias to bm25?), git-history, etc.

// Convenience map: name → class
export const retrieverMap = {
  bm25: Bm25Retriever,
  symbol: SymbolRetriever,
  federated: FederatedRetriever
  // semantic: SemanticRetriever,
  // lexical: Bm25Retriever, // alias
  // 'git-history': GitHistoryRetriever,
}