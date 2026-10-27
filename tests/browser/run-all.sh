#!/bin/bash
# run-all.sh — Run every Insight Replay browser E2E spec sequentially.
#
# Prints a per-spec line and a final summary. Exits 0 only if every spec
# passes; exits 1 otherwise.

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SPECS=(
  "01-dashboard.spec.sh"
  "02-navigation.spec.sh"
  "03-recording-player.spec.sh"
  "04-live-tab.spec.sh"
  "05-funnels.spec.sh"
)

PASSED=0
FAILED=0
FAILED_NAMES=()

echo "==========================================="
echo " Insight Replay — Browser E2E Test Suite"
echo "==========================================="

for spec in "${SPECS[@]}"; do
  path="$DIR/$spec"
  echo ""
  echo "--- Running: $spec ---"
  if bash "$path" 2>&1; then
    PASSED=$((PASSED + 1))
    echo ">>> $spec: PASS"
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$spec")
    echo ">>> $spec: FAIL"
  fi
done

echo ""
echo "==========================================="
echo " SUMMARY: $PASSED passed, $FAILED failed (of ${#SPECS[@]} specs)"
if [[ "$FAILED" -gt 0 ]]; then
  echo " Failed specs: ${FAILED_NAMES[*]}"
fi
echo "==========================================="

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
exit 0
