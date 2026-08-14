#!/usr/bin/env bash
# run-oracle.sh — benchmark-harness modo D (enumeracion exhaustiva, T1)
# Uso: run-oracle.sh TASK_ID REPO_DIR
# Enumeracion por category (espejo del optimizer):
#   lexical/dependency/configuration/tests:
#     [search-code], [search-code + search-structure], [search-code + extract-context P 1 30]
#   semantic: los anteriores + [search-semantic <concept>]
# Ejecuta CADA combo en REPO_DIR, mide tokens reales (bytes salida/4);
# optimal_cost = min(tokens combos validos); chosen_ops = combo ganador.
# Si REPO_DIR no existe: exit 0 con row {mode:"D", skipped:true}.
set -uo pipefail

TASK_ID="${1:?uso: run-oracle.sh TASK_ID REPO_DIR}"
REPO_DIR="${2:?uso: run-oracle.sh TASK_ID REPO_DIR}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASKS_JSON="$ROOT/evals/datasets/tasks.json"
SCRIPTS="$ROOT/scripts"

T0="$(date +%s%N)"

emit_row() {
  local tokens="$1" tool_calls="$2" files_json="$3" ops_json="$4" skipped="$5"
  T1="$(date +%s%N)"
  local latency=$(( (T1 - T0) / 1000000 ))
  jq -cn \
    --arg task "$TASK_ID" --arg mode "D" --arg category "$CATEGORY" --arg repo "$REPO" \
    --argjson latency_ms "$latency" --argjson tokens "$tokens" --argjson tool_calls "$tool_calls" \
    --argjson files "$files_json" --argjson dup_tokens 0 \
    --argjson estimated "[]" --argjson chosen_ops "$ops_json" \
    --argjson skipped "$skipped" \
    '{task:$task, mode:$mode, category:$category, repo:$repo, latency_ms:$latency_ms, tokens:$tokens, tool_calls:$tool_calls, files:$files, dup_tokens:$dup_tokens, estimated:$estimated, chosen_ops:$chosen_ops, skipped:$skipped}'
}

TASK="$(jq -c ".[] | select(.id == \"$TASK_ID\")" "$TASKS_JSON" 2>/dev/null)"
if [ -z "$TASK" ]; then
  echo "{\"task\":\"$TASK_ID\",\"mode\":\"D\",\"error\":\"task not found in tasks.json\"}"
  exit 1
fi

CATEGORY="$(jq -r '.category' <<<"$TASK")"
REPO="$(jq -r '.repo' <<<"$TASK")"
CQP="$(jq -r '.cqp' <<<"$TASK")"
SYMBOL="$(jq -r '.symbols[0] // empty' <<<"$TASK")"
PRIMARY1="$(jq -r '.primary[0] // empty' <<<"$TASK")"

if [ ! -d "$REPO_DIR" ]; then
  emit_row 0 0 "[]" "[]" true
  exit 0
fi

