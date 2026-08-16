#!/usr/bin/env node
/**
 * evals/scripts/eval-ib-metrics.js — Information Bottleneck Metrics (B5).
 * Métrica primaria: task-information density = Δ task success / Δ token
 * (y success/token por config). Se computa sobre artefactos EXISTENTES
 * (downstream-agent + context-selection MMR) — no re-corre el engine.
 * Re-expresa thresholds de budget como trade-offs de utilidad (2.1).
 * Artefacto: evals/reports/information-bottleneck-<TS>.json
 * Node.js ESM, stdlib SOLO. Uso: node evals/scripts/eval-ib-metrics.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOWN = path.join(ROOT, 'evals/reports/downstream-1786825239594.json');
const SSM = path.join(ROOT, 'evals/reports/ssm-1786907248487.json');

const out = { date: new Date().toISOString().slice(0, 10) };

// --- downstream: Δsuccess/Δtokens + success-per-token ---
const down = JSON.parse(fs.readFileSync(DOWN, 'utf8'));
const raw = down.summary.raw, cqe = down.summary.cqe;
const dSuccess = cqe.task_success - raw.task_success;
const dTokens = cqe.mean_tokens - raw.mean_tokens;
const densityDown = dSuccess / Math.max(1, dTokens);
out.downstream = {
  raw: { task_success: raw.task_success, mean_tokens: raw.mean_tokens, task_info_per_token: raw.success_per_token },
  cqe: { task_success: cqe.task_success, mean_tokens: cqe.mean_tokens, task_info_per_token: cqe.success_per_token },
  delta: { d_success: +dSuccess.toFixed(4), d_tokens: +dTokens.toFixed(2), density_dsuccess_dtoken: +densityDown.toFixed(6) },
  reading: 'CQE aporta +25pp success a costa de +104 tokens; densidad marginal 0.0024 success/token — a budget igual (349 vs 244), CQE domina (1.000 vs 0.750 de task success con la MISMA info/token ~0.0029)',
};

// --- context-selection: densidad por budget/modo (gt/tokens) ---
const ssm = JSON.parse(fs.readFileSync(SSM, 'utf8'));
const byBudget = {};
for (const b of ssm.budgets) {
  const agg = { topk: { gt: 0, tokens: 0 }, marginal: { gt: 0, tokens: 0 }, mmr: { gt: 0, tokens: 0 } };
  for (const r of ssm.rows) {
    for (const mode of ['topk', 'marginal', 'mmr']) {
      agg[mode].gt += r[String(b)]?.[mode]?.gt ?? 0;
      agg[mode].tokens += r[String(b)]?.[mode]?.tokens ?? 0;
    }
  }
  byBudget[b] = Object.fromEntries(Object.entries(agg).map(([mode, v]) => [
    mode, { gt: v.gt, tokens: v.tokens, density: +(v.gt / Math.max(1, v.tokens)).toFixed(6) },
  ]));
}
out.context_selection = byBudget;
const tight = byBudget[400];
out.tradeoff = {
  '400 tight': { topk_density: tight.topk.density, mmr_density: tight.mmr.density, winner: tight.mmr.density >= tight.topk.density ? 'mmr' : 'topk' },
  note: 'Thresholds de budget re-expresados como utilidad/token: a budget igual gana la config de mayor density; tokens ≤ 8000 solo establece el cap, no la calidad',
};

const TS = Date.now();
const artifact = { ...out, sources: { downstream: 'downstream-1786825239594.json', context_selection: 'ssm-1786907248487.json' } };
const outPath = path.join(ROOT, 'evals/reports/information-bottleneck-' + TS + '.json');
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log('downstream: raw success/token', raw.success_per_token.toFixed(5), '| cqe', cqe.success_per_token.toFixed(5), '| Δsuccess/Δtokens', densityDown.toFixed(6));
for (const b of ssm.budgets) {
  const x = byBudget[b];
  console.log(`  budget ${b}: topk ${x.topk.density.toFixed(6)} | marginal ${x.marginal.density.toFixed(6)} | mmr ${x.mmr.density.toFixed(6)}`);
}
console.log('tradeoff@400 winner:', out.tradeoff['400 tight'].winner);
console.log('artefacto:', outPath);