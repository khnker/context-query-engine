#!/usr/bin/env bash
# plan.sh — plan quality metrics (change benchmark-harness).
# Uso: plan.sh ROW_C ROW_D  →  {"chosen_cost","optimal_cost","regret","est_mae","est_mape"}
set -u
ROW_C="${1:?row modo C}"
ROW_D="${2:?row modo D}"

chosen=$(printf '%s' "$ROW_C" | jq -r '.tokens // 0')
optimal=$(printf '%s' "$ROW_D" | jq -r '.tokens // 0')
regret=$(awk -v c="$chosen" -v o="$optimal" 'BEGIN{ if (o>0) printf "%.4f", (c-o)/o; else print 0 }')

# MAE/MAPE de estimated[] (est_candidates por op) contra tokens reales (chosen).
n=$(printf '%s' "$ROW_C" | jq -r '[.estimated[]?] | length')
mae=0; mape=0
if [ "$n" -gt 0 ] && [ "$chosen" -gt 0 ]; then
  mae=$(printf '%s' "$ROW_C" | jq -r --argjson c "$chosen" '[.estimated[].est_candidates // 0] | map(. - $c | fabs) | add / length')
  mape=$(awk -v m="$mae" -v c="$chosen" 'BEGIN{print m/c}')
fi

printf '{"chosen_cost":%s,"optimal_cost":%s,"regret":%s,"est_mae":%s,"est_mape":%s}\n' "$chosen" "$optimal" "$regret" "$mae" "$mape"
