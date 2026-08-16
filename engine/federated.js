// Federated Evidence Sources — multi-plano con metadata (cost, latency, freshness, P/R)

const PLANES = {
  lexical: {
    id: 'lexical',
    impl: 'lexical-index',
    accessPath: 'index',
    costTokens: 50,
    latencyMs: 6,
    freshness: 'on-write',
    precision: 0.75,
    recall: 0.65,
    queryTypes: ['concept', 'pattern', 'default'],
    description: 'Full-text search via FTS5 (lexical)',
    evidenceType: 'lexical',
  },
  symbol: {
    id: 'symbol',
    impl: 'symbol-lookup',
    accessPath: 'index',
    costTokens: 40,
    latencyMs: 4,
    freshness: 'on-write',
    precision: 0.95,
    recall: 0.6,
    queryTypes: ['definitions', 'references', 'implementation', 'filename'],
    description: 'Structural symbols via regex extractors',
    evidenceType: 'structural',
  },
  dependency: {
    id: 'dependency',
    impl: 'dependency-expand',
    accessPath: 'index',
    costTokens: 80,
    latencyMs: 8,
    freshness: 'on-write',
    precision: 0.85,
    recall: 0.55,
    queryTypes: ['references', 'implementation'],
    description: 'Import/require dependency graph',
    evidenceType: 'reference',
  },
  callgraph: {
    id: 'callgraph',
    impl: 'search-structure',
    accessPath: 'disk',
    costTokens: 200,
    latencyMs: 20,
    freshness: 'live',
    precision: 0.7,
    recall: 0.4,
    queryTypes: ['references', 'implementation', 'callers'],
    description: 'Call graph via search-structure (rg)',
    evidenceType: 'reference',
  },
  history: {
    id: 'history',
    impl: 'git-log',
    accessPath: 'disk',
    costTokens: 120,
    latencyMs: 15,
    freshness: 'live',
    precision: 0.6,
    recall: 0.3,
    queryTypes: ['pattern', 'concept', 'default'],
    description: 'Git history authors/commits/paths',
    evidenceType: 'git',
  },
  test: {
    id: 'test',
    impl: 'include',
    accessPath: 'disk',
    costTokens: 80,
    latencyMs: 10,
    freshness: 'live',
    precision: 0.5,
    recall: 0.25,
    queryTypes: ['pattern', 'default'],
    description: 'Test files via include op',
    evidenceType: 'test',
  },
  semantic: {
    id: 'semantic',
    impl: 'bm25',
    accessPath: 'disk',
    costTokens: 400,
    latencyMs: 50,
    freshness: 'on-write',
    precision: 0.65,
    recall: 0.8,
    queryTypes: ['concept', 'pattern', 'default'],
    description: 'BM25 dense retrieval (disk index)',
    evidenceType: 'semantic',
  },
};

function planesForQueryType(queryType) {
  return Object.values(PLANES).filter((p) => p.queryTypes.includes(queryType));
}

function planesByAccessPath(accessPath) {
  return Object.values(PLANES).filter((p) => p.accessPath === accessPath);
}

function planeById(id) {
  return PLANES[id];
}

function planeStats() {
  return Object.values(PLANES).map((p) => ({
    id: p.id,
    accessPath: p.accessPath,
    costTokens: p.costTokens,
    latencyMs: p.latencyMs,
    freshness: p.freshness,
    precision: p.precision,
    recall: p.recall,
    queryTypes: p.queryTypes,
  }));
}

export { PLANES, planesForQueryType, planesByAccessPath, planeById, planeStats };
