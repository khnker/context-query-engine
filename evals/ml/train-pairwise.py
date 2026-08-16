#!/usr/bin/env python3
"""evals/ml/train-pairwise.py — modelo pairwise de preferencia de planes (Lero, paso 08).
Logística sobre [query_type one-hot ⊕ diff(features del plan)] con ridge (λ).
Dataset: evals/datasets/pairs.json (74 tasks, 222 pares; label = gana gt_hits,
tie → tokens menores). Split por TASK (80/20), no por par.
Report: train_acc, holdout_acc, balanced_acc, confusion. Artefacto:
evals/ml/model/pairwise-model.json {type:'pairwise', W, feat_names, dims}.
numpy solo. Uso: python3 evals/ml/train-pairwise.py [--epochs 300] [--lambda 0.1]
"""
import json, sys, random
import numpy as np

ROOT = 'evals'
sys.path.insert(0, ROOT)

def main():
    epochs = int(sys.argv[sys.argv.index('--epochs') + 1]) if '--epochs' in sys.argv else 300
    lam = float(sys.argv[sys.argv.index('--lambda') + 1]) if '--lambda' in sys.argv else 0.1
    data = json.load(open('evals/datasets/pairs.json'))
    feat_names = data['feat_names']
    pairs = data['pairs']
    random.seed(42)
    task_ids = sorted({p['task'] for p in pairs})
    random.shuffle(task_ids)
    cut = int(len(task_ids) * 0.8)
    train_tasks, val_tasks = set(task_ids[:cut]), set(task_ids[cut:])
    Xtr = np.array([p['features'] for p in pairs if p['task'] in train_tasks], dtype=float)
    ytr = np.array([p['label'] for p in pairs if p['task'] in train_tasks], dtype=float)
    Xva = np.array([p['features'] for p in pairs if p['task'] in val_tasks], dtype=float)
    yva = np.array([p['label'] for p in pairs if p['task'] in val_tasks], dtype=float)
    n, d = Xtr.shape
    W = np.zeros(d)
    for ep in range(epochs):
        z = Xtr @ W
        p = 1 / (1 + np.exp(-np.clip(z, -30, 30)))
        grad = Xtr.T @ (p - ytr) / n + (lam / n) * W
        W -= 0.1 * grad
    pred = (1 / (1 + np.exp(-np.clip(Xva @ W, -30, 30)))) > 0.5
    tr_pred = (1 / (1 + np.exp(-np.clip(Xtr @ W, -30, 30)))) > 0.5
    acc = (pred == (yva > 0.5)).mean()
    tr_acc = (tr_pred == (ytr > 0.5)).mean()
    pos = yva > 0.5
    bal = 0.5 * ((pred[pos]).mean() if pos.any() else 0) + 0.5 * ((~pred[~pos]).mean() if (~pos).any() else 0)
    print(f'pairs train {len(ytr)} / val {len(yva)} | dims {d}')
    print(f'train_acc {tr_acc:.3f} | holdout_acc {acc:.3f} | balanced_acc {bal:.3f} | baseline-majority {max((yva>0.5).mean(), 1-(yva>0.5).mean()):.3f}')
    import os
    os.makedirs('evals/ml/model', exist_ok=True)
    json.dump({'type': 'pairwise', 'W': W.tolist(), 'feat_names': feat_names, 'dims': d,
               'report': {'train_acc': tr_acc, 'holdout_acc': acc, 'balanced_acc': bal, 'val_pairs': len(yva)}},
              open('evals/ml/model/pairwise-model.json', 'w'), indent=2)
    print('modelo → evals/ml/model/pairwise-model.json')

main()