#!/usr/bin/env node
/**
 * evals/scripts/env-fingerprint.js — G4: fingerprint de entorno para reproducibilidad.
 * Uso: node evals/scripts/env-fingerprint.js <manifest.json>
 * Salida: JSON a stdout {machine, cpu, cores, ram_gb, os, node, cqe_commit, repo_commits, model_sha256, timestamp}
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

function modelSha() {
  const dir = path.join(ROOT, 'evals', 'ml', 'model');
  const hash = createHash('sha256');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  for (const f of files) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(dir, f)));
  }
  return files.length ? hash.digest('hex') : null;
}

const manifestPath = process.argv[2];
const repo_commits = {};
if (manifestPath && fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const repo of manifest.repos ?? []) {
    repo_commits[repo.name] = gitHead(repo.path);
  }
}

process.stdout.write(JSON.stringify({
  machine: os.hostname(),
  cpu: os.cpus()[0]?.model ?? 'unknown',
  cores: os.cpus().length,
  ram_gb: Math.round(os.totalmem() / 1e9),
  os: `${os.platform()} ${os.release()}`,
  node: process.version,
  cqe_commit: gitHead(ROOT),
  repo_commits,
  model_sha256: modelSha(),
  timestamp: new Date().toISOString(),
}, null, 2) + '\n');
