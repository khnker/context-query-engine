#!/usr/bin/env node
// eval-external.js — B10: ContextBench (explored vs used) + ARB no-gold calibration
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');

const CB_TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/contextbench.json'), 'utf8'));
const ARB_TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/arb.json'), 'utf8'));

function runEngine(cqp, repo) {
  const repoDir = path.join(ROOT, 'evals/datasets/repos', repo || 't1-basic');
  const tmpDir = path.join(repoDir, '.tmp');
  const out = execFileSync('/home/nicolas/.nvm/versions/node/v24.16.0/bin/node', [ENGINE, cqp], {
    cwd: repoDir,
    env: { ...process.env, TMPDIR: tmpDir, PATH: process.env.PATH },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  });
  return JSON.parse(out.trim());
}

function getRetrievedFiles(result) {
  const files = new Set();
  // Engine returns results at top-level 'results' property
  if (result.results) {
    for (const r of result.results) {
      if (r.path) files.add(r.path);
    }
  }
  // Also check assembled.context if present
  if (result.assembled?.context) {
    for (const [file] of Object.entries(result.assembled.context)) {
      files.add(file);
    }
  }
  return Array.from(files);
}

function computeExploredRecall(task, retrieved) {
  if (!task.explored?.length) return null;
  const exploredSet = new Set(task.explored.map(f => path.basename(f)));
  const retrievedSet = new Set(retrieved.map(f => path.basename(f)));
  let hits = 0;
  for (const e of exploredSet) {
    if (retrievedSet.has(e)) hits++;
  }
  return hits / exploredSet.size;
}

function computeUsedPrecision(task, retrieved) {
  if (!task.used?.length) return null;
  const usedSet = new Set(task.used.map(f => path.basename(f)));
  const retrievedSet = new Set(retrieved.map(f => path.basename(f)));
  let hits = 0;
  for (const r of retrievedSet) {
    if (usedSet.has(r)) hits++;
  }
  return hits / retrievedSet.size;
}

function computeAbstainRate(tasks, results) {
  let totalNoGold = 0;
  let correctAbstain = 0;
  for (let i = 0; i < tasks.length; i++) {
    if (!tasks[i].has_answer) {
      totalNoGold++;
      const retrieved = getRetrievedFiles(results[i]);
      if (retrieved.length === 0) correctAbstain++;
    }
  }
  return totalNoGold > 0 ? correctAbstain / totalNoGold : null;
}

async function main() {
  console.log('=== B10 External Agent Benchmarks ===');
  console.log(`ContextBench tasks: ${CB_TASKS.length}`);
  console.log(`ARB tasks: ${ARB_TASKS.length}`);
  console.log('');

  // ContextBench evaluation
  console.log('--- ContextBench (explored vs used) ---');
  const cbResults = [];
  let cbExploredSum = 0, cbUsedSum = 0, cbDeltaSum = 0;
  let cbValidExplored = 0, cbValidUsed = 0;

  for (let i = 0; i < CB_TASKS.length; i++) {
    const task = CB_TASKS[i];
    console.error(`[DEBUG] Running CB task ${i+1}/${CB_TASKS.length}: ${task.id}`);
    const res = runEngine(task.cqp, task.repo);
    console.error(`[DEBUG] Done CB task ${i+1}`);
    const retrieved = getRetrievedFiles(res);
    const exploredRecall = computeExploredRecall(task, retrieved);
    const usedPrecision = computeUsedPrecision(task, retrieved);
    const delta = (exploredRecall !== null && usedPrecision !== null) ? exploredRecall - usedPrecision : null;

    cbResults.push({ id: task.id, exploredRecall, usedPrecision, delta, retrieved: retrieved.length });
    console.log(`  ${task.id}: explored=${exploredRecall?.toFixed(3) ?? 'N/A'} used=${usedPrecision?.toFixed(3) ?? 'N/A'} delta=${delta?.toFixed(3) ?? 'N/A'} retrieved=${retrieved.length}`);

    if (exploredRecall !== null) { cbExploredSum += exploredRecall; cbValidExplored++; }
    if (usedPrecision !== null) { cbUsedSum += usedPrecision; cbValidUsed++; }
    if (delta !== null) cbDeltaSum += delta;
  }

  const cbAvgExplored = cbValidExplored ? cbExploredSum / cbValidExplored : null;
  const cbAvgUsed = cbValidUsed ? cbUsedSum / cbValidUsed : null;
  const cbAvgDelta = cbValidExplored ? cbDeltaSum / cbValidExplored : null;

  console.log(`  AVG explored_recall: ${cbAvgExplored?.toFixed(3) ?? 'N/A'}`);
  console.log(`  AVG used_precision: ${cbAvgUsed?.toFixed(3) ?? 'N/A'}`);
  console.log(`  AVG delta (explored - used): ${cbAvgDelta?.toFixed(3) ?? 'N/A'}`);
  console.log('');

  // ARB evaluation
  console.log('--- ARB (no-gold calibration) ---');
  const arbResults = [];
  for (const task of ARB_TASKS) {
    const res = runEngine(task.cqp, task.repo);
    const retrieved = getRetrievedFiles(res);
    const abstained = retrieved.length === 0;
    const correct = task.expected_abstain === abstained;
    arbResults.push({ id: task.id, has_answer: task.has_answer, expected_abstain: task.expected_abstain, abstained, correct });
    console.log(`  ${task.id}: has_answer=${task.has_answer} expected_abstain=${task.expected_abstain} abstained=${abstained} correct=${correct}`);
  }

  const abstainRate = computeAbstainRate(ARB_TASKS, arbResults);
  const calibrationCorrect = arbResults.filter(r => r.correct).length;
  const calibrationTotal = arbResults.length;
  console.log(`  Abstention rate on no-gold queries: ${abstainRate?.toFixed(3) ?? 'N/A'}`);
  console.log(`  Calibration accuracy: ${calibrationCorrect}/${calibrationTotal} = ${(calibrationCorrect/calibrationTotal).toFixed(3)}`);
  console.log('');

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`ContextBench: explored_recall=${cbAvgExplored?.toFixed(3) ?? 'N/A'} used_precision=${cbAvgUsed?.toFixed(3) ?? 'N/A'} delta=${cbAvgDelta?.toFixed(3) ?? 'N/A'}`);
  console.log(`ARB: calibration_accuracy=${(calibrationCorrect/calibrationTotal).toFixed(3)} abstain_rate=${abstainRate?.toFixed(3) ?? 'N/A'}`);

  // Write report
  const report = {
    timestamp: new Date().toISOString(),
    contextbench: {
      tasks: CB_TASKS.length,
      avg_explored_recall: cbAvgExplored,
      avg_used_precision: cbAvgUsed,
      avg_delta: cbAvgDelta,
      details: cbResults,
    },
    arb: {
      tasks: ARB_TASKS.length,
      calibration_accuracy: calibrationCorrect / calibrationTotal,
      abstain_rate: abstainRate,
      details: arbResults,
    },
  };

  const reportPath = path.join(ROOT, 'evals/reports', `external-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });