#!/usr/bin/env python3
"""
evals/ml/train-mlp.py — MLP de 1 capa oculta (numpy, sin deps) como ablación.
Arquitectura: H(in) → H_hid=128 (ReLU) → C(out).
Exporta JSON compatible con classify.mjs: {type:'mlp', H, H_hid, W1, b1, W2, b2}.
"""
import json
import random
import sys
import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRAIN = ROOT / 'evals/datasets/queries-train.jsonl'
VAL = ROOT / 'evals/datasets/queries-val.jsonl'
OUT = ROOT / 'evals/ml/model/mlp.json'

H = 2048
H_HID = 128
C = 10
LR = 0.1
EPOCHS = 100
SEED = 42

random.seed(SEED)
np.random.seed(SEED)

def load(path):
    rows = []
    for line in Path(path).read_text().splitlines():
        r = json.loads(line)
        rows.append(r)
    return rows

def djb2(b):
    h = 5381
    for c in b: h = ((h * 33) + c) & 0xFFFFFFFF
    return h

def featurize(text):
    x = np.zeros(H)
    t = '#' + text.lower() + '#'
    for n in (2, 3, 4):
        for i in range(len(t) - n + 1):
            x[djb2(t[i:i + n].encode()) % H] = 1.0
    return x

def relu(x): return np.maximum(0, x)
def relu_grad(x): return (x > 0).astype(float)
def softmax(x):
    e = np.exp(x - x.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)

def main():
    train, val = load(TRAIN), load(VAL)
    X = np.stack([featurize(r['text']) for r in train])
    CLASSES = ['LEXICAL', 'STRUCTURAL', 'SYMBOL', 'REFERENCE', 'SEMANTIC', 'DEPENDENCY', 'CONFIGURATION', 'TEST', 'GIT', 'COMPOSITE']
    CLS_IDX = {c: i for i, c in enumerate(CLASSES)}
    Y = np.zeros((len(train), len(CLASSES)))
    for i, r in enumerate(train): Y[i, CLS_IDX[r['label']]] = 1.0

    W1, b1 = np.random.randn(H, H_HID) * 0.1, np.zeros(H_HID)
    W2, b2 = np.random.randn(H_HID, C) * 0.1, np.zeros(C)

    for epoch in range(EPOCHS):
        # Forward
        Z1 = X @ W1 + b1
        A1 = relu(Z1)
        Z2 = A1 @ W2 + b2
        probs = softmax(Z2)
        # Backward
        dZ2 = (probs - Y) / len(train)
        dW2 = A1.T @ dZ2
        db2 = dZ2.sum(axis=0)
        dA1 = dZ2 @ W2.T
        dZ1 = dA1 * relu_grad(Z1)
        dW1 = X.T @ dZ1
        db1 = dZ1.sum(axis=0)
        # Update
        W1 -= LR * dW1
        b1 -= LR * db1
        W2 -= LR * dW2
        b2 -= LR * db2
        if (epoch+1) % 20 == 0:
            print(f'epoch {epoch+1} done')

    artifact = {'type':'mlp', 'H':H, 'H_hid':H_HID, 'W1':W1.tolist(), 'b1':b1.tolist(), 'W2':W2.tolist(), 'b2':b2.tolist()}
    OUT.write_text(json.dumps(artifact))
    print(f'saved to {OUT}')

if __name__ == '__main__': main()
