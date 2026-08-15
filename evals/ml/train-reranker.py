#!/usr/bin/env python3
"""
evals/ml/train-reranker.py — 12.5b: reranker de relevancia real (numpy, sin deps).
Entrena un regresor ridge sobre pares (query, file) desde el ground truth de
tasks.json (primary/related/tests = positivos; archivos del repo NO en el GT =
negativos). Features: char n-grams (2-4) hasheados de query + path.
Exporta evals/ml/model/reranker-model.json consumido por classify.mjs ('rerank').
Evalúa recall@5/MRR sobre tasks held-out (80/20 por tarea).
Uso: python3 evals/ml/train-reranker.py [--epochs 40]
"""
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
TASKS = json.loads((ROOT / 'evals/datasets/tasks.json').read_text())
TASKS_DEV = ROOT / 'evals/datasets/tasks-dev.json'
if TASKS_DEV.exists():
    TASKS += json.loads(TASKS_DEV.read_text())
REPO_DIRS = {'t1-basic': ROOT / 'evals/datasets/repos/t1-basic', 't1-modular': ROOT / 'evals/datasets/repos/t1-modular', 'dev': ROOT.parent}
SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.angular', '.output', '.venv', 'venv', '__pycache__', 'target', 'vendor', 'data', '.cache', '.worktrees'}
OUT = ROOT / 'evals/ml/model'
H = 4096
LAMBDA = 1.0
SEED = 42
EPOCHS = int(sys.argv[sys.argv.index('--epochs') + 1]) if '--epochs' in sys.argv else 40

random.seed(SEED)
np.random.seed(SEED)


def djb2(b):
    h = 5381
    for c in b:
        h = ((h * 33) + c) & 0xFFFFFFFF
    return h


def featurize(query, path):
    """Hashead char n-grams (2-4) de 'query|path' → vector denso binario."""
    x = np.zeros(H)
    t = ('#' + query.lower() + '#' + '|' + '#' + path.lower() + '#')
    for n in (2, 3, 4):
        for i in range(len(t) - n + 1):
            x[djb2(t[i:i + n].encode()) % H] = 1.0
    return x


def repo_files(task):
    d = REPO_DIRS.get(task.get('repo'))
    if not d or not d.exists():
        return []
    out = []
    for p in d.rglob('*'):
        if p.is_file() and not any(s in p.parts for s in SKIP_DIRS):
            out.append(str(p.relative_to(d)))
    return out


def build_dataset():
    pos, neg = [], []
    for t in TASKS:
        gt = set(t.get('primary', []) + t.get('related', []) + t.get('tests', []))
        if not gt or not t.get('query'):
            continue
        files = repo_files(t)
        for f in gt:
            pos.append((t['query'], f))
        others = [f for f in files if f not in gt]
        random.shuffle(others)
        for f in others[: len(gt) * 4]:
            neg.append((t['query'], f))
    return pos, neg


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def main():
    pos, neg = build_dataset()
    print(f'pares: positivos {len(pos)} negativos {len(neg)}')
    if not pos:
        print('sin ground truth — ¿tasks.json con primary?')
        return
    data = [(q, f, 1) for q, f in pos] + [(q, f, 0) for q, f in neg]
    random.shuffle(data)
    # split por query (para no filtrar la misma query entre train/test)
    queries = sorted({q for q, _, _ in data})
    random.shuffle(queries)
    split = int(len(queries) * 0.8)
    train_q, test_q = set(queries[:split]), set(queries[split:])
    train = [(q, f, y) for q, f, y in data if q in train_q]
    test = [(q, f, y) for q, f, y in data if q in test_q]

    X = np.stack([featurize(q, f) for q, f, _ in train])
    y = np.array([float(l) for _, _, l in train])
    W = np.zeros(H)
    for epoch in range(EPOCHS):
        p = sigmoid(X @ W)
        grad = X.T @ (p - y) / len(y) + (LAMBDA / len(y)) * W
        W -= 1.0 * grad

    # eval: recall@5 y MRR por query en test (rank de GT vs no-GT)
    by_q = defaultdict(list)
    for q, f, l in test:
        by_q[q].append((f, l))
    r5, mrrs, nq = [], [], 0
    for q, items in by_q.items():
        gt = {f for f, l in items if l == 1}
        if not gt:
            continue
        scored = [(f, float(sigmoid(featurize(q, f) @ W))) for f, _ in items]
        scored.sort(key=lambda x: -x[1])
        nq += 1
        for i, (f, s) in enumerate(scored):
            if f in gt:
                mrrs.append(1.0 / (i + 1))
                r5.append(1.0 if i < 5 else 0.0)
                break
    report = {
        'pairs': {'pos': len(pos), 'neg': len(neg), 'train': len(train), 'test': len(test)},
        'queries_test': nq,
        'recall_at5': sum(r5) / max(1, nq),
        'mrr': sum(mrrs) / max(1, len(mrrs)),
        'model': 'ridge hashed-ngram relevance (reranker 12.5b)',
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'reranker-model.json').write_text(json.dumps({'type': 'reranker', 'H': H, 'W': W.tolist()}))
    (OUT / 'reranker-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