# termino de busqueda: symbol > concept > filename
TERM="$SYMBOL"
if [ -z "$TERM" ]; then
  TERM="$(sed -n 's/.*concept "\([^"]*\)".*/\1/p' <<<"$CQP" | awk '{print $1" "$2}')"
fi
if [ -z "$TERM" ]; then
  TERM="$(sed -n 's/.*OF file \([^ ]*\).*/\1/p' <<<"$CQP")"
fi
CONCEPT="$(sed -n 's/.*concept "\([^"]*\)".*/\1/p' <<<"$CQP")"
if [ -n "$SYMBOL" ]; then
  PATTERN="class $SYMBOL"
else
  PATTERN="$TERM"
fi

# --- definicion de combos (arreglo de arreglos "tool|arg1|arg2") ---
case "$CATEGORY" in
  semantic)
    COMBO_SPECS=(
      "search-code|$TERM"
      "search-code|$TERM|search-structure|$PATTERN"
      "search-code|$TERM|extract-context|$PRIMARY1|1|30"
      "search-semantic|$CONCEPT"
    )
    ;;
  *)
    COMBO_SPECS=(
      "search-code|$TERM"
      "search-code|$TERM|search-structure|$PATTERN"
      "search-code|$TERM|extract-context|$PRIMARY1|1|30"
    )
    ;;
esac

# --- ejecutar cada combo, medir tokens reales ---
BEST_TOKENS=-1
BEST_OPS=()
BEST_FILES=""
for spec in "${COMBO_SPECS[@]}"; do
  IFS='|' read -r -a steps <<<"$spec"
  COMBO_OUT=""
  COMBO_OPS=()
  VALID=true
  i=0
  while [ $i -lt ${#steps[@]} ]; do
    TOOL="${steps[$i]}"
    ARG1=""
    ARG2=""
    ARG3=""
    case "$TOOL" in
      search-code) ARG1="${steps[$((i+1))]}"; i=$((i+2)) ;;
      search-structure) ARG1="${steps[$((i+1))]}"; i=$((i+2)) ;;
      search-semantic) ARG1="${steps[$((i+1))]}"; i=$((i+2)) ;;
      extract-context) ARG1="${steps[$((i+1))]}"; ARG2="${steps[$((i+2))]}"; ARG3="${steps[$((i+3))]}"; i=$((i+4)) ;;
    esac
    case "$TOOL" in
      search-code)
        STEP_OUT="$(cd "$REPO_DIR" && "$SCRIPTS/search-code" "$ARG1" 2>/dev/null)"
        RC=$?
        COMBO_OPS+=("search-code $ARG1")
        ;;
      search-structure)
        STEP_OUT="$(cd "$REPO_DIR" && "$SCRIPTS/search-structure" "$ARG1" 2>/dev/null)"
        RC=$?
        [ "$RC" -eq 2 ] && VALID=false   # tool-missing -> combo invalido
        COMBO_OPS+=("search-structure $ARG1")
        ;;
      search-semantic)
        STEP_OUT="$(cd "$REPO_DIR" && "$SCRIPTS/search-semantic" "$ARG1" 2>/dev/null)"
        RC=$?
        [ "$RC" -eq 2 ] && VALID=false   # tool-missing -> combo invalido
        COMBO_OPS+=("search-semantic $ARG1")
        ;;
      extract-context)
        if [ -z "$ARG1" ]; then
          VALID=false   # sin primary -> combo invalido
        else
          STEP_OUT="$(cd "$REPO_DIR" && "$SCRIPTS/extract-context" "$ARG1" "$ARG2" "$ARG3" 2>/dev/null)"
          RC=$?
          [ "$RC" -ne 0 ] && VALID=false # archivo inexistente -> combo invalido
        fi
        COMBO_OPS+=("extract-context $ARG1 $ARG2 $ARG3")
        ;;
    esac
    COMBO_OUT+="
$STEP_OUT"
  done
  [ "$VALID" = false ] && continue

  TOKENS=$(( $(printf '%s' "$COMBO_OUT" | wc -c) / 4 ))
  if [ "$BEST_TOKENS" -lt 0 ] || [ "$TOKENS" -lt "$BEST_TOKENS" ]; then
    BEST_TOKENS="$TOKENS"
    BEST_OPS=("${COMBO_OPS[@]}")
    BEST_FILES="$(printf '%s\n' "$COMBO_OUT" | sed -e 's/:.*//' -e 's#^\./##' | sort -u | grep -v '^$' | jq -R -s -c 'split("\n") | map(select(length > 0))')"
  fi
done

if [ "$BEST_TOKENS" -lt 0 ]; then
  # ningun combo valido (todas las tools faltan / sin primary)
  emit_row 0 0 "[]" "[]" false
else
  OPS_JSON="$(printf '%s\n' "${BEST_OPS[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0))')"
  emit_row "$BEST_TOKENS" "${#BEST_OPS[@]}" "$BEST_FILES" "$OPS_JSON" false
fi
