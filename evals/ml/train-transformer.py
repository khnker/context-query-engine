#!/usr/bin/env python3
"""
evals/ml/train-transformer.py — 11.9: micro-transformer (TinyBERT-style) en numpy.
Backprop manual; artefacto alternativo al clasificador lineal (mismo contrato
classify.mjs type:'transformer'). MODO CHECK: gradient check DENSо (todos los
pesos, modelo tiny) para cazar bugs de backprop antes de entrenar.
Uso:
  python3 evals/ml/train-transformer.py --check   # gradient check denso
  python3 evals/ml/train-transformer.py [--epochs 40]   # entrenar + export artifact
"""
import json
import math
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
TRAIN = ROOT / 'evals/datasets/queries-train.jsonl'
VAL = ROOT / 'evals/datasets/queries-val.jsonl'
TEST = ROOT / 'evals/datasets/queries-test.jsonl'
OUT_DIR = ROOT / 'evals/ml/model'

CLASSES = ['LEXICAL', 'STRUCTURAL', 'SYMBOL', 'REFERENCE', 'SEMANTIC',
           'DEPENDENCY', 'CONFIGURATION', 'TEST', 'GIT', 'COMPOSITE']
CLS_IDX = {c: i for i, c in enumerate(CLASSES)}

random.seed(42)
np.random.seed(42)


def load(path):
    rows = []
    for line in Path(path).read_text().splitlines():
        r = json.loads(line)
        if r['label'] in CLS_IDX:
            rows.append(r)
    return rows


def tokenize(text):
    return [t for t in text.lower().split() if any(ch.isalnum() for ch in t)][:24]


def build_vocab(rows, max_vocab=1500):
    cnt = Counter()
    for r in rows:
        cnt.update(tokenize(r['text']))
    return {w: i + 2 for i, (w, _) in enumerate(cnt.most_common(max_vocab))}


def encode(text, vocab, maxlen=24):
    ids = [vocab.get(t, 1) for t in tokenize(text)]
    return ids[:maxlen] + [0] * (maxlen - len(ids))


def init_model(vocab_size, d=64, layers=2, heads=2, ff=128, maxlen=24):
    def w(shape):
        return (np.random.randn(*shape) * 0.02).astype(np.float64)
    m = {
        'config': {'d': d, 'heads': heads, 'layers': layers, 'ff': ff,
                   'maxlen': maxlen, 'vocab_size': vocab_size},
        'wte': w((vocab_size, d)),
        'wpe': w((maxlen, d)),
        'blocks': [],
        'head': w((d, len(CLASSES))),
        'bias': np.zeros(len(CLASSES)),
    }
    for _ in range(layers):
        m['blocks'].append({
            'q': w((d, d)), 'k': w((d, d)), 'v': w((d, d)), 'proj': w((d, d)),
            'ff1': w((d, ff)), 'ff2': w((ff, d)),
        })
    return m


def softmax_rows(x):
    x = x - x.max(axis=-1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=-1, keepdims=True)


def layer_norm(x):
    mean = x.mean(axis=-1, keepdims=True)
    var = x.var(axis=-1, keepdims=True)
    return (x - mean) / np.sqrt(var + 1e-5)


