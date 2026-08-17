#!/usr/bin/env node
/**
 * engine/hint.js — B12 learned-plan-steering.
 * Hint ligero sobre el optimizer determinista: ranking aprendido (modelo pairwise
 * Lero) + umbral de confianza + Thompson sampling. NO reemplaza el determinista:
 * solo inclina la selección cuando la confianza del hint supera el umbral;
 * stats insuficientes => el default cost/quality se mantiene intacto.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = fileURLToPath(new URL('.', import.meta.url));
const QTYPE_ORDER = ['definitions', 'references', 'filename', 'implementation', 'pattern', 'concept'];
const FEATS = ['tokens', 'est_tokens', 'latency_ms', 'gt_hits', 'exactness', 'n_results', 'recall5', 'mrr'];
export const DEFAULT_THRESHOLD = 0.35;

const sig = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

let HINT_MODEL = null;
export function loadHintModel() {
  if (HINT_MODEL !== null) return HINT_MODEL;
  try {
    const p = path.join(ENGINE_DIR, '..', 'evals', 'ml', 'model', 'pairwise-model.json');
    HINT_MODEL = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  } catch { HINT_MODEL = null; }
  return HINT_MODEL;
}

function hintFeatures(plan, queryType) {
  const estTokens = plan.ops.reduce((a, o) => a + (o.tokens ?? 0), 0);
  const estLat = plan.ops.reduce((a, o) => a + (o.latency_ms ?? 0), 0);
  return {
    tokens: estTokens, est_tokens: estTokens, latency_ms: estLat,
    gt_hits: 0, exactness: 0, n_results: 0, recall5: 0, mrr: 0,
    qtype: queryType,
  };
}

function pairScores(plans, queryType, model) {
  const ids = plans.map((p) => p.id);
  const score = {};
  for (const X of plans) {
    const fx = hintFeatures(X, queryType);
    score[X.id] = ids.filter((Y) => Y !== X.id).reduce((s, Y) => {
      const fy = hintFeatures(plans.find((p) => p.id === Y), queryType);
      const diff = [...QTYPE_ORDER.map((q) => (queryType === q ? 1 : 0)), ...FEATS.map((f) => (fx[f] ?? 0) - (fy[f] ?? 0))];
      return s + sig(diff.reduce((a, x, i) => a + x * model.W[i], 0));
    }, 0);
  }
  return { score, ranked: plans.slice().sort((a, b) => score[b.id] - score[a.id]) };
}

export function hintRank(plans, queryType) {
  const model = loadHintModel();
  if (!model) return { ranked: [], score: {} };
  return pairScores(plans, queryType, model);
}

/**
 * Selección por hint. Devuelve null si no hay modelo o <2 planes.
 * - confianza >= threshold => top del ranking aprendido (inclinación fuerte)
 * - confianza < threshold  => Thompson sampling (exploración acotada) si thompson!==false
 * - si no => top del ranking sin override (mode 'none')
 */
export function hintSelect(plans, queryType, opts = {}) {
  const model = loadHintModel();
  if (!model || !plans || plans.length < 2) return null;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const { score, ranked } = pairScores(plans, queryType, model);
  const top = ranked[0];
  const second = ranked[1];
  const range = Math.max(1e-9, score[top.id] - score[ranked[ranked.length - 1].id]);
  const confidence = Math.max(0, Math.min(1, (score[top.id] - score[second.id]) / range));
  if (confidence >= threshold) {
    return { id: top.id, confidence, threshold, mode: 'threshold' };
  }
  if (opts.thompson !== false) {
    const sigma = opts.sigma ?? 0.2;
    const sampled = plans.reduce((a, b) =>
      score[b.id] + sigma * gauss() > score[a.id] + sigma * gauss() ? b : a);
    return { id: sampled.id, confidence, threshold, mode: 'thompson' };
  }
  return { id: top.id, confidence, threshold, mode: 'none' };
}