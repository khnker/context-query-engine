#!/usr/bin/env bash
# test-eval.sh — e2e del harness (change benchmark-harness, task 4.5).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP=/tmp/eval-test.ndjson

echo "run-eval (limit 5)..."
bash "$ROOT/evals/run-eval.sh" --tier t1 --limit 5 --out "$TMP" >/dev/null 2>&1
rows=$(wc -l < "$TMP")
[ "$rows" -ge 10 ] || { echo "FAIL: pocas rows ($rows)" >&2; exit 1; }

echo "analyze..."
bash "$ROOT/evals/analyze-eval.sh" --in "$TMP" >/dev/null 2>&1
[ -f "$ROOT/evals/reports/latest.json" ] || { echo "FAIL: latest.json no generado" >&2; exit 1; }

modes=$(jq -r '.summary.modes | map(.mode) | join(",")' "$ROOT/evals/reports/latest.json")
verdict=$(jq -r '.verdict' "$ROOT/evals/reports/latest.json")
echo "PASS: $rows rows, modos: $modes, verdict: $verdict"
