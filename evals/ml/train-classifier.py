#!/usr/bin/env python3
"""
evals/ml/train-classifier.py — Entrenador out-of-band del clasificador local
(Phase 11.4/11.5). Modelo: regresión logística multinomial sobre n-grams de
caracteres con hash (H=2048) — gradiente trivially correcto, numpy, sin deps.
Sustituye provisionalmente al micro-transformer (backprop manual con bug en
v/proj; WIP documentado en tasks.md 11.9). El artifact JSON es swappable: el
mismo evals/ml/classify.mjs consume {type:'linear'|'transformer'}.

NOTA honesta: TinyBERT real (distilled de BERT teacher) requiere torch/GPU;
este artefacto es un clasificador lineal local — swappable por TinyBERT vía el
mismo contrato CF_MODEL_CMD 'classify-query'. Runtime del repo sigue 0 deps.
Uso: python3 evals/ml/train-classifier.py [--epochs 60]
"""
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
TRAIN = ROOT / 'evals/datasets/queries-train.jsonl'
VAL = ROOT / 'evals/datasets/queries-val.jsonl'
TEST = ROOT / 'evals/datasets/queries-test.jsonl'
OUT_DIR = ROOT / 'evals/ml/model'

EPOCHS = int(sys.argv[sys.argv.index('--epochs') + 1]) if '--epochs' in sys.argv else 60
H = 2048
LR = 0.5
SEED = 42

CLASSES = ['LEXICAL', 'STRUCTURAL', 'SYMBOL', 'REFERENCE', 'SEMANTIC',
           'DEPENDENCY', 'CONFIGURATION', 'TEST', 'GIT', 'COMPOSITE']
CLS_IDX = {c: i for i, c in enumerate(CLASSES)}

random.seed(SEED)
np.random.seed(SEED)


def load(path):
    rows = []
    for line in Path(path).read_text().splitlines():
        r = json.loads(line)
        if r['label'] in CLS_IDX:
            rows.append(r)
    return rows


def djb2(b):
    h = 5381
    for c in b:
        h = ((h * 33) + c) & 0xFFFFFFFF
    return h


def ngrams(text):
    t = '#' + text.lower() + '#'
    out = set()
    for i in range(len(t) - 2):
        out.add(t[i:i + 3].encode())
    return out


def featurize(text):
    """Vector disperso (índices) → denso count-clipped 1."""
    x = np.zeros(H)
    for g in ngrams(text):
        x[djb2(g) % H] = 1.0
    return x


def softmax_rows(x):
    x = x - x.max(axis=-1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=-1, keepdims=True)


def main():
    train, val, test = load(TRAIN), load(VAL), load(TEST)
    X_tr = np.stack([featurize(r['text']) for r in train])
    Y_tr = np.array([CLS_IDX[r['label']] for r in train])
    W = np.zeros((H, len(CLASSES)))
    print(f'dataset: train={len(train)} val={len(val)} test={len(test)} H={H}')

    for epoch in range(EPOCHS):
        probs = softmax_rows(X_tr @ W)
        onehot = np.zeros_like(probs)
        onehot[np.arange(len(Y_tr)), Y_tr] = 1.0
        grad = X_tr.T @ (probs - onehot) / len(Y_tr)
        W -= LR * grad
        if (epoch + 1) % 20 == 0 or epoch == EPOCHS - 1:
            acc = evaluate(W, val)
            print(f'epoch {epoch + 1}/{EPOCHS} val_acc={acc:.3f}')

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    artifact = {'type': 'linear', 'H': H, 'classes': CLASSES, 'W': W.tolist()}
    (OUT_DIR / 'classifier.json').write_text(json.dumps(artifact))
    report = {
        'model': 'linear hashed-ngram logit (tinybert-style swappable)',
        'H': H, 'epochs': EPOCHS,
        'train': len(train), 'val': len(val), 'test': len(test),
        'val_acc': round(evaluate(W, val), 3),
        'test_acc': round(evaluate(W, test), 3),
        'test_acc_per_class': per_class_acc(W, test),
        'artifact': str(OUT_DIR / 'classifier.json'),
    }
    (OUT_DIR / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


def predict(W, text):
    p = softmax_rows(featurize(text) @ W)
    return p, int(p.argmax())


def evaluate(W, rows):
    ok = sum(1 for r in rows if predict(W, r['text'])[1] == CLS_IDX[r['label']])
    return ok / max(1, len(rows))


def per_class_acc(W, rows):
    correct, total = defaultdict(int), defaultdict(int)
    for r in rows:
        total[r['label']] += 1
        if predict(W, r['text'])[1] == CLS_IDX[r['label']]:
            correct[r['label']] += 1
    return {c: round(correct[c] / max(1, total[c]), 3) for c in CLASSES}


if __name__ == '__main__':
    main()
