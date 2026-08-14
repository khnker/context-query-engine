#!/usr/bin/env bash
# analyze-eval.sh — agregación + ranking + veredicto + regresión (change benchmark-harness).
# Uso: analyze-eval.sh [--in evals/reports/latest.ndjson] [--baseline evals/reports/previous.ndjson]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IN="$ROOT/evals/reports/latest.ndjson"
BASE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --in) IN="$2"; shift 2 ;;
    --baseline) BASE="$2"; shift 2 ;;
    *) echo "usage: analyze-eval.sh [--in FILE] [--baseline FILE]" >&2; exit 1 ;;
  esac
done

[ -f "$IN" ] || { echo '{"error":"input ndjson not found"}' >&2; exit 2; }

AGG=$(jq -s '
  group_by(.mode)
  | map({
      mode: .[0].mode,
      count: length,
      avg_tokens: (map(.tokens // 0) | add / length),
      avg_latency_ms: (map(.latency_ms // 0) | add / length),
      avg_tool_calls: (map(.tool_calls // 0) | add / length),
      success_rate: ((map(select(.success == "correct" or .success == "partial")) | length) / length),
      avg_precision: (map(.precision // 0) | add / length),
      avg_recall: (map(.recall // 0) | add / length),
      avg_efficiency: (map(.efficiency // 0) | add / length),
      avg_compression: (map(.compression // 0) | add / length),
      avg_wrong_tokens: (map(.wrong_tokens // 0) | add / length),
      avg_dup_tokens: (map(.dup_tokens // 0) | add / length),
      avg_density: (map(.density // 0) | add / length),
      avg_regret: (map(.regret // 0) | add / length)
    })
  | sort_by(.mode)
' "$IN")

[ "$(printf '%s' "$AGG" | jq 'length')" -lt 2 ] && { echo '{"error":"insufficient data"}' >&2; exit 2; }

RANK=$(printf '%s' "$AGG" | jq 'sort_by(.avg_density) | reverse | map({mode, avg_density})')

D=$(printf '%s' "$AGG" | jq -r 'map(select(.mode=="C") | .avg_density) | .[0] // 0')
B=$(printf '%s' "$AGG" | jq -r 'map(select(.mode=="B") | .avg_density) | .[0] // 0')
A=$(printf '%s' "$AGG" | jq -r 'map(select(.mode=="A") | .avg_density) | .[0] // 0')
CS=$(printf '%s' "$AGG" | jq -r 'map(select(.mode=="C") | .success_rate) | .[0] // 0')
AS=$(printf '%s' "$AGG" | jq -r 'map(select(.mode=="A") | .success_rate) | .[0] // 0')
CT=$(printf '%s' "$AGG" | jq -r 'map(select(.mode=="C") | .avg_tokens) | .[0] // 0')
AT=$(printf '%s' "$AGG" | jq -r 'map(select(.mode=="A") | .avg_tokens) | .[0] // 0')

# Veredicto basado en evidencia (amended en benchmark-harness): el engine (C) gana si
# mantiene task success ≥ 0.90 y corta contexto a ≤ 50% del baseline bruto (A).
# El ranking por density queda informativo (A "cheatea": cat solo primary → density alta).
VERDICT="PASS"
awk "BEGIN{ if ($CS >= 0.90 && $CT <= 0.5*$AT) exit 0; exit 1 }" || VERDICT="FAIL"

REG='{"verdict":"N/A","baseline_avg_density":0,"delta":0}'
if [ -n "$BASE" ] && [ -f "$BASE" ]; then
  if [ "$(wc -l < "$BASE")" -ge 5 ]; then
    BD=$(jq -s '[.[] | select(.mode=="C") | .density // 0] | add / length' "$BASE")
    delta=$(awk -v b="$BD" -v d="$D" 'BEGIN{printf "%.4f", d-b}')
    rv="PASS"; awk "BEGIN{ if ($delta < -0.05) exit 0; exit 1 }" && rv="FAIL"
    REG=$(printf '{"verdict":"%s","baseline_avg_density":%s,"delta":%s}' "$rv" "$BD" "$delta")
  fi
fi

jq -n --argjson agg "$AGG" --argjson rank "$RANK" --argjson reg "$REG" --arg verdict "$VERDICT" \
  '{summary: {tasks: (input_filename), modes: $agg}, ranking: $rank, regression: $reg, verdict: $verdict}' > "$ROOT/evals/reports/latest.json"

jq . "$ROOT/evals/reports/latest.json"
[ "$VERDICT" = "PASS" ] || exit 1
exit 0
