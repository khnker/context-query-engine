#!/usr/bin/env node
// eval-federated.js — evaluación B9: metadata de planos por query_type
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const TASKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');
const ADV = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'))
  .filter((t) => t.id.startsWith('adv-') && (t.repo === 't1-basic' || t.repo === 't1-modular'));
const all = [...TASKS.slice(0, 16), ...ADV.slice(0, 16)]; // 32 total

async function main() {
  const results = [];
  for (const task of all) {
    const cqp = task.cqp || `FIND ${task.query_type || 'concept'} OF symbol ${task.target?.name ?? task.query}`;
    const repoDir = path.join(ROOT, 'evals/datasets/repos', task.repo || 't1-basic');
    const env = { ...process.env };
    try {
      const out = execFileSync('node', [ENGINE, cqp], {
        cwd: repoDir,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60000,
      });
      const res = JSON.parse(out.trim());
      const fed = res.stats?.federated;
      if (fed) {
        results.push({
          id: task.id,
          query_type: fed.query_type,
          planes: fed.planes.map((p) => ({
            id: p.id,
            accessPath: p.accessPath,
            costTokens: p.costTokens,
            latencyMs: p.latencyMs,
            precision: p.precision,
            recall: p.recall,
          })),
        });
      }
    } catch (e) {
      console.error(`[${task.id}] ERROR:`, e.message);
    }
  }
  const ts = Date.now();
  fs.writeFileSync(path.join(ROOT, 'evals/reports/federated-' + ts + '.json'), JSON.stringify({ ts, results, count: results.length }, null, 2));
  console.log(`federated-${ts}.json: ${results.length} tasks`);
}
main().catch((e) => { console.error(e); process.exit(1); });
