#!/usr/bin/env node
/**
 * engine/index-layer/watcher.js — Incremental Watcher + Change Normalizer (3, 4).
 * FileChangeEvent {path, kind, timestamp}; backend fs.watch recursive (OS).
 * Debounce + coalescing: los eventos físicos se convierten en mutaciones lógicas
 * (una ronda de indexación por ventana, kind del último evento por path).
 */
import fs from 'node:fs';
import path from 'node:path';

export class ChangeQueue {
  constructor(repoDir, { debounceMs = 300 } = {}) {
    this.repoDir = path.resolve(repoDir);
    this.debounceMs = debounceMs;
    this.pending = new Map(); // relPath → kind (último gana: rename/delete > change)
    this.timer = null;
    this.listeners = [];
  }

  push(relPath, kind) {
    const rel = String(relPath).replace(/^\.\//, '');
    const w = this.pending.get(rel);
    this.pending.set(rel, w && kind === 'change' ? w : kind);
    this._arm();
  }

  _arm() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush() {
    this.timer = null;
    const batch = [...this.pending.entries()].map(([path, kind]) => ({ path, kind, timestamp: Date.now() }));
    this.pending.clear();
    if (!batch.length) return;
    for (const fn of this.listeners) fn(batch);
  }

  onBatch(fn) {
    this.listeners.push(fn);
  }

  start() {
    this.watcher = fs.watch(this.repoDir, { recursive: true }, (kind, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (/(^|\/)(node_modules|\.git|dist|build|coverage|\.tmp|\.cqe)(\/|$)/.test(rel)) return;
      if (this._stale) return;
      this.push(rel, kind === 'rename' ? 'delete' : 'change');
    });
    return this;
  }

  close() {
    this._stale = true;
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close?.();
  }
}

export function watchRoundtrip(repoDir, { debounceMs = 200 } = {}) {
  // helper para eval: arranca el watcher, toca un archivo, espera el batch.
  return new Promise((resolve, reject) => {
    const q = new ChangeQueue(repoDir, { debounceMs });
    const to = setTimeout(() => { q.close(); reject(new Error('watcher timeout')); }, 5000);
    q.onBatch((batch) => {
      clearTimeout(to);
      q.close();
      resolve(batch);
    });
    q.start();
    setTimeout(() => {
      try {
        const f = path.join(repoDir, 'package.json');
        fs.utimesSync(f, new Date(), new Date());
      } catch {
        reject(new Error('touch falló'));
      }
    }, 50);
  });
}