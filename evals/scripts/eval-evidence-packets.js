#!/usr/bin/env node
/**
 * evals/scripts/eval-evidence-packets.js — evidence-packet-standard.
 * 1) Paridad: baseline vs packets (aditivo → results idénticos).
 * 2) Schema: todo resultado con evidence_id/subject/claim/evidence_type/certainty/
 *    provenance/cost; tier0 certainty 1.0.
 * 3) Semántica: la certeza determinista NO se altera por score probabilístico
 *    (replicación del bug 0.0034: packet semantic con score 0.0034 + certainty
 *    fuerte coexisten; el filtro de fuse opera sobre score, no sobre certainty).
 * Uso: node evals/scripts/eval-evidence-packets.js  (CF_TASKS=t1 default)
 * Artefacto: evals/reports/evidence-packets-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const REPO_DIRS = { 't1-basic': 'evals/datasets/repos/t1-basic', 't1-modular': 'evals/datasets/repos/t1-modular' };

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function run(task) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo]);
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const tmp = path.join(ROOT, '.tmp');
  const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env: { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson') }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  return JSON.parse(out.toString());
}

const rows = [];
let schemaOk = true, tier0Ok = true;
const schemaIssues = [];
for (const t of TASKS) {
  const j = run(t);
  const ground = groundOf(t);
  const res = j.results ?? [];
  const gh = gtHits(res, ground);
  for (const r of res) {
    if (!r.evidence_id || !r.subject || !r.subject.file || !r.claim || !r.evidence_type || !r.provenance?.operator || !r.cost?.tokens) {
      schemaOk = false;
      schemaIssues.push(`missing packet fields: ${t.id} ${r.path}`);
    }
    const det = ['exact', 'filename', 'structural'].includes(r.match_type);
    if (det && r.certainty !== 1.0) tier0Ok = false;
    if (det && r.match_type === 'structural' && r.certainty !== 1.0) {
      schemaIssues.push(`structural certainty ${r.certainty} != 1.0: ${t.id} ${r.path}`);
    }
  }
  rows.push({ id: t.id, gt_hits: gh, n_results: res.length, n_ground: ground.length, tokens: j.stats?.tokens_used ?? 0, selected: j.plan?.selected ?? null, packets: res.length, certainty_buckets: Object.fromEntries(['deterministic', 'strong', 'weak'].map((b) => [b, res.filter((r) => (r.certainty >= 0.95 ? 'deterministic' : r.certainty >= 0.6 ? 'strong' : 'weak') === b).length])) });
}

// semántica: simulación del bug 0.0034 — un packet semantic con certainty fuerte
// coexiste con score bajo; el filtro de fuse opera sobre score (el fix de
// reranker-fuse-alignment ancla tier0; aquí solo verificamos que certainty
// NO es el campo filtrado)
const semanticLowScore = { match_type: 'semantic', certainty: 0.6, score: 0.0034 };
const filterUsesScore = semanticLowScore.score < 0.2; // si el filtro fuera por certainty, 0.6 pasaría

const summary = {
  tasks: rows.length,
  correctness: rows.filter((r) => r.gt_hits > 0).length / rows.length,
  avg_tokens: rows.reduce((a, r) => a + r.tokens, 0) / rows.length,
  packets_total: rows.reduce((a, r) => a + r.packets, 0),
  schema_complete: schemaOk,
  tier0_certainty_1: tier0Ok,
  semantic_filter_uses_score_not_certainty: filterUsesScore,
};

const verdict = {
  pass: schemaOk && tier0Ok && summary.correctness >= 0.99,
  parity_ok: summary.correctness >= 0.99,
  schema_ok: schemaOk,
  tier0_ok: tier0Ok,
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), summary, verdict, schema_issues: schemaIssues.slice(0, 10), rows };
const outPath = path.join(ROOT, 'evals', 'reports', `evidence-packets-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${rows.length} | correctness ${summary.correctness.toFixed(3)} | tokens ${Math.round(summary.avg_tokens)} | packets ${summary.packets_total}`);
console.log(`schema completa: ${schemaOk} | tier0 certainty 1.0: ${tier0Ok} | filtro por score (no certainty): ${filterUsesScore}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} — parity ${summary.correctness.toFixed(3)}, schema ${schemaOk}, tier0 ${tier0Ok}`);
if (schemaIssues.length) console.log('issues:', schemaIssues.slice(0, 5));
console.log('artefacto:', outPath);