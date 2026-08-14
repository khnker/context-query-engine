#!/usr/bin/env bash
# retrieval.sh — metrics de retrieval vs ground truth (change benchmark-harness).
# Uso: retrieval.sh ROW_FILE TASKS_FILE  →  {"success","precision","recall"}
# Nota: las rows solo llevan files[] (no tokens por archivo) → precision/recall son
# a nivel de ARCHIVO (aprox documentada), no de tokens.
set -u
ROW="${1:?row ndjson}"
TASKS="${2:?tasks.json}"

task=$(printf '%s' "$ROW" | jq -r '.task // empty')
[ -z "$task" ] && { echo '{"success":"incorrect","precision":0,"recall":0}'; exit 0; }

files=$(printf '%s' "$ROW" | jq -r '.files[]? // empty' | sed 's|^\./||')
tokens=$(printf '%s' "$ROW" | jq -r '.tokens // 0')

primary=$(jq -r --arg t "$task" '.[] | select(.id==$t) | .primary[]?' "$TASKS" | sed 's|^\./||')
related=$(jq -r --arg t "$task" '.[] | select(.id==$t) | .related[]?' "$TASKS" | sed 's|^\./||')
tests=$(jq -r --arg t "$task" '.[] | select(.id==$t) | .tests[]?' "$TASKS" | sed 's|^\./||')
ground=$( { printf '%s\n' "$primary"; printf '%s\n' "$related"; printf '%s\n' "$tests"; } | grep -v '^$' | sort -u )

pcount=$(printf '%s\n' "$primary" | grep -v '^$' | sort -u | wc -l)
pfound=0
match() { # $1=path fila (abs/rel)  $2=ground truth relativo → match exacto o por sufijo
  [ "$1" = "$2" ] && return 0
  case "/$1" in */"$2") return 0 ;; esac
  return 1
}
for f in $primary; do
  [ -z "$f" ] && continue
  for rf in $files; do
    match "$rf" "$f" && { pfound=$((pfound + 1)); break; }
  done
done

gt_hits=0
total_files=$(printf '%s\n' "$files" | grep -v '^$' | wc -l)
for rf in $files; do
  [ -z "$rf" ] && continue
  for f in $ground; do
    match "$rf" "$f" && { gt_hits=$((gt_hits + 1)); break; }
  done
done

if [ "$pcount" -gt 0 ] && [ "$pfound" -ge "$pcount" ]; then success=correct
elif [ "$pfound" -gt 0 ]; then success=partial
else success=incorrect; fi

precision=$(awk -v h="$gt_hits" -v t="$total_files" 'BEGIN{print (t>0? h/t : 0)}')
recall=$(awk -v p="$pfound" -v n="$pcount" 'BEGIN{print (n>0? p/n : 0)}')

printf '{"success":"%s","precision":%s,"recall":%s}\n' "$success" "$precision" "$recall"
