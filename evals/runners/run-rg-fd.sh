#!/usr/bin/env bash
# run-rg-fd.sh — benchmark-harness modo B (skill rg/fd: search-code/search-structure)
# Uso: run-rg-fd.sh TASK_ID REPO_DIR
# Emite UNA linea NDJSON a stdout (dup_tokens = tokens - tokens_unicos).
# Solo modos B/C calculan dup_tokens.
set -uo pipefail

TASK_ID="${1:?uso: run-rg-fd.sh TASK_ID REPO_DIR}"
REPO_DIR="${2:?uso: run-rg-fd.sh TASK_ID REPO_DIR}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASKS_JSON="$ROOT/evals/datasets/tasks.json"

T0="$(date +%s%N)"

TASK="$(jq -c ".[] | select(.id == \"$TASK_ID\")" "$TASKS_JSON" 2>/dev/null)"
if [ -z "$TASK" ]; then
  echo "{\"task\":\"$TASK_ID\",\"mode\":\"B\",\"error\":\"task not found in tasks.json\"}"
  exit 1
fi

CATEGORY="$(jq -r '.category' <<<"$TASK")"
REPO="$(jq -r '.repo' <<<"$TASK")"
CQP="$(jq -r '.cqp' <<<"$TASK")"
SYMBOL="$(jq -r '.symbols[0] // empty' <<<"$TASK")"
EXPECTS_STRUCTURE="$(jq -r '[.expected_operations[]] | index("search-structure") != null' <<<"$TASK")"

# termino de busqueda: symbol > concept (2 palabras) > filename
TERM="$SYMBOL"
if [ -z "$TERM" ]; then
  TERM="$(sed -n 's/.*concept "\([^"]*\)".*/\1/p' <<<"$CQP" | awk '{print $1" "$2}')"
fi
if [ -z "$TERM" ]; then
  TERM="$(sed -n 's/.*OF file \([^ ]*\).*/\1/p' <<<"$CQP")"
fi

OPS=()
OUT=""
NCMDS=0

# 1) search-code -l (skill rg)
OUT="$(cd "$REPO_DIR" && "$ROOT/scripts/search-code" -l "$TERM" 2>/dev/null || true)"
OPS+=("search-code -l $TERM")
NCMDS=1

# 2) search-structure si la tarea lo espera (patron = simbolo simple, ej. 'class ProviderRouter'; si falla, continuar)
if [ "$EXPECTS_STRUCTURE" = "true" ]; then
  if [ -n "$SYMBOL" ]; then
    PATTERN="class $SYMBOL"
  else
    PATTERN="$TERM"
  fi
  STRUCT_OUT="$(cd "$REPO_DIR" && "$ROOT/scripts/search-structure" "$PATTERN" 2>/dev/null || true)"
  OPS+=("search-structure $PATTERN")
  NCMDS=$((NCMDS + 1))
  OUT+="
$STRUCT_OUT"
fi

# 3) metricas
BYTES="$(printf '%s' "$OUT" | wc -c)"
TOKENS=$((BYTES / 4))
UNIQ_BYTES="$(printf '%s\n' "$OUT" | sort -u | grep -v '^$' | wc -c)"
UNIQ_TOKENS=$((UNIQ_BYTES / 4))
DUP_TOKENS=$((TOKENS - UNIQ_TOKENS))
[ "$DUP_TOKENS" -lt 0 ] && DUP_TOKENS=0
FILES_JSON="$(printf '%s\n' "$OUT" | sed -e 's/:.*//' -e 's#^\./##' | sort -u | grep -v '^$' | jq -R -s -c 'split("\n") | map(select(length > 0))')"
OPS_JSON="$(printf '%s\n' "${OPS[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0))')"
T1="$(date +%s%N)"
LATENCY_MS=$(( (T1 - T0) / 1000000 ))

jq -cn \
  --arg task "$TASK_ID" --arg mode "B" --arg category "$CATEGORY" --arg repo "$REPO" \
  --argjson latency_ms "$LATENCY_MS" --argjson tokens "$TOKENS" --argjson tool_calls "$NCMDS" \
  --argjson files "$FILES_JSON" --argjson dup_tokens "$DUP_TOKENS" \
  --argjson estimated "[]" --argjson chosen_ops "$OPS_JSON" \
  '{task:$task, mode:$mode, category:$category, repo:$repo, latency_ms:$latency_ms, tokens:$tokens, tool_calls:$tool_calls, files:$files, dup_tokens:$dup_tokens, estimated:$estimated, chosen_ops:$chosen_ops}'
