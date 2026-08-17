# Adversarial workloads — FAIL parcial (8/10 categorías)

> Veredicto: FAIL parcial - 8/10 categorias

30 queries adversas (10 categorías × 3) sobre polar + fixtures: símbolos de alta frecuencia, identificadores ambiguos, fan-out masivo, zero-results, cadenas de dependencia profundas, implementaciones duplicadas, código generado, vendor-code (anti-leak), monorepo, polyglot.

```bash
TMPDIR=$PWD/.tmp node evals/scripts/eval-adversarial.js   # → evals/reports/adversarial-<TS>.json
```

- PASS (8/10, correctness 1.0): high-frequency, ambiguous, huge-fanout, zero-results (abstain limpio), duplicates, vendor anti-leak, monorepo, polyglot.
- **FAIL con evidencia**: deep-dependency-chain 0.667 (plan concept falla en "dependency injection") y generated-code 0.667 (dist gitignored → invisible a rg).
- Regret 0 en todo; 0 false-confidence (concept falla con confidence < 0.9).

Mitigaciones pendientes (M1-M3): M1 planes concept con fallback estructural/filename (deep-chain); M2 opción --no-ignore opt-in (generated-code, límite de gitignore documentado — no es bug); M3 enforcement estricto de budget o cap top-K fan-out (token explosion en path-clusters) + candidato CF_REOPT lexical-skip para latencia polyglot (4.7s).
