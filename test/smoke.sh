#!/usr/bin/env bash
# test/smoke.sh — smoke tests bash (tasks 5.x, D23).
# 5.1 bash -n de los 9 scripts + check-tools; 5.2 pipeline search-code → assemble-context.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }
assert_eq() {
  if [ "$1" = "$2" ]; then pass "$3";
  else fail "$3 (got='$1' expected='$2')"; fi
}

# 5.1 — sintaxis de los 9 scripts
for s in assemble-context check-tools extract-context inspect-json project-map \
         retrieval-metrics search-code search-semantic search-structure; do
  if bash -n "$ROOT/scripts/$s" 2>/dev/null; then pass "syntax $s"; else fail "syntax $s"; fi
done

# check-tools exit 0
if bash "$ROOT/scripts/check-tools" >/dev/null 2>&1; then pass "check-tools"; else fail "check-tools"; fi

# 5.2 — pipeline funcional: search-code → NDJSON → assemble-context (tier presente)
OUT="$("$ROOT/scripts/search-code" -l -d engine parseAST 2>/dev/null | head -20 \
  | jq -R -c '{path:., line_start:1, line_end:1, match_type:"filename", score:1, token_estimate:5, source:"search-code", reason:"smoke"}' \
  | "$ROOT/scripts/assemble-context" 2000 2>/dev/null || true)"
if [ -n "$OUT" ]; then pass "pipeline produce líneas de salida"; else fail "pipeline produce líneas de salida"; fi
if printf '%s' "$OUT" | grep -q '"tier"'; then pass "pipeline search-code→assemble-context (tier presente)";
else fail "pipeline search-code→assemble-context (tier presente)"; fi

# retrieval-metrics record/report (smoke mínimo)
RM="$ROOT/scripts/retrieval-metrics"
if [ -f "$RM" ]; then
  if bash "$RM" record smoke_test '{"query":"smoke","results":1,"relevant":1,"tokens":10,"latency_ms":5}' >/dev/null 2>&1 \
     && bash "$RM" report smoke_test >/dev/null 2>&1; then pass "retrieval-metrics record/report";
  else fail "retrieval-metrics record/report"; fi
else fail "retrieval-metrics no existe"; fi

exit "$FAIL"
