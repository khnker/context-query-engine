#!/usr/bin/env bash
# run-contextforge.sh — benchmark-harness modo C (engine contextforge)
# Uso: run-contextforge.sh TASK_ID REPO_DIR
# Ejecuta: cd REPO_DIR && node <root>/engine/engine.js '<cqp>'
# Parsea stdout JSON {plan:{selected,plans:[{id,ops}]}, results[], stats{...}}.
# Si el engine falla (exit != 0): emite row con tokens=0, files=[] y "error" (NO aborta).
set -uo pipefail

TASK_ID="${1:?uso: run-contextforge.sh TASK_ID REPO_DIR}"
REPO_DIR="${2:?uso: run-contextforge.sh TASK_ID REPO_DIR}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASKS_JSON="$ROOT/evals/datasets/tasks.json"
ENGINE="$ROOT/engine/engine.js"

T0="$(date +%s%N)"

TASK="$(jq -c ".[] | select(.id == \"$TASK_ID\")" "$TASKS_JSON" 2>/dev/null)"
if [ -z "$TASK" ]; then
  echo "{\"task\":\"$TASK_ID\",\"mode\":\"C\",\"error\":\"task not found in tasks.json\"}"
  exit 1
fi

CATEGORY="$(jq -r '.category' <<<"$TASK")"
REPO="$(jq -r '.repo' <<<"$TASK")"
CQP="$(jq -r '.cqp' <<<"$TASK")"

ERR_FILE="$(mktemp)"
rm -f "$REPO_DIR/.cache.json" "$ROOT/engine/.cache.json"
OUT_RAW="$(cd "$REPO_DIR" && node "$ENGINE" "$CQP" 2>"$ERR_FILE")"
RC=$?
OUT_RAW="$(printf '%s\n' "$OUT_RAW" | head -1)"
T1="$(date +%s%N)"
LATENCY_MS=$(( (T1 - T0) / 1000000 ))

emit_error_row() {
  local msg="$1"
  jq -cn \
    --arg task "$TASK_ID" --arg mode "C" --arg category "$CATEGORY" --arg repo "$REPO" \
    --argjson latency_ms "$LATENCY_MS" --argjson tokens 0 --argjson tool_calls 0 \
    --argjson files "[]" --argjson dup_tokens 0 --argjson estimated "[]" --argjson chosen_ops "[]" \
    --arg error "$msg" \
    '{task:$task, mode:$mode, category:$category, repo:$repo, latency_ms:$latency_ms, tokens:$tokens, tool_calls:$tool_calls, files:$files, dup_tokens:$dup_tokens, estimated:$estimated, chosen_ops:$chosen_ops, error:$error}'
}

if [ "$RC" -ne 0 ]; then
  ERR_MSG="$(jq -r '.error // .' "$ERR_FILE" 2>/dev/null || cat "$ERR_FILE")"
  rm -f "$ERR_FILE"
  emit_error_row "$ERR_MSG"
  exit 0
fi
rm -f "$ERR_FILE"

# stdout del engine debe ser 1 linea JSON
if ! OUT_JSON="$(printf '%s\n' "$OUT_RAW" | jq -c . 2>/dev/null)"; then
  emit_error_row "engine stdout no es JSON valido"
  exit 0
fi

# tokens: stats.tokens_used ?? bytes_salida/4
BYTES="$(printf '%s' "$OUT_RAW" | wc -c)"
FALLBACK=$((BYTES / 4))

jq -c \
  --arg task "$TASK_ID" --arg mode "C" --arg category "$CATEGORY" --arg repo "$REPO" \
  --argjson latency_ms "$LATENCY_MS" --argjson fallback_tokens "$FALLBACK" \
  '. as $o |
   $o.plan as $plan |
   ($plan.selected // ($plan.plans[0].id // "")) as $sel |
   ([$plan.plans[] | select(.id == $sel)][0].ops // []) as $ops |
   {
     task: $task, mode: $mode, category: $category, repo: $repo,
     latency_ms: $latency_ms,
      tokens: ($o.stats.tokens_used // $fallback_tokens),
      tool_calls: ($o.stats.tool_calls // 0),
      files: ([($o.results // [])[]?.path? // empty] | unique | map(sub("^\\./";""))),
      dup_tokens: (
        (([($o.results // [])[].token_estimate // 0] | add // 0)) -
        (([($o.results // []) | group_by(.path)[] | .[0].token_estimate // 0] | add // 0))
      ),
     estimated: [$ops[] | {tool, est_candidates}],
     chosen_ops: [$ops[] | .tool],
     early_terminated: $o.stats.early_terminated,
     cache_hits: ($o.stats.cache_hits // 0),
     cached: $o.cached
   }' <<<"$OUT_JSON"
