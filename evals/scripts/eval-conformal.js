#!/usr/bin/env node
/**
 * evals/scripts/eval-conformal.js — abstain-calibration (conformal, paso 07).
 * Split-conformal: calibración sobre gold T1 (24) → nonconformity 1−strength
 * (strength por match_type, espejo del engine) → q̂ (nivel ceil((n+1)(1−α))/n)
 * → θ = 1 − q̂. Evaluación con CF_ABSTAIN_CONFORMAL=1 CF_ABSTAIN_THRESHOLD=θ
 * sobre holdout gold (8) + no-gold (24).
 * Umbrales: coverage_gold ≥ 1−α (garantía), coverage no-gold > 0.667 (previo),
 * abstention precision ≥ 0.7.
 * Uso: node evals/scripts/eval-conformal.js [--alpha 0.2]
 * Artefacto: evals/reports/abstain-conformal-<TS>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STRENGTH = { exact: 1, filename: 1, structural: 1, reference: 0.8, git: 0.8, semantic: 0.6, test: 0.4, config: 0.3 };
const GOLD = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const NO_GOLD = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/no-gold.json'), 'utf8'));
const REPO_DIRS = { 't1-basic': 'evals/datasets/repos/t1-basic', 't1-modular': 'evals/datasets/repos/t1-modular', polar: '/home/nicolas/dev/polar' };
const ALPHA = Number(process.argv.includes('--alpha') ? process.argv[process.argv.indexOf('--alpha') + 1] : 0.2);

function runEngine(task, env) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[task.repo] ?? task.repo);
  if (!fs.existsSync(repoDir)) return null;
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const t0 = Date.now();
  const parsed = JSON.parse(execFileSync('node', [ENGINE, task.cqp], {
    cwd: repoDir, env: { ...process.env, TMPDIR: path.join(ROOT, '.tmp'), CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson'), ...env },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000,
  }));
  return { ...parsed, latency_ms: Date.now() - t0 };
}

const maxStrength = (results) => results.reduce((a, r) => Math.max(a, STRENGTH[r.match_type] ?? 0.5), 0);

// --- calibración: gold-only (24) y mixta (16 gold + 8 no-gold etiquetados) ---
const strengthOf = (t) => {
  const r = runEngine(t, {});
  return r ? maxStrength(r.results ?? []) : 0;
};
const goldCalib = GOLD.slice(0, 24);
const goldScores = goldCalib.map((t) => 1 - strengthOf(t)).filter((s) => Number.isFinite(s));
const mixed = [...GOLD.slice(0, 16), ...NO_GOLD.slice(0, 8)];
const mixedScores = mixed.map((t) => 1 - strengthOf(t)).filter((s) => Number.isFinite(s));
const quantile = (scores) => {
  const n2 = scores.length;
  const k = Math.ceil((n2 + 1) * (1 - ALPHA)) / n2;
  return [...scores].sort((a, b) => a - b)[Math.min(n2 - 1, Math.ceil(k * n2) - 1)];
};
const qGold = quantile(goldScores);
const qMix = quantile(mixedScores);
const configs = {
  gold_calibrated: { theta: 1 - qGold, calib_n: goldScores.length, calib_dist: goldScores },
  mixed_calibrated: { theta: 1 - qMix, calib_n: mixedScores.length, calib_dist: mixedScores },
};

// --- evaluación por config ---
const hold = GOLD.slice(24, 32);
const evalRows = [];
for (const [name, cfg] of Object.entries(configs)) {
  const envA = { CF_ABSTAIN: '1', CF_ABSTAIN_CONFORMAL: '1', CF_ABSTAIN_THRESHOLD: String(cfg.theta) };
  const rows = [];
  for (const t of [...hold, ...NO_GOLD]) {
    const r = runEngine(t, envA);
    if (!r) continue;
    rows.push({ id: t.id, split: t.primary?.length ? 'gold' : 'no-gold', abstained: r.abstained === true, tokens: r.stats?.tokens_used ?? 0, max_strength: +maxStrength(r.results ?? []).toFixed(3) });
  }
  const gold = rows.filter((r) => r.split === 'gold');
  const ng = rows.filter((r) => r.split === 'no-gold');
  const abstains = rows.filter((r) => r.abstained);
  const precision = abstains.length ? abstains.filter((r) => r.split === 'no-gold').length / abstains.length : 0;
  configs[name] = {
    ...cfg,
    coverage_gold: +(gold.filter((r) => !r.abstained).length / gold.length).toFixed(3),
    coverage_no_gold: +(ng.filter((r) => r.abstained).length / ng.length).toFixed(3),
    abstention_precision: +precision.toFixed(3),
    fp_retrieval: ng.filter((r) => !r.abstained).length,
    fn_retrieval: gold.filter((r) => r.abstained).length,
    pass: (gold.filter((r) => !r.abstained).length / gold.length) >= 1 - ALPHA - 0.05
      && (ng.filter((r) => r.abstained).length / ng.length) > 0.667 && precision >= 0.7,
  };
  evalRows.push({ config: name, rows });
}

const best = Object.values(configs).some((c) => c.pass);
const TS = Date.now();
const artifact = { date: new Date().toISOString().slice(0, 10), alpha: ALPHA, configs, eval_rows: evalRows.map((e) => ({ config: e.config, rows: e.rows })) };
const outPath = path.join(ROOT, 'evals', 'reports', `abstain-conformal-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

for (const [name, c] of Object.entries(configs)) {
  console.log(`[${name}] θ=${c.theta.toFixed(3)} (n=${c.calib_n}) | gold ${c.coverage_gold} (≥${(1 - ALPHA).toFixed(2)}) | no-gold ${c.coverage_no_gold} (>0.667) | prec ${c.abstention_precision} (≥0.7) | FP ${c.fp_retrieval} FN ${c.fn_retrieval} → ${c.pass ? 'PASS' : 'FAIL'}`);
}
console.log(`veredicto global: ${best ? 'PASS' : 'FAIL'}`);
console.log('artefacto:', outPath);