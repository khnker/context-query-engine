#!/usr/bin/env node
/**
 * engine/structural-refine.js — refinamiento estructural (CeQe-style, dc-13).
 * Cuando un concept query queda SIN evidencia (0 relevantes), se escanean anclas
 * estructurales de framework (decoradores/patrones @Module, @Injectable,
 * providers:, app.use, describe(, etc.) y se emiten los archivos con más anclas
 * como evidencia estructural (certainty 0.7+). Sin ML, sin probe: puro rg.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ANCHORS = [
  '@Module', '@Injectable', '@Controller', '@Component', '@Service', '@Entity',
  '@Repository', '@Autowired', '@Inject', '@Provides', 'providers:', 'imports:',
  'app.use(', 'router.', '@app.get(', '@router.', 'def test_', 'describe(',
  'it(', 'pytest', 'jest', 'useState', 'export default function', 'class .*View',
  '@app.route', 'urlpatterns', 'app.get(', 'app.post(', 'module.exports',
];

export function structuralRefine(cwd, topN = 15) {
  const counts = new Map(); // path → n anclas
  const docLike = (p) => /\.(md|markdown|rst|txt)$/i.test(p) || /(^|\/)(docs?|skills?|rules?|guides?)(\/|$)/.test(p);
  for (const anchor of ANCHORS) {
    try {
      const out = execFileSync('rg', ['-l', '--no-ignore', '-g', '!node_modules', '-g', '!dist', '-g', '!coverage', '-e', anchor, '.'], {
        cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      });
      for (const p of out.split('\n').filter(Boolean)) {
        if (p.includes('node_modules') || docLike(p)) continue; // solo implementación, no docs
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    } catch { /* sin matches → siguiente ancla */ }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([p, n]) => ({
      source: 'structural', path: p, line_start: 1, line_end: 1,
      match_type: 'structural', score: Math.min(0.9, 0.7 + 0.05 * n),
      token_estimate: 10, reason: `structural anchor ×${n}`,
      certainty: Math.min(0.9, 0.7 + 0.05 * n),
    }));
}