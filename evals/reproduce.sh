#!/usr/bin/env bash
# evals/reproduce.sh — G2: protocolo de evaluación reproducible.
# Reconstruye un benchmark desde cero y produce artefacto verificable:
#   evals/results/<BENCH>-<TS>/{environment.json, queries.jsonl, raw-runs.ndjson,
#   optimizer-eval.json, raw-results.jsonl, metrics.json, statistical-tests.json, report.md}
# Uso: ./evals/reproduce.sh <T1|T2|dev> [--limit N] [--runs N] [--warmup N] [--smoke]
# Exit: 0 = PASS (thresholds cumplidos), 1 = FAIL, 2 = error de uso.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH="${1:-T1}"
[[ "$BENCH" == "T1" || "$BENCH" == "T2" || "$BENCH" == "dev" ]] || { echo "benchmark inválido: $BENCH (T1|T2|dev)" >&2; exit 2; }
shift || true

LIMIT=""; RUNS=3; WARMUP=1; SMOKE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --warmup) WARMUP="$2"; shift 2 ;;
    --smoke) SMOKE=1; LIMIT=2; RUNS=1; WARMUP=0; shift ;;
    *) echo "uso: reproduce.sh <T1|T2|dev> [--limit N] [--runs N] [--warmup N] [--smoke]" >&2; exit 2 ;;
  esac
done

export TMPDIR="$ROOT/.tmp"   # /tmp tmpfs 80% llena (EDQUOT)
mkdir -p "$TMPDIR" "$ROOT/evals/results"
MANIFEST="$ROOT/evals/manifests/$BENCH.json"
OUT="$ROOT/evals/results/$BENCH-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$OUT"

echo "== reproduce.sh $BENCH → $OUT"
CF_TASKS=""
[[ "$BENCH" == "dev" ]] && CF_TASKS=dev
[[ "$BENCH" == "T1" ]] && CF_TASKS=t1
[[ -n "$LIMIT" ]] && echo "== limit $LIMIT queries (verificación parcial, veredicto no representativo)" || true

# 1. cache limpio — nunca medir con resultados previos
rm -f "$ROOT/engine/.cache.json"

# 2. dataset congelado: copia del queries dataset
QSRC="$ROOT/evals/datasets/tasks.json"
[[ "$BENCH" == "dev" ]] && QSRC="$ROOT/evals/datasets/tasks-dev.json"
[[ "$BENCH" == "T2" ]] && QSRC="$ROOT/evals/datasets/queries-test.jsonl"
cp "$QSRC" "$OUT/queries.jsonl"

# 3. fingerprint de entorno (machine/commits/model sha)
node "$ROOT/evals/scripts/env-fingerprint.js" "$MANIFEST" > "$OUT/environment.json"

# 4. eval-recall: heurístico + reranker (si modelo existe), runs × warmup, orden randomizado seed 42
MODEL_CMD=""
[[ -f "$ROOT/evals/ml/model/reranker-model.json" ]] && MODEL_CMD="node $ROOT/evals/ml/classify.mjs"
evalrecall() {
  local extra=() lflag=()
  [[ -n "$MODEL_CMD" ]] && extra=(CF_MODEL_CMD="$MODEL_CMD")
  [[ -n "${CF_REOPT:-}" ]] && extra+=(CF_REOPT="$CF_REOPT")
  [[ -n "$LIMIT" ]] && lflag=(--limit "$LIMIT")
  env CF_RUNS="$RUNS" CF_WARMUP="$WARMUP" CF_SEED=42 CF_RAW_OUT="$OUT/raw-runs.ndjson" \
    CF_TASKS="$CF_TASKS" "${extra[@]}" \
    timeout 900 node "$ROOT/evals/scripts/eval-recall.js" --json "${lflag[@]}" > "$OUT/eval-recall.json" 2> "$OUT/eval-recall.err"
}
evalrecall || { echo "eval-recall falló: $(cat "$OUT/eval-recall.err")" >&2; exit 2; }

# 5. eval-optimizer (oracle/regret) — solo con queries suficientes; dev solo con --limit pequeño (timeout dev-13)
NQ=$(jq -r '.summary.tasks // 0' "$OUT/eval-recall.json" 2>/dev/null || echo 0)
RUN_OPT=0
if [[ "$BENCH" == "dev" && -z "$LIMIT" ]]; then
  echo "== optimizer: omitido en dev sin --limit (dev-13 puede colgar >15min); corre con --limit 3"
elif [[ "$NQ" -ge 3 ]]; then
  RUN_OPT=1
fi
if [[ "$RUN_OPT" -eq 1 ]]; then
  rm -f "$ROOT/evals/reports/optimizer-eval.json"
  if [[ -n "$LIMIT" ]]; then
    timeout 300 node "$ROOT/evals/scripts/eval-optimizer.js" --limit "$LIMIT" > /dev/null 2>&1
  else
    timeout 300 node "$ROOT/evals/scripts/eval-optimizer.js" > /dev/null 2>&1
  fi
  [[ -f "$ROOT/evals/reports/optimizer-eval.json" ]] && cp "$ROOT/evals/reports/optimizer-eval.json" "$OUT/optimizer-eval.json" || echo "== optimizer: sin output (¿queries con GT?)"
fi

# 5.5 planner-isolation (mismo report de eval-optimizer, artefacto dedicado)
PI=$(ls -t "$ROOT"/evals/reports/planner-isolation-*.json 2>/dev/null | head -1)
[[ -n "$PI" ]] && cp "$PI" "$OUT/planner-isolation.json" || echo "== planner-isolation: sin artefacto (correr eval-optimizer.js primero)"

# 6. ensamblar artefacto + veredicto (PASS/FAIL por thresholds del manifest)
node "$ROOT/evals/scripts/assemble-report.js" "$OUT" "$MANIFEST"; RC=$?
echo "== artefacto: $OUT"
exit $RC
