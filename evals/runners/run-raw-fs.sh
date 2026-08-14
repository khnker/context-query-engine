#!/usr/bin/env bash
# run-raw-fs.sh — benchmark-harness modo A (baseline bruto)
# Uso: run-raw-fs.sh TASK_ID REPO_DIR
# Emite UNA linea NDJSON a stdout:
#   {"task":"lex-01","mode":"A","category":"lexical","repo":"t1-basic",
#    "latency_ms":N,"tokens":N,"tool_calls":N,"files":[...],"dup_tokens":0,
#    "estimated":[],"chosen_ops":["grep -rn ..."]}
# Estrategia: grep/find bruto + cat completo de cada primary (deliberadamente ineficiente).
set -uo pipefail

TASK_ID="${1:?uso: run-raw-fs.sh TASK_ID REPO_DIR}"
REPO_DIR="${2:?uso: run-raw-fs.sh TASK_ID REPO_DIR}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASKS_JSON="$ROOT/evals/datasets/tasks.json"

T0="$(date +%s%N)"

TASK="$(jq -c ".[] | select(.id == \"$TASK_ID\")" "$TASKS_JSON" 2>/dev/null)"
if [ -z "$TASK" ]; then
  echo "{\"task\":\"$TASK_ID\",\"mode\":\"A\",\"error\":\"task not found in tasks.json\"}"
  exit 1
fi

CATEGORY="$(jq -r '.category' <<<"$TASK")"
REPO="$(jq -r '.repo' <<<"$TASK")"
CQP="$(jq -r '.cqp' <<<"$TASK")"
SYMBOL="$(jq -r '.symbols[0] // empty' <<<"$TASK")"
PRIMARY="$(jq -r '.primary[]' <<<"$TASK")"

OPS=()
SEARCH_OUT=""
CAT_OUT=""
NCMDS=0

# 1) busqueda bruta segun tipo de tarea
if [[ "$CQP" == *"filename OF file"* ]]; then
  # filename/cfg-03/tst-05: find por nombre (del cqp, fallback query)
  NAME="$(sed -n 's/.*OF file \([^ ]*\).*/\1/p' <<<"$CQP")"
  if [ -z "$NAME" ]; then
    NAME="$(jq -r '.query' <<<"$TASK" | sed -n 's/.*\([a-zA-Z0-9_.-]*\.[a-zA-Z0-9_]*\).*/\1/p')"
  fi
  CMD="find . -type f -name \"$NAME\" --exclude-dir=node_modules --exclude-dir=.git"
  SEARCH_OUT="$(cd "$REPO_DIR" && find . -type f -name "$NAME" -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null || true)"
  OPS+=("$CMD")
  NCMDS=1
elif [ -n "$SYMBOL" ]; then
  # identifier/categorias con symbol: grep -rn
  CMD="grep -rn \"$SYMBOL\" . --exclude-dir=node_modules --exclude-dir=.git"
  SEARCH_OUT="$(cd "$REPO_DIR" && grep -rn "$SYMBOL" . --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null || true)"
  OPS+=("$CMD")
  NCMDS=1
else
  # semantic/concept: grep -rni con 2 palabras clave (del concept del cqp, fallback query)
  KW="$(sed -n 's/.*concept "\([^"]*\)".*/\1/p' <<<"$CQP" | awk '{print $1" "$2}')"
  if [ -z "$KW" ]; then
    KW="$(jq -r '.query' <<<"$TASK" | tr '?' ' ' | tr -s ' ' | awk '{print $1" "$2}')"
  fi
  CMD="grep -rni \"$KW\" . --exclude-dir=node_modules --exclude-dir=.git"
  SEARCH_OUT="$(cd "$REPO_DIR" && grep -rni "$KW" . --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null || true)"
  OPS+=("$CMD")
  NCMDS=1
fi

# 2) DESPUES siempre: cat completo de cada primary (baseline ineficiente)
while IFS= read -r f; do
  [ -n "$f" ] || continue
  CMD="cat $f"
  CAT_OUT+="$(cd "$REPO_DIR" && cat "$f" 2>/dev/null || true)"
  OPS+=("$CMD")
  NCMDS=$((NCMDS + 1))
done <<<"$PRIMARY"

# 3) metricas
OUT="$SEARCH_OUT
$CAT_OUT"
BYTES="$(printf '%s' "$OUT" | wc -c)"
TOKENS=$((BYTES / 4))
FILES_JSON="$({ printf '%s\n' "$SEARCH_OUT" | sed -e 's/:.*//' -e 's#^\./##'; printf '%s\n' $PRIMARY; } | sort -u | grep -v '^$' | jq -R -s -c 'split("\n") | map(select(length > 0))')"
OPS_JSON="$(printf '%s\n' "${OPS[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0))')"
T1="$(date +%s%N)"
LATENCY_MS=$(( (T1 - T0) / 1000000 ))

jq -cn \
  --arg task "$TASK_ID" --arg mode "A" --arg category "$CATEGORY" --arg repo "$REPO" \
  --argjson latency_ms "$LATENCY_MS" --argjson tokens "$TOKENS" --argjson tool_calls "$NCMDS" \
  --argjson files "$FILES_JSON" --argjson dup_tokens 0 \
  --argjson estimated "[]" --argjson chosen_ops "$OPS_JSON" \
  '{task:$task, mode:$mode, category:$category, repo:$repo, latency_ms:$latency_ms, tokens:$tokens, tool_calls:$tool_calls, files:$files, dup_tokens:$dup_tokens, estimated:$estimated, chosen_ops:$chosen_ops}'
