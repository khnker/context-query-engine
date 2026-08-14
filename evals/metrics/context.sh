#!/usr/bin/env bash
# context.sh — metrics de contexto (change benchmark-harness).
# Uso: context.sh ROW_FILE TASKS_FILE BASELINE_TOKENS  →  {"efficiency","compression","wrong_tokens","density"}
# Nota: precision a nivel de archivo (ver retrieval.sh) → wrong_tokens = tokens * (1 - precision).
set -u
ROW="${1:?row ndjson}"
TASKS="${2:?tasks.json}"
BASELINE="${3:-0}"

ret=$(bash "$(dirname "$0")/retrieval.sh" "$ROW" "$TASKS")
precision=$(printf '%s' "$ret" | jq -r '.precision')
success=$(printf '%s' "$ret" | jq -r '.success')
tokens=$(printf '%s' "$ROW" | jq -r '.tokens // 0')

wrong=$(awk -v t="$tokens" -v p="$precision" 'BEGIN{printf "%.0f", t*(1-p)}')
compression=$(awk -v b="$BASELINE" -v t="$tokens" 'BEGIN{print (t>0? b/t : 1)}')
density=$(awk -v w="$wrong" -v t="$tokens" -v s="$success" 'BEGIN{ if (t>0 && s!="incorrect") printf "%.4f", 1-(w/t); else print 0 }')

printf '{"efficiency":%s,"compression":%s,"wrong_tokens":%s,"density":%s}\n' "$precision" "$compression" "$wrong" "$density"
