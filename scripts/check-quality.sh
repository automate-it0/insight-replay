#!/usr/bin/env bash
# scripts/check-quality.sh
# ----------------------------------------------------------------------------
# Local pre-push quality gate. Run this before pushing to catch CI failures
# early (Shift Left). Mirrors what GitHub Actions runs in .github/workflows/ci.yml.
#
# Hard failures (exit non-zero): lint, tests
# Soft warnings (print, keep going): tsc --noEmit
#
# Usage:
#   ./scripts/check-quality.sh
#
# Exit codes:
#   0  — all hard checks passed (warnings may have been printed)
#   1  — at least one hard check failed
# ----------------------------------------------------------------------------
set -uo pipefail

# Color helpers — degrade gracefully if not a TTY.
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'
  BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; RESET=""
fi

# Track failures across checks so we can run all of them and report at the end.
hard_failures=0
soft_failures=0
sections=()  # array of "name|status|detail" strings

run_section() {
  local name="$1"
  local kind="$2"  # "hard" or "soft"
  shift 2
  echo "${BLUE}▶ ${BOLD}${name}${RESET}"
  local start; start=$(date +%s%N)
  # Run the command. `set +e` so a failure doesn't abort the script — we want
  # to keep going and report all problems, not stop at the first one.
  set +e
  output=$("$@" 2>&1)
  status=$?
  set -e
  local end; end=$(date +%s%N)
  local elapsed_ms=$(( (end - start) / 1000000 ))

  # Trim output to last 25 lines if it's long — keeps the summary readable.
  if [ ${#output} -gt 2000 ]; then
    output=$(printf '%s' "$output" | tail -n 25)
    output="... (showing last 25 lines) ...\n$output"
  fi

  if [ "$status" -eq 0 ]; then
    sections+=("${name}|PASS|${elapsed_ms}ms")
    echo "${GREEN}  ✓ passed${RESET} (${elapsed_ms}ms)"
    if [ -n "$output" ]; then printf '  %s\n' "$output" | sed 's/^/  /'; fi
  else
    if [ "$kind" = "hard" ]; then
      hard_failures=$((hard_failures + 1))
      sections+=("${name}|FAIL|${elapsed_ms}ms")
      echo "${RED}  ✗ FAILED${RESET} (${elapsed_ms}ms)"
    else
      soft_failures=$((soft_failures + 1))
      sections+=("${name}|WARN|${elapsed_ms}ms")
      echo "${YELLOW}  ⚠ warnings/errors (non-blocking)${RESET} (${elapsed_ms}ms)"
    fi
    if [ -n "$output" ]; then printf '  %s\n' "$output" | sed 's/^/  /'; fi
  fi
  echo ""
}

echo "${BOLD}Insight Replay — local quality gate${RESET}"
echo "Running the same checks CI runs. Catch failures here, not in PR review."
echo ""

# --- Lint (hard) ------------------------------------------------------------
run_section "Lint (eslint)" hard bun run lint

# --- Type-check (soft) ------------------------------------------------------
# `tsc --noEmit` is non-blocking locally because the project has
# `typescript.ignoreBuildErrors: true` in next.config.ts and a handful of
# pre-existing TS errors are still being paid down. CI runs it as a hard gate
# but locally we just warn — see docs/ci-cd.md for rationale.
run_section "Type-check (tsc --noEmit)" soft bunx tsc --noEmit

# --- Tests (hard) -----------------------------------------------------------
# api-contracts.test.ts auto-skips when the dev server is unreachable, so this
# works without booting `bun run dev`. The 4 unit-test files always run.
run_section "Tests (bun test tests/)" hard bun test tests/

# --- Summary ----------------------------------------------------------------
echo "${BOLD}───────────────────────────────────${RESET}"
echo "${BOLD} Summary${RESET}"
echo "${BOLD}───────────────────────────────────${RESET}"
for entry in "${sections[@]}"; do
  IFS='|' read -r name status detail <<< "$entry"
  case "$status" in
    PASS) printf "  ${GREEN}✓${RESET} %-32s %s\n" "$name" "$detail" ;;
    FAIL) printf "  ${RED}✗${RESET} %-32s %s\n" "$name" "$detail" ;;
    WARN) printf "  ${YELLOW}⚠${RESET} %-32s %s\n" "$name" "$detail" ;;
  esac
done
echo ""

if [ "$hard_failures" -gt 0 ]; then
  echo "${RED}${BOLD}FAIL${RESET} — ${hard_failures} hard check(s) failed."
  echo "Fix the issues above before pushing. CI will block the PR otherwise."
  exit 1
fi

if [ "$soft_failures" -gt 0 ]; then
  echo "${YELLOW}${BOLD}PASS with warnings${RESET} — ${soft_failures} soft check(s) reported issues."
  echo "Hard checks all passed; safe to push. Review the warnings above."
  exit 0
fi

echo "${GREEN}${BOLD}PASS${RESET} — all checks green. Safe to push."
exit 0
