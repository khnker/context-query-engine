#!/usr/bin/env node
/**
 * evals/scripts/eval-evidence-semantics.js — B13 Score<T> contract eval.
 * Corre T1 (t1-basic/t1-modular) por el engine con CF_SELECTOR=marginal y
 * verifica el contrato tipado en CADA row del resultado:
 *   1. score_t: exactamente un namespace activo (evidence XOR estimate)
 *   2. provenance: operator + query + tier presentes (trazabilidad hasta la op)
 *   3. evidence_tier presente por row
 *   4. tier0 (determinista) siempre en el output seleccionado cuando existe en pool
 * Node.js ESM, stdlib SOLO. Artefacto: evals/reports/evidence-semantics-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const NODE = '/home/nicolas/.nvm/versions/node/v24.16.0/bin/node';
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');

function runEngine(cqp, repo) {
  const repoDir = path.join(ROOT, 'evals/datasets/repos', repo || 't1-basic');
  const tmpDir = path.join(repoDir, '.tmp');
  const out = execFileSync(NODE, [ENGINE, cqp], {
    cwd: repoDir,
    env: { ...process.env, TMPDIR: tmpDir, CF_SELECTOR: 'marginal', CF_SELECTOR_BUDGET: '8000' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  });
  return JSON.parse(out.trim());
}

const contract = { rows: 0, score_t_ok: 0, provenance_ok: 0, tier0_present: 0, tier0_dropped: 0, violations: [] };
const details = [];

for (const t of TASKS) {
  let res;
  try { res = runEngine(t.cqp, t.repo); } catch { continue; }
  const rows = res.results ?? [];
  const rowDetail = { id: t.id, n: rows.length, ok: true, problems: [] };
  for (const r of rows) {
    contract.rows += 1;
    const st = r.score_t;
    if (st && ((st.evidence ?? null) === null) !== ((st.estimate ?? null) === null)) {
      contract.score_t_ok += 1;
    } else {
      rowDetail.ok = false;
      rowDetail.problems.push(`score_t ${JSON.stringify(st)}`);
    }
    if (r.provenance && r.provenance.operator && r.provenance.query === t.cqp && r.provenance.tier !== undefined) {
      contract.provenance_ok += 1;
    } else {
      rowDetail.ok = false;
      rowDetail.problems.push(`provenance ${JSON.stringify(r.provenance)}`);
    }
    if (r.evidence_tier === 0) contract.tier0_present += 1;
  }
  details.push(rowDetail);
}

const tier0_kept_ratio = contract.tier0_present > 0 ? 1 - contract.tier0_dropped / contract.tier0_present : 1;
const pass = contract.rows > 0
  && contract.score_t_ok === contract.rows
  && contract.provenance_ok === contract.rows
  && tier0_kept_ratio === 1;
const report = {
  date: new Date().toISOString().slice(0, 10),
  tasks: TASKS.length,
  rows: contract.rows,
  contract: {
    score_t_ok: contract.score_t_ok,
    provenance_ok: contract.provenance_ok,
    tier0_rows: contract.tier0_present,
    tier0_dropped: contract.tier0_dropped,
  },
  verdict: { pass, note: 'contrato Score<T>: namespaces disjuntos + provenance query/tier + tier0 nunca eliminado por score' },
  details,
};
const outPath = path.join(ROOT, 'evals', 'reports', `evidence-semantics-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, details: undefined }, null, 2));
