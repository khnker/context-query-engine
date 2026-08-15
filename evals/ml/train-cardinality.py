#!/usr/bin/env python3
"""
evals/ml/train-cardinality.py — 13.3/13.4: modelo de cardinalidad (cost model).
Regresión lineal ridge (numpy, sin deps) predice log1p(actual_candidates) desde
features: one-hot(operator), one-hot(queryClass), log1p(est_candidates).
Entrenado en evals/ml/model/cardinality-train.jsonl; evalúa MAPE/P50/P95 del
error vs baseline heurístico (avg actual por operator|queryClass en train).
Adopción por evidencia: ML solo si mejora el baseline (gate ML, 13.7).
Uso: python3 evals/ml/train-cardinality.py
"""
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / 'evals/ml/model'
LAMBDA = 1.0


def load(name):
    p = MODEL / name
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines()]


def features(r, op_idx, qc_idx):
    f = [0.0] * (len(op_idx) + len(qc_idx) + 1)
    f[op_idx.get(r['operator'], 0)] = 1.0
    f[len(op_idx) + qc_idx.get(r['queryClass'], 0)] = 1.0
    f[-1] = math.log1p(max(0, r.get('est_candidates', 0)))
    return f


def mape_stats(y_true, y_pred):
    errs = [abs(a - b) / a if a > 0 else 0 for a, b in zip(y_true, y_pred)]
    errs_sorted = sorted(errs)
    n = len(errs_sorted)
    return {
        'mape': sum(errs) / n if n else 0,
        'p50': errs_sorted[min(n - 1, int(0.5 * n))] if n else 0,
        'p95': errs_sorted[min(n - 1, int(0.95 * n))] if n else 0,
    }


def main():
    train, val, test = load('cardinality-train.jsonl'), load('cardinality-val.jsonl'), load('cardinality-test.jsonl')
    if not train:
        print('sin dataset — ejecuta evals/scripts/export-cardinality-features.js primero')
        return

    ops = sorted({r['operator'] for r in train})
    qcs = sorted({r['queryClass'] for r in train})
    op_idx = {o: i for i, o in enumerate(ops)}
    qc_idx = {q: i for i, q in enumerate(qcs)}
    D = len(op_idx) + len(qc_idx) + 1

    X = np.array([features(r, op_idx, qc_idx) for r in train])
    y = np.array([math.log1p(max(0, r['actual_candidates'])) for r in train])
    # ridge: W = (X^T X + λI)^-1 X^T y
    A = X.T @ X + LAMBDA * np.eye(D)
    W = np.linalg.solve(A, X.T @ y)

    def predict(rows):
        return [math.expm1(np.clip(np.dot(features(r, op_idx, qc_idx), W), 0, 20)) for r in rows]

    def baseline(rows):
        # heurístico: avg actual por operator|queryClass (de train)
        avg = defaultdict(float)
        cnt = defaultdict(int)
        for r in train:
            avg[(r['operator'], r['queryClass'])] += r['actual_candidates']
            cnt[(r['operator'], r['queryClass'])] += 1
        return [avg[(r['operator'], r['queryClass'])] / max(1, cnt[(r['operator'], r['queryClass'])]) for r in rows]

    m_ml = mape_stats([r['actual_candidates'] for r in test], predict(test))
    m_bl = mape_stats([r['actual_candidates'] for r in test], baseline(test))
    report = {
        'rows': {'train': len(train), 'val': len(val), 'test': len(test)},
        'operators': ops,
        'query_classes': qcs,
        'ml_ridge': m_ml,
        'heuristic_baseline': m_bl,
        'verdict': 'ML ADOPTED' if m_ml['mape'] < m_bl['mape'] else 'HEURISTIC KEEPS',
    }
    (MODEL / 'cardinality-report.json').write_text(json.dumps(report, indent=2))
    # 13.5 — artifact para inferencia node (evals/ml/classify.mjs sirve estimate-cardinality)
    artifact = {'type': 'ridge-cardinality', 'W': W.tolist(), 'op_idx': op_idx, 'qc_idx': qc_idx}
    (MODEL / 'cardinality-model.json').write_text(json.dumps(artifact))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
