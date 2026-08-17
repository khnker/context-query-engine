# Adaptive plan selection (REJECT)

> Veredicto: REJECT

CF_ADAPTIVE=1: el belief state (agreement/coverage pre-fuse) decide adquisición extra — flood (coverage > 0.85, n_pool > 30, agreement < 0.5) → symbol-lookup; divergencia de fuentes (agreement < 0.5) → bm25 + dependency-expand. Eval 62 queries (T1+adv): correctness 0.839 = 0.839 (parity), flood detectado en 14, **recovery 0** — la evidencia adquirida (structural 0.7) rankea bajo el flood rg 'exact' (1.0) y el budget se consume antes del GT (adv-po-30: pool 35k rows → gt 0).

Variante descartada con evidencia: descartar la fuente inundada rompe correctness (0.839→0.710) — la fuente flood suele contener el GT (logger/env multi-hit). Mitigación correcta (derivada): boost de prioridad de evidencia adquirida en fuse o cap diverso pre-fuse. CF_ADAPTIVE queda disponible, OFF por default.