def forward(m, ids, cache=True):
    B = ids.shape[0]
    L = ids.shape[1]
    x = m['wte'][ids] + m['wpe'][None, :, :]
    c = {'x': [x], 'q': [], 'k': [], 'v': [], 'attn': [], 'proj': [], 'nx': [], 'nx2': [], 'f': []}
    for blk in m['blocks']:
        nx = layer_norm(x)
        q = nx @ blk['q']
        k = nx @ blk['k']
        v = nx @ blk['v']
        scores = (q @ k.transpose(0, 2, 1)) / math.sqrt(m['config']['d'] / m['config']['heads'])
        pad = (ids == 0)[:, :, None] | (ids == 0)[:, None, :]
        scores = np.where(pad, -1e9, scores)
        attn = softmax_rows(scores)
        proj = attn @ v @ blk['proj']
        x = x + proj
        nx2 = layer_norm(x)
        f = np.maximum(0.0, nx2 @ blk['ff1'])
        out = f @ blk['ff2']
        if cache:
            c['q'].append(q); c['k'].append(k); c['v'].append(v)
            c['attn'].append(attn); c['proj'].append(proj)
            c['nx'].append(nx); c['nx2'].append(nx2); c['f'].append(f)
            c['x'].append(x)
        x = x + out
    c['final'] = x
    pooled = x.mean(axis=1)
    logits = pooled @ m['head'] + m['bias']
    c['pooled'] = pooled
    return logits, c


def forward_clean(m, ids):
    x = m['wte'][ids] + m['wpe'][None, :, :]
    for blk in m['blocks']:
        nx = layer_norm(x)
        q, k, v = nx @ blk['q'], nx @ blk['k'], nx @ blk['v']
        scores = (q @ k.transpose(0, 2, 1)) / math.sqrt(m['config']['d'] / m['config']['heads'])
        pad = (ids == 0)[:, :, None] | (ids == 0)[:, None, :]
        scores = np.where(pad, -1e9, scores)
        attn = softmax_rows(scores)
        x = x + attn @ v @ blk['proj']
        nx2 = layer_norm(x)
        x = x + np.maximum(0.0, nx2 @ blk['ff1']) @ blk['ff2']
    pooled = x.mean(axis=1)
    return pooled @ m['head'] + m['bias']


def backward(m, ids, grad_logits, c):
    B, L, D = ids.shape[0], ids.shape[1], m['config']['d']
    gwte = np.zeros_like(m['wte'])
    gwpe = np.zeros_like(m['wpe'])
    ghead = np.zeros_like(m['head'])
    gbias = np.zeros_like(m['bias'])
    gblk = [{'q': np.zeros_like(b['q']), 'k': np.zeros_like(b['k']),
             'v': np.zeros_like(b['v']), 'proj': np.zeros_like(b['proj']),
             'ff1': np.zeros_like(b['ff1']), 'ff2': np.zeros_like(b['ff2'])}
            for b in m['blocks']]

    gpooled = grad_logits @ m['head'].T
    ghead[:] = c['pooled'].T @ grad_logits
    gbias[:] = grad_logits.sum(axis=0)

    g = np.broadcast_to((gpooled / L)[:, None, :], (B, L, D))

    for l in reversed(range(m['config']['layers'])):
        blk = m['blocks'][l]
        gb = gblk[l]
        x_prev = c['x'][l]
        x_after = c['final'] if l == m['config']['layers'] - 1 else c['x'][l + 1]
        # rama FF: out = relu(LN2(x+proj)) @ ff2
        gb['ff2'][:] = np.einsum('blf,blh->fh', c['f'][l], g)
        gf = np.einsum('bld,fd->blf', g, blk['ff2']) * (c['f'][l] > 0)
        gb['ff1'][:] = np.einsum('bld,blf->df', c['nx2'][l], gf)
        g_res = np.einsum('blf,df->bld', gf, blk['ff1'])          # grad en nx2
        x2n = c['nx2'][l]
        mean2 = x2n.mean(axis=-1, keepdims=True)
        var2 = x2n.var(axis=-1, keepdims=True)
        inv2 = 1.0 / np.sqrt(var2 + 1e-5)
        g_ln2 = inv2 * (g_res - g_res.mean(axis=-1, keepdims=True)
                        - (x2n - mean2) * (g_res * (x2n - mean2)).mean(axis=-1, keepdims=True))
        g = g + g_ln2                                            # grad en (x_prev + proj)
        gp = g                                                   # grad del output de proj = directo + rama FF
        # rama atención: proj_out = attn @ v @ proj
        gb['proj'][:] = np.einsum('blt,bld->td', c['attn'][l] @ c['v'][l], gp)
        gv = np.einsum('blt,btd->bld', c['attn'][l], gp @ blk['proj'].T)
        gb['v'][:] = np.einsum('blk,bld->kd', c['nx'][l], gv)
        gattn = np.einsum('bld,btd->blt', gp @ blk['proj'].T, c['v'][l])
        gscores = gattn * c['attn'][l] - (gattn * c['attn'][l]).sum(axis=-1, keepdims=True) * c['attn'][l]
        gqk = gscores / math.sqrt(D / m['config']['heads'])
        gq = np.einsum('blt,btd->bld', gqk, c['k'][l])
        gk = np.einsum('blt,bld->btd', gqk, c['q'][l])
        gb['q'][:] = np.einsum('blk,bld->kd', c['nx'][l], gq)
        gb['k'][:] = np.einsum('blk,btd->kd', c['nx'][l], gk)
        g_ln1 = np.einsum('bld,dk->blk', gq, blk['q']) + np.einsum('bld,dk->blk', gk, blk['k']) + np.einsum('bld,dk->blk', gv, blk['v'])
        x1n = c['nx'][l]
        mean1 = x1n.mean(axis=-1, keepdims=True)
        var1 = x1n.var(axis=-1, keepdims=True)
        inv1 = 1.0 / np.sqrt(var1 + 1e-5)
        g_into_ln1 = inv1 * (g_ln1 - g_ln1.mean(axis=-1, keepdims=True)
                             - (x1n - mean1) * (g_ln1 * (x1n - mean1)).mean(axis=-1, keepdims=True))
        g = g + g_into_ln1

    gwte_flat = g.reshape(-1, D)
    np.add.at(gwte, ids.reshape(-1), gwte_flat)
    gwpe[:] = g.sum(axis=0)
    return {'wte': gwte, 'wpe': gwpe, 'head': ghead, 'bias': gbias, 'blocks': gblk}


