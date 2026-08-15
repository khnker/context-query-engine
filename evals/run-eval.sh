#!/usr/bin/env bash
# run-eval.sh — orquestador del benchmark (change benchmark-harness).
# Uso: run-eval.sh [--tier t1] [--limit N] [--oracle on|off] [--out FILE]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIER="t1"
LIMIT=""
ORACLE="on"
OUT="evals/reports/run-$(date +%s).ndjson"
R=$(dirname "$0")/runners

while [ $# -gt 0 ]; do
  case "$1" in
    --tier) TIER="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --oracle) ORACLE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "usage: run-eval.sh [--tier t1] [--limit N] [--oracle on|off] [--out FILE]" >&2; exit 1 ;;
  esac
done

TASKS="$ROOT/evals/datasets/tasks.json"
REPOS_YAML="$ROOT/evals/datasets/repositories.yaml"
case "$OUT" in
  /*) : ;;
  *) OUT="$ROOT/$OUT" ;;
esac

# ids de repos del tier (parse simple de yaml)
repo_ids=$(awk '/^  '"$TIER"':/{f=1;next} f && /^  [a-z0-9]+:/{f=0} f' "$REPOS_YAML" | grep -- "- id:" | awk '{print $3}' | grep -v '^$' | tr '\n' ' ')
[ -z "$repo_ids" ] && repo_ids="t1-basic t1-modular"
[ -z "$repo_ids" ] && { echo "tier $TIER sin repos" >&2; exit 1; }

# tasks del tier (orden estable)
tasks=$(jq -c --argjson ids "$(printf '%s' "$repo_ids" | jq -R -s -c 'split(" ") | map(select(. != ""))')" '
  [.[] | select(.repo as $r | $ids | index($r))] | sort_by(.id)' "$TASKS")
total=$(printf '%s' "$tasks" | jq 'length')
[ "$total" -eq 0 ] && { echo "0 tasks para tier $TIER" >&2; exit 1; }
[ -n "$LIMIT" ] && total=$LIMIT

mkdir -p "$ROOT/evals/reports"
: > "$OUT"
i=0
while [ $i -lt "$total" ]; do
  task_json=$(printf '%s' "$tasks" | jq -c ".[$i]")
  tid=$(printf '%s' "$task_json" | jq -r '.id')
  repo=$(printf '%s' "$task_json" | jq -r '.repo')
  rdir="$ROOT/evals/datasets/repos/$repo"
  if [ ! -d "$rdir" ]; then
    rdir=$(grep -A2 -- "- id: $repo\$" "$REPOS_YAML" | grep "path:" | head -1 | awk '{print $2}')
  fi
  [ -d "$rdir" ] || rdir="."

  # modo A (baseline) primero — compression lo necesita
  row_a=$(cd "$ROOT" && "$R/run-raw-fs.sh" "$tid" "$rdir" 2>/dev/null)
  base_t=$(printf '%s' "$row_a" | jq -r '.tokens // 0')
  row_b=$(cd "$ROOT" && "$R/run-rg-fd.sh" "$tid" "$rdir" 2>/dev/null)
  row_c=$(cd "$ROOT" && "$R/run-contextforge.sh" "$tid" "$rdir" 2>/dev/null)
  row_d=""
  [ "$ORACLE" = "on" ] && row_d=$(cd "$ROOT" && "$R/run-oracle.sh" "$tid" "$rdir" 2>/dev/null)

  for row in "$row_a" "$row_b" "$row_c" "$row_d"; do
    [ -z "$row" ] && continue
    mode=$(printf '%s' "$row" | jq -r '.mode')
    [ "$mode" = "null" ] && continue
    err=$(printf '%s' "$row" | jq -r '.error // empty'); [ -n "$err" ] && { printf '%s\n' "$row" >> "$OUT"; continue; }
    skip=$(printf '%s' "$row" | jq -r '.skipped // empty'); [ "$skip" = "true" ] && continue

    ret=$(bash "$ROOT/evals/metrics/retrieval.sh" "$row" "$TASKS")
    ctx=$(bash "$ROOT/evals/metrics/context.sh" "$row" "$TASKS" "$base_t")
    plan="{}"
    [ "$mode" = "C" ] && [ -n "$row_d" ] && plan=$(bash "$ROOT/evals/metrics/plan.sh" "$row" "$row_d")

    merged=$(printf '%s' "$row" "$ret" "$ctx" "$plan" | jq -cs 'add')
    printf '%s\n' "$merged" >> "$OUT"
  done
  echo "task $((i+1))/$total $tid" >&2
  i=$((i+1))
done

cp "$OUT" "$ROOT/evals/reports/latest.ndjson"
echo "rows: $(wc -l < "$OUT") -> $ROOT/$OUT" >&2
