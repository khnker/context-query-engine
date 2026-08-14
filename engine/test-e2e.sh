#!/usr/bin/env bash
# engine/test-e2e.sh — E2E smoke (tasks 6.1): runCQP real sobre el repo.
# Usa la API pública (runCQP/clearCache, D22): cache limpio → 2ª corrida cache_hits=1.
# Verifica: plan.selected, results no vacío, cache_hits en 2ª corrida,
# y early_terminated o tokens_used > 0 en la 1ª.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
Q="find definitions of symbol parseAST"

Q="$Q" node --input-type=module -e '
import { runCQP, clearCache } from "./engine/engine.js";
clearCache();
const a = await runCQP(process.env.Q);
const b = await runCQP(process.env.Q);
const checks = [
  [typeof a.plan?.selected === "string" && a.plan.selected.length > 0, "plan.selected presente"],
  [Array.isArray(a.results) && a.results.length > 0, "results array no vacío"],
  [typeof a.stats?.cache_hits === "number" && a.stats.cache_hits === 0, "1ª corrida cache_hits = 0"],
  [b.stats?.cache_hits === 1, "2ª corrida cache_hits = 1"],
  [b.cached === true, "2ª corrida cached = true"],
  [a.stats?.early_terminated === true || (a.stats?.tokens_used ?? 0) > 0, "early_terminated o tokens_used > 0"],
];
let fail = 0;
for (const [ok, desc] of checks) {
  console.log((ok ? "PASS: " : "FAIL: ") + desc);
  if (!ok) fail = 1;
}
process.exit(fail);
' 2>/dev/null || exit 1