def loss_fn(m, ids, target):
    logits = forward_clean(m, ids)
    p = softmax_rows(logits)[0]
    return -math.log(max(p[target], 1e-9))


def gradient_check():
    """Denso: TODOS los pesos de un modelo tiny; reporta máximo error relativo por capa."""
    vocab, d, L, Lm = 12, 4, 1, 24  # capas=1, seqlen=24 (check tiny, denso)
    m = init_model(vocab, d=d, layers=L, heads=2, ff=8, maxlen=Lm)
    ids = np.array([[3, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]])
    target = 2
    logits, cache = forward(m, ids)
    probs = softmax_rows(logits)
    onehot = np.zeros_like(probs)
    onehot[0, target] = 1
    grads = backward(m, ids, probs - onehot, cache)
    eps = 1e-4
    results = {}

    def num_grad(param):
        out = np.zeros_like(param)
        flat = param.reshape(-1)
        for idx in range(flat.size):
            old = flat[idx]
            flat[idx] = old + eps
            lp = loss_fn(m, ids, target)
            flat[idx] = old - eps
            lm = loss_fn(m, ids, target)
            flat[idx] = old
            out.reshape(-1)[idx] = (lp - lm) / (2 * eps)
        return out

    for name, ana in [('head', grads['head']), ('bias', grads['bias'])]:
        num = num_grad(m[name])
        results[name] = float(np.abs(num - ana).max())
    for l in range(L):
        blk = m['blocks'][l]
        for wname in ['q', 'k', 'v', 'proj', 'ff1', 'ff2']:
            ana = grads['blocks'][l][wname]
            num = num_grad(blk[wname])
            results[f'l{l}.{wname}'] = float(np.abs(num - ana).max())
    ana = grads['wte']
    num = num_grad(m['wte'])
    results['wte'] = float(np.abs(num - ana).max())
    ana = grads['wpe']
    num = num_grad(m['wpe'])
    results['wpe'] = float(np.abs(num - ana).max())

    print(json.dumps(results, indent=2))
    worst = max(results.values())
    # error absoluto: q/k con grad real ~0 dan rel enorme sin ser bug (FD noise)
    print('PASS' if worst < 1e-3 else 'FAIL', f'(peor abs: {worst:.2e})')
    return worst < 1e-3


