#!/usr/bin/env node
/**
 * eval-generated-code.js — B14 generated-code-default-policy.
 * Matriz empírica OFF (default) / ON (CF_INCLUDE_GENERATED) / ON+NO_IGNORE:
 * - recall sobre tasks generated-code (adversarial.json categoria generated-code)
 * - ruido: tokens y nº rows en control T1 (tasks.json t1-basic/t1-modular)
 * - contract: rows con path generado marcan provenance.generated (B14 3.1)
 * Veredicto: mantener default OFF solo si ON no gana recall GC y sí añade ruido.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(ROOT, 'engine', 'engine.js');
const CACHE = path.join(ROOT, 'engine', '.cache.json');
const STATS = path.join(ROOT, 'engine', 'telemetry.ndjson');
const NODE = '/home/nicolas/.nvm/versions/node/v24.16.0/bin/node';

const GC = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/adversarial.json'), 'utf8'))
  .filter((t) => t.category === 'generated-code');
const CONTROL = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/datasets/tasks.json'), 'utf8'))
  .filter((t) => t.repo === 't1-basic' || t.repo === 't1-modular');

const REPO_DIRS = {
  polar: '/home/nicolas/dev/polar',
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'),
};

const CONFIGS = {
  off: {},
  on: { CF_INCLUDE_GENERATED: '1' },
  on_noignore: { CF_INCLUDE_GENERATED: '1', CF_SEARCH_NO_IGNORE: '1' },
};

function run(cqp, repo, extraEnv) {
  const repoDir = REPO_DIRS[repo];
  if (!repoDir || !fs.existsSync(repoDir)) return null;
  fs.rmSync(CACHE, { force: true });
  const tmp = path.join(repoDir, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, CF_STATS_FILE: STATS, ...extraEnv };
  try {
    const out = execFileSync(NODE, [ENGINE, cqp], {
      cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024, timeout: 60000,
    });
    return JSON.parse(out.trim());
  } catch (e) {
    return { error: String(e.message) };
  }
}

const rowsOf = (r) => (r && !r.error ? (r.results ?? []) : []);
const hit = (rows, primary) => rows.some((x) => {
  const f = (x.path || '').replace(/^\.\//, '');
  return primary.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
});
const isGen = (x) => /(^|\/)(dist|build|vendor|generated|coverage)(\/|$)/.test(x.path ?? '');

const out = { configs: {}, gc: [], control: {}, contract: {} };
for (const [name, env] of Object.entries(CONFIGS)) {
  let gcHit = 0, gcN = 0, gcTokens = 0, gcRows = 0;
  let ctrlTokens = 0, ctrlRows = 0, ctrlN = 0, ctrlGenRows = 0;
  let provOk = 0, provTotal = 0;
  const gcDetails = [];
  for (const t of GC) {
    const r = run(t.cqp, t.repo, env);
    if (!r) { gcDetails.push({ id: t.id, repo: t.repo, skipped: 'repo no disponible' }); continue; }
    if (r.error) { gcDetails.push({ id: t.id, repo: t.repo, error: r.error }); continue; }
    const rows = rowsOf(r);
    gcN += 1;
    if (hit(rows, t.primary)) gcHit += 1;
    gcTokens += r.stats?.tokens_used ?? 0;
    gcRows += rows.length;
    for (const row of rows) {
      if (isGen(row)) {
        provTotal += 1;
        if (row.provenance?.generated === true) provOk += 1;
      }
    }
    gcDetails.push({ id: t.id, repo: t.repo, found: hit(rows, t.primary), rows: rows.length, tokens: r.stats?.tokens_used ?? 0 });
  }
  for (const t of CONTROL) {
    const r = run(t.cqp, t.repo, env);
    if (!r || r.error) continue;
    const rows = rowsOf(r);
    ctrlN += 1;
    ctrlTokens += r.stats?.tokens_used ?? 0;
    ctrlRows += rows.length;
    ctrlGenRows += rows.filter((x) => isGen(x)).length;
  }
  out.configs[name] = {
    gc_recall: gcN ? gcHit / gcN : null,
    gc_tasks: gcN,
    gc_avg_tokens: gcN ? +(gcTokens / gcN).toFixed(1) : null,
    gc_avg_rows: gcN ? +(gcRows / gcN).toFixed(1) : null,
    control_tasks: ctrlN,
    control_avg_tokens: ctrlN ? +(ctrlTokens / ctrlN).toFixed(1) : null,
    control_avg_rows: ctrlN ? +(ctrlRows / ctrlN).toFixed(1) : null,
    control_generated_rows: ctrlGenRows,
    provenance_generated_ok: provTotal ? `${provOk}/${provTotal}` : 'n/a',
  };
  out.gc.push(...gcDetails.map((d) => ({ ...d, config: name })));
}
out.contract = {
  check: 'rows generadas marcan provenance.generated (B14 3.1)',
  pass: out.configs.on_noignore.provenance_generated_ok !== 'n/a' && !out.configs.on_noignore.provenance_generated_ok.endsWith('0/'),
  detail: out.configs.on_noignore.provenance_generated_ok,
};

const OFF = out.configs.off, ON = out.configs.on;
const gain = ON.gc_recall - OFF.gc_recall;
const noise = (ON.control_avg_tokens ?? 0) - (OFF.control_avg_tokens ?? 0);
out.verdict = {
  pass: gain > 0 ? noise <= 0 : true,
  policy: gain > 0 && noise <= 0 ? 'ON' : (gain > 0 ? 'ON solo consultas a artifacts (opt-in)' : 'OFF default'),
  delta_gc_recall: gain,
  delta_control_tokens: +noise.toFixed(1),
  note: gain > 0 ? 'ON añade recall GC sin ruido → adoptar' : 'ON no añade recall GC (y/o añade ruido) → mantener OFF default con opt-in',
};

const TS = Date.now();
const reportPath = path.join(ROOT, 'evals', 'reports', `generated-code-${TS}.json`);
fs.writeFileSync(reportPath, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ ...out, verdict: out.verdict }, null, 2));