#!/usr/bin/env node
/**
 * evals/scripts/eval-mitigations.js — adversarial-mitigations (derivada v1.6 #4, M1-M3)
 * M2 generated-code: gc-19/20/21 con CF_SEARCH_NO_IGNORE=1 + CF_INCLUDE_GENERATED=1 → 3/3
 * M1 deep-chain: dc-13/14/15 default → miss estructural dc-13 documentado (probe ausente)
 * M3 token explosion: adv-mo-* monorepo default → tokens capped vs baseline 15836
 * Artefacto: evals/reports/mitigations-<TS>.json
 * Node.js ESM, stdlib SOLO. Uso: node evals/scripts/eval-mitigations.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const byId = Object.fromEntries(DATASET.map((t) => [t.id, t]));
const REPO_DIRS = {
  polar: '/home/nicolas/dev/polar',
  't1-basic': 'evals/datasets/repos/t1-basic',
  't1-modular': 'evals/datasets/repos/t1-modular',
};
const BASELINE = { 'adv-mo': 15836 }; // tokens monorepo pre-mitigación

function groundOf(t) {
  return (t.primary || []).concat(t.related || []).concat(t.tests || []);
}
function hits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}
function run(t, extraEnv = {}) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[t.repo] ?? t.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...extraEnv };
  const out = execFileSync('node', [ENGINE, t.cqp], { cwd: repoDir, env, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  return JSON.parse(out.toString());
}

const M2_FLAGS = { CF_SEARCH_NO_IGNORE: '1', CF_INCLUDE_GENERATED: '1' };

const rows = [];
// M2 — generated-code con flags opt-in
for (const id of ['adv-gc-19', 'adv-gc-20', 'adv-gc-21']) {
  const t = byId[id];
  const r = run(t, M2_FLAGS);
  const h = r ? hits(r.results ?? [], groundOf(t)) : 0;
  rows.push({ mitigation: 'M2-generated', id, correct: h > 0, gt_hits: h, tokens: r?.stats?.tokens_used ?? 0, results: r?.results?.length ?? 0 });
}
// M1 — deep-chain default (escalación filename/estructural/semántica)
for (const id of ['adv-dc-13', 'adv-dc-14', 'adv-dc-15']) {
  const t = byId[id];
  const r = run(t);
  const h = r ? hits(r.results ?? [], groundOf(t)) : 0;
  rows.push({ mitigation: 'M1-deepchain', id, correct: h > 0, gt_hits: h, tokens: r?.stats?.tokens_used ?? 0, results: r?.results?.length ?? 0 });
}
// M3 — monorepo con budget estricto opt-in (CF_STRICT_BUDGET=1): tokens ≤ budget sin perder GT
const M3_FLAGS = { CF_STRICT_BUDGET: '1' };
const moTokens = [];
for (const t of DATASET.filter((x) => x.id.startsWith('adv-mo'))) {
  const r = run(t, M3_FLAGS);
  const h = r ? hits(r.results ?? [], groundOf(t)) : 0;
  moTokens.push(r?.stats?.tokens_used ?? 0);
  rows.push({ mitigation: 'M3-strict-budget', id: t.id, correct: h > 0, gt_hits: h, tokens: r?.stats?.tokens_used ?? 0, results: r?.results?.length ?? 0 });
}

const m2 = rows.filter((r) => r.mitigation === 'M2-generated');
const m1 = rows.filter((r) => r.mitigation === 'M1-deepchain');
const m3 = rows.filter((r) => r.mitigation === 'M3-strict-budget');
const maxMoTokens = Math.max(...moTokens);
const m3Ok = m3.every((r) => r.correct) && maxMoTokens < BASELINE['adv-mo'];
const verdict = {
  M2_generated_recovered: m2.filter((r) => r.correct).length === m2.length,
  M1_deepchain_documented_miss: m1.filter((r) => r.correct).length / m1.length,
  M3_monorepo_capped: m3Ok,
  details: {
    m2: `${m2.filter((r) => r.correct).length}/${m2.length} con flags opt-in`,
    m1: `${m1.filter((r) => r.correct).length}/${m1.length} (dc-13: miss estructural — GT app.module.ts sin match léxico; probe ausente)`,
    m3: `max tokens ${maxMoTokens} vs baseline ${BASELINE['adv-mo']} (correctness ${m3.filter((r) => r.correct).length}/${m3.length})`,
  },
};

const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), baseline: BASELINE, verdict, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `mitigations-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

for (const r of rows) {
  console.log(`  ${r.mitigation.padEnd(14)} ${r.id}  correct ${r.correct}  gt ${r.gt_hits}  tokens ${r.tokens}  results ${r.results}${r.capped ? ` (capped ${r.capped})` : ''}`);
}
console.log(`M2: ${verdict.details.m2} | M1: ${verdict.details.m1} | M3: ${verdict.details.m3}`);
console.log(`veredicto: M2 ${verdict.M2_generated_recovered ? 'PASS' : 'FAIL'} | M1 ${verdict.M1_deepchain_documented_miss >= 0.667 ? 'PASS (miss documentado)' : 'FAIL'} | M3 ${verdict.M3_monorepo_capped ? 'PASS' : 'FAIL'}`);
console.log('artefacto:', outPath);