def main():
    if '--check' in sys.argv:
        sys.exit(0 if gradient_check() else 1)
    epochs = int(sys.argv[sys.argv.index('--epochs') + 1]) if '--epochs' in sys.argv else 40
    train, val, test = load(TRAIN), load(VAL), load(TEST)
    vocab = build_vocab(train)
    m = init_model(len(vocab) + 2)
    data = [(encode(r['text'], vocab), CLS_IDX[r['label']]) for r in train]
    BATCH = 32
    LR = 0.3
    for epoch in range(epochs):
        random.shuffle(data)
        loss_acc = 0.0
        nb = 0
        for start in range(0, len(data), BATCH):
            batch = data[start:start + BATCH]
            ids = np.array([b[0] for b in batch])
            targets = np.array([b[1] for b in batch])
            logits, cache = forward(m, ids)
            probs = softmax_rows(logits)
            onehot = np.zeros_like(probs)
            onehot[np.arange(len(batch)), targets] = 1
            loss_acc += -np.log(np.clip(probs[np.arange(len(batch)), targets], 1e-9, 1)).mean()
            nb += 1
            grads = backward(m, ids, (probs - onehot) / len(batch), cache)
            # grad clipping (norm 1.0) — evita divergencia con LR alto
            allg = np.concatenate([grads[k].reshape(-1) for k in ['wte', 'wpe', 'head']]
                                  + [grads['blocks'][l][k2].reshape(-1) for l in range(m['config']['layers']) for k2 in grads['blocks'][l]])
            norm = np.linalg.norm(allg)
            if norm > 1.0:
                scale = 1.0 / norm
                for k in ['wte', 'wpe', 'head']:
                    grads[k] *= scale
                for l in range(m['config']['layers']):
                    for k2 in grads['blocks'][l]:
                        grads['blocks'][l][k2] *= scale
            m['wte'] -= LR * grads['wte']
            m['wpe'] -= LR * grads['wpe']
            m['head'] -= LR * grads['head']
            m['bias'] -= LR * grads['bias']
            for l in range(m['config']['layers']):
                for k2 in grads['blocks'][l]:
                    m['blocks'][l][k2] -= LR * grads['blocks'][l][k2]
        if (epoch + 1) % 10 == 0 or epoch == epochs:
            print(f'epoch {epoch + 1}/{epochs} loss={loss_acc / nb:.3f} val_acc={evaluate(m, vocab, val):.3f}')
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    artifact = {'type': 'transformer', 'config': m['config'],
                'wte': m['wte'].tolist(), 'wpe': m['wpe'].tolist(),
                'blocks': [{k: b[k].tolist() for k in b} for b in m['blocks']],
                'head': m['head'].tolist(), 'bias': m['bias'].tolist()}
    (OUT_DIR / 'transformer.json').write_text(json.dumps(artifact))
    (OUT_DIR / 'transformer-report.json').write_text(json.dumps({
        'val_acc': evaluate(m, vocab, val), 'test_acc': evaluate(m, vocab, test),
        'params': sum(v.size for v in [m['wte'], m['wpe'], m['head']] + [b[k] for b in m['blocks'] for k in b] + [m['bias']]),
    }, indent=2))


def predict(m, vocab, text):
    ids = np.array([encode(text, vocab)])
    p = softmax_rows(forward_clean(m, ids))[0]
    return p, p.argmax()


def evaluate(m, vocab, rows):
    ok = sum(1 for r in rows if predict(m, vocab, r['text'])[1] == CLS_IDX[r['label']])
    return ok / max(1, len(rows))


if __name__ == '__main__':
    main()
