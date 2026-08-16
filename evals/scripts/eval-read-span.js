#!/usr/bin/env node
/*
 * evals/scripts/eval-read-span.js — read-span-op (A2).
 * READ_SPAN materializa span (línea del símbolo ± ventana) vs archivo completo.
 * Por task T1: engine default → top result path → localizar símbolo (rg -n) →
 * span [l-2, l+8] → tokens span vs file. Métricas: reduction, span_hit,
 * correctness parity. Veredicto: reduction >= 0.5 && correctness == baseline.
 * Artefacto: evals/reports/read-span-<TS>.json
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
const REPO_DIRS = {
  't1-basic': path.join(ROOT, 'evals/datasets/repos/t1-basic'),
  't1-modular': path.join(ROOT, 'evals/datasets/repos/t1-modular'),
};
const WIN = 8; // l-2 .. l+WIN

const groundOf = (t) => (t.primary || []).concat(t.related || []).concat(t.tests || []);
const nameOf = (t) => {
  const m = /OF\s+(?:symbol|function|class|constant|file|concept)\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s+LIMIT/i.exec(t.cqp ?? '');
  return m ? (m[1] ?? m[2] ?? m[3]).trim() : null;
};
const isFileQuery = (t) => /FIND\s+(?:filename|implementation)\s+OF\s+(?:file|concept|pattern)/i.test(t.cqp ?? '');
const tokens = (s) => Math.max(1, Math.ceil(s.length / 4));

function runEngine(t) {
  const repoDir = path.resolve(ROOT, REPO_DIRS[t.repo]);
  if (fs.existsSync(CACHE)) fs.rmSync(CACHE);
  const out = execFileSync('node', [ENGINE, t.cqp], { cwd: repoDir, env: { ...process.env, TMPDIR: path.join(ROOT, '.tmp'), CF_STATS_FILE: path.join(ROOT, 'engine/statistics.ndjson') }, encoding: 'utf8', timeout: 90000 });
  return JSON.parse(out.toString());
}

const rows = [];
let totalReduction = 0, spanHits = 0, correct = 0, correctSpan = 0;
for (const t of TASKS) {
  const j = runEngine(t);
  const ground = groundOf(t);
  const ranked = [...new Set((j.results ?? []).map((r) => r.path))];
  const hit = (f) => ground.some((g) => f === g || f.endsWith('/' + g) || g.endsWith('/' + f));
  const cq = ranked.some(hit);
  if (cq) correct++;
  const res = j.results ?? [];
  const row = res.find((r) => r.line_start) ?? res[0];
  const top = row?.path;
  let rec = null;
  if (top) {
    const abs = path.resolve(ROOT, REPO_DIRS[t.repo], top);
    const name = nameOf(t);
    let line = row.line_start ?? 1;
    if (line <= 1 && name && !isFileQuery(t)) {
      try {
        const r = execFileSync('rg', ['-n', name.split(' ')[0], abs], { encoding: 'utf8', timeout: 10000 }).split('\n').find(Boolean);
        const m = /^(\d+):/.exec(r ?? '');
        if (m) line = Number(m[1]);
      } catch { /* sin match */ }
    }
    let content = '';
    try { content = fs.readFileSync(abs, 'utf8'); } catch { /* skip */ }
    if (content) {
      const lines = content.split('\n');
      const s = Math.max(1, line - 2), e = Math.min(lines.length, line + WIN);
      const span = lines.slice(s - 1, e).join('\n');
      const fileTok = tokens(content), spanTok = tokens(span);
      const red = 1 - spanTok / fileTok;
      totalReduction += red;
      const spanHit = !name || isFileQuery(t) ? true : span.includes(name);
      if (spanHit) spanHits++;
      if (cq && spanHit) correctSpan++;
      rec = { id: t.id, path: top, line, span_tokens: spanTok, file_tokens: fileTok, reduction: +red.toFixed(3), span_hit: spanHit, correct: cq };
    }
  }
  rows.push(rec ?? { id: t.id, error: 'sin top result' });
}

const n = rows.length;
const report = {
  date: new Date().toISOString().slice(0, 10), tasks: n,
  avg_reduction: +(totalReduction / Math.max(1, n)).toFixed(3),
  span_hit_rate: +(spanHits / Math.max(1, n)).toFixed(3),
  correctness: { baseline: +(correct / n).toFixed(3), with_span: +(correctSpan / n).toFixed(3) },
  window: `l-2..l+${WIN}`,
};
const verdict = { pass: report.avg_reduction >= 0.5 && report.correctness.with_span === report.correctness.baseline, ...report };

const TS = Date.now();
const outPath = path.join(ROOT, 'evals', 'reports', `read-span-${TS}.json`);
fs.writeFileSync(outPath, JSON.stringify({ ...verdict, rows }, null, 2) + '\n');

console.log(`tasks: ${n} | avg reduction: ${report.avg_reduction} | span_hit: ${report.span_hit_rate}`);
console.log(`correctness: baseline ${report.correctness.baseline} vs with_span ${report.correctness.with_span}`);
console.log(`veredicto: ${verdict.pass ? 'PASS' : 'FAIL'}`);
console.log('artefacto:', outPath);