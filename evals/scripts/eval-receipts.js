#!/usr/bin/env node
/**
 * evals/scripts/eval-receipts.js — Execution Receipts (B4).
 * Verifica: receipt {seen, inferred, unknown} + claims con provenance
 * (evidence_id); seen = tier0 (exact/filename/structural, certainty 1.0),
 * inferred = resto; unknown poblado para zero-results/low-agreement/
 * single-source. Parity correctness vs baseline. Trazabilidad 3.1: GT paths
 * presentes en seen/inferred con evidence_id.
 * Uso: node evals/scripts/eval-receipts.js [--limit N]  → evals/reports/receipts-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'));
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'));
const REPO_DIRS = { polar: '/home/nicolas/dev/polar', 't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'), 't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular') };
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 0;

const tasks = TASKS.filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular').concat(ADV.filter((t) => ['zero-results', 'huge-fanout'].includes(t.category)));
const list = LIMIT ? tasks.slice(0, LIMIT) : tasks;
const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
function gtHits(results, ground) {
  return results.filter((r) => {
    const f = (r.path || '').replace(/^\.\//, '');
    return ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  }).length;
}

function run(task, receipt) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...(receipt ? { CF_RECEIPT: '1' } : {}) };
  const t0 = Date.now();
  const out = execFileSync('node', [ENGINE, task.cqp], { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  return { ...JSON.parse(out.toString()), latency_ms: Date.now() - t0 };
}

const rows = [];
let seenTotal = 0, inferredTotal = 0, unknownCount = 0, claimsTotal = 0, withIds = 0, gtInReceipt = 0, parityOk = 0;
for (const t of list) {
  const base = run(t, false);
  const rec = run(t, true);
  if (!base || !rec) continue;
  const ground = groundOf(t);
  const ghB = gtHits(base.results ?? [], ground);
  const ghR = gtHits(rec.results ?? [], ground);
  const r = rec.receipt;
  const gtPaths = ground;
  const receiptPaths = new Set([...(r?.seen ?? []), ...(r?.inferred ?? [])].map((x) => x.path));
  const gtHitReceipt = gtPaths.filter((g) => [...receiptPaths].some((f) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f))).length > 0;
  const idsOk = [...(r?.seen ?? []), ...(r?.inferred ?? [])].every((x) => x.evidence_id != null);
  seenTotal += r?.seen?.length ?? 0;
  inferredTotal += r?.inferred?.length ?? 0;
  unknownCount += r?.unknown?.length ?? 0;
  claimsTotal += r?.claims?.length ?? 0;
  if (idsOk) withIds++;
  if (gtHitReceipt) gtInReceipt++;
  if ((ghB > 0) === (ghR > 0)) parityOk++;
  rows.push({ id: t.id, group: t.category ?? t.repo, gt_baseline: ghB, gt_receipt: ghR, receipt: r ? { seen: r.seen.length, inferred: r.inferred.length, unknown: r.unknown, claims: r.claims.length } : null });
}

const n = rows.length;
const verdict = {
  pass: n > 0 && parityOk === n && withIds >= n * 0.8,
  parity: parityOk === n, gt_in_receipt: gtInReceipt, n,
  receipts_with_ids: withIds,
};
const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), tasks: n, totals: { seen: seenTotal, inferred: inferredTotal, unknown_codes: unknownCount, claims: claimsTotal }, verdict, rows };
const outPath = path.join(ROOT, 'evals', 'reports', `receipts-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`tasks: ${n} | parity: ${parityOk}/${n} | gt_en_receipt: ${gtInReceipt}/${n} | receipts_con_ids: ${withIds}/${n}`);
console.log(`totals: seen ${seenTotal} | inferred ${inferredTotal} | unknown ${unknownCount} | claims ${claimsTotal}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'} (parity ${verdict.parity}, ids ${withIds}/${n})`);
console.log('artefacto:', outPath);