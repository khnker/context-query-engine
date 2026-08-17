# CQE Thesis (B16) — paper/architecture doc

> Veredicto: paper - 23 claims con artifact

Tesis completa en [`docs/THESIS.md`](docs/THESIS.md): CQE como **adquisición adaptativa de evidencia** bajo incertidumbre y presupuesto. Problema formal, arquitectura (Evidence Model → VoI planning → budgeted selection), **23 claims con artifact por claim** (tabla: verdict / `evals/reports/*.json` / change archivado), límites y roadmap v1.7.

Hallazgo central de la síntesis: lo que sobrevive es la **capa de evidencia** (tipado, provenance, fusión por rango, tier-0 anclado); lo que falla o queda en parity es la **predicción pre-ejecución del valor downstream** (pairwise, hints, VoI, costos calibrados — la señal no existe antes del runtime y la calibración no transfiere OOD).
