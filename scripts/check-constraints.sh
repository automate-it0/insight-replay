#!/usr/bin/env bash
# scripts/check-constraints.sh
# ----------------------------------------------------------------------------
# Insight Replay — automated constraint checker.
#
# Runs every constraint defined in CONSTRAINTS.md and prints a summary table:
#   Constraint | Threshold | Measured | Status
#
# Constraints are either HARD (exit 1 if violated) or SOFT (report only, exit 0).
# This mirrors the convention in scripts/check-quality.sh: SOFT constraints are
# baseline-tracked — we measure where we are vs. the target without blocking
# work that didn't introduce the violation.
#
# Usage:
#   ./scripts/check-constraints.sh
#   bash scripts/check-constraints.sh
#
# Exit codes:
#   0  — all HARD constraints passed (SOFT violations may still be reported)
#   1  — at least one HARD constraint failed
#
# See: CONSTRAINTS.md for the rulebook, docs/constraints-guide.md for the why.
# ----------------------------------------------------------------------------
set -uo pipefail

# --- color helpers (degrade gracefully when piped) ------------------------
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; DIM=""; RESET=""
fi

# Repo root = directory above this script.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Summary table rows: "Constraint|Threshold|Measured|Status|Kind"
rows=()
hard_failures=0
soft_violations=0

# add_row <constraint> <threshold> <measured> <status PASS|WARN|FAIL> <kind hard|soft>
add_row() {
  rows+=("$1|$2|$3|$4|$5")
  case "$4" in
    FAIL) [ "$5" = "hard" ] && hard_failures=$((hard_failures + 1)) ;;
    WARN) soft_violations=$((soft_violations + 1)) ;;
  esac
}

header() { printf "\n${BLUE}${BOLD}▶ %s${RESET}\n" "$1"; }
pass()   { printf "  ${GREEN}✓ %s${RESET}\n" "$1"; }
warn()   { printf "  ${YELLOW}⚠ %s${RESET}\n" "$1"; }
fail()   { printf "  ${RED}✗ %s${RESET}\n" "$1"; }
note()   { printf "  ${DIM}%s${RESET}\n" "$1"; }

echo "${BOLD}Insight Replay — constraint gate${RESET}"
echo "Measuring every rule in CONSTRAINTS.md. Hard failures exit non-zero."
echo ""

# ============================================================================
# 1. LINT (HARD) — ESLint must pass with 0 errors. Warnings allowed.
# ============================================================================
header "1. Lint — ESLint (0 errors)"
lint_out=$(bun run lint 2>&1)
lint_status=$?
# ESLint prints "N error" / "N warning" in its summary line. Parse them.
lint_errors=$(printf '%s' "$lint_out" | grep -oE '[0-9]+ error' | head -1 | grep -oE '[0-9]+' || echo 0)
lint_warnings=$(printf '%s' "$lint_out" | grep -oE '[0-9]+ warning' | head -1 | grep -oE '[0-9]+' || echo 0)
[ -z "$lint_errors" ]  && lint_errors=0
[ -z "$lint_warnings" ] && lint_warnings=0
if [ "$lint_errors" -eq 0 ]; then
  pass "0 errors ($lint_warnings warnings)"
  add_row "Lint errors" "0" "$lint_errors" PASS hard
  add_row "Lint warnings" "tracked" "$lint_warnings" PASS soft
else
  fail "$lint_errors errors, $lint_warnings warnings"
  printf '%s\n' "$lint_out" | tail -10 | sed 's/^/    /'
  add_row "Lint errors" "0" "$lint_errors" FAIL hard
fi

# ============================================================================
# 2. TYPE SAFETY (HARD on src/) — tsc --noEmit must have 0 errors in src/.
#    Out-of-scope errors (tests/, examples/, skills/) are tracked but don't
#    fail the gate — see CONSTRAINTS.md §2 for the baseline + remediation plan.
# ============================================================================
header "2. Type safety — tsc --noEmit (0 src errors)"
tsc_out=$(bunx tsc --noEmit 2>&1)
tsc_status=$?
tsc_total=$(printf '%s' "$tsc_out" | grep -c "error TS" || echo 0)
# Errors that originate in src/ — the ones we actually own.
tsc_src=$(printf '%s' "$tsc_out" | grep "error TS" | grep -E "^src/" | wc -l | tr -d ' ')
tsc_tests=$(printf '%s' "$tsc_out" | grep "error TS" | grep -E "^tests/" | wc -l | tr -d ' ')
tsc_other=$(printf '%s' "$tsc_out" | grep "error TS" | grep -vE "^(src/|tests/)" | wc -l | tr -d ' ')
[ -z "$tsc_total" ] && tsc_total=0
[ -z "$tsc_src" ] && tsc_src=0
[ -z "$tsc_tests" ] && tsc_tests=0
[ -z "$tsc_other" ] && tsc_other=0
if [ "$tsc_src" -eq 0 ]; then
  pass "0 src errors (out-of-scope: $tsc_tests tests/, $tsc_other examples+skills — see CONSTRAINTS.md §2)"
  add_row "tsc errors (src/)" "0" "$tsc_src" PASS hard
else
  fail "$tsc_src src/ errors — new type regression"
  printf '%s\n' "$tsc_out" | grep "error TS" | grep -E "^src/" | head -10 | sed 's/^/    /'
  add_row "tsc errors (src/)" "0" "$tsc_src" FAIL hard
fi
# Always track out-of-scope as a soft informational row.
add_row "tsc errors (out-of-scope)" "0 (target)" "$((tsc_tests + tsc_other))" WARN soft

# ============================================================================
# 3. TESTS (HARD) — bun test tests/ must pass 100% (skip is allowed).
#    Coverage targets (80% src/lib, 60% src/app/api) are aspirational and
#    tracked separately because bun's built-in test runner doesn't ship
#    coverage by default — see CONSTRAINTS.md §3 for the measurement plan.
# ============================================================================
header "3. Tests — bun test tests/ (100% pass)"
test_out=$(bun test tests/ 2>&1)
test_status=$?
t_pass=$(printf '%s' "$test_out" | grep -oE '[0-9]+ pass'   | head -1 | grep -oE '[0-9]+' || echo 0)
t_skip=$(printf '%s' "$test_out" | grep -oE '[0-9]+ skip'   | head -1 | grep -oE '[0-9]+' || echo 0)
t_fail=$(printf '%s' "$test_out" | grep -oE '[0-9]+ fail'   | head -1 | grep -oE '[0-9]+' || echo 0)
[ -z "$t_pass" ] && t_pass=0
[ -z "$t_skip" ] && t_skip=0
[ -z "$t_fail" ] && t_fail=0
# pass rate = pass / (pass + fail). Skips don't count against the rate.
denom=$((t_pass + t_fail))
if [ "$denom" -eq 0 ]; then rate=0; else rate=$(( t_pass * 100 / denom )); fi
if [ "$t_fail" -eq 0 ] && [ "$t_pass" -gt 0 ]; then
  pass "$t_pass pass / $t_skip skip / $t_fail fail ($rate%)"
  add_row "Test pass rate" "100%" "${rate}%" PASS hard
else
  fail "$t_pass pass / $t_skip skip / $t_fail fail ($rate%)"
  printf '%s\n' "$test_out" | tail -8 | sed 's/^/    /'
  add_row "Test pass rate" "100%" "${rate}%" FAIL hard
fi

# ============================================================================
# 4. FILE COMPLEXITY (SOFT, baseline-tracked) — no file > 800 lines.
#    Current baseline: 1 file (recording-player.tsx, 883). Goal: 0.
# ============================================================================
header "4. File size — no file > 800 lines"
over_files=$(find src -type f \( -name '*.ts' -o -name '*.tsx' \) -exec wc -l {} + \
  | awk '$1 > 800 && $2 != "total" { printf "  %s: %s lines\n", $2, $1 }')
over_count=$(printf '%s' "$over_files" | grep -c ":" || echo 0)
[ -z "$over_count" ] && over_count=0
# Baseline = 2 (recording-player.tsx 883, src/lib/security-checklist.ts 870).
# Anything above is a regression; anything below is improvement.
baseline_files=2
if [ "$over_count" -eq 0 ]; then
  pass "0 files over 800 lines"
  add_row "Files > 800 lines" "0" "0" PASS soft
elif [ "$over_count" -le "$baseline_files" ]; then
  warn "$over_count file(s) over 800 lines (baseline: $baseline_files — see CONSTRAINTS.md §8)"
  printf '%s\n' "$over_files"
  add_row "Files > 800 lines" "0 (target)" "$over_count" WARN soft
else
  fail "$over_count files over 800 lines exceeds baseline of $baseline_files — regression"
  printf '%s\n' "$over_files"
  add_row "Files > 800 lines" "0 (target)" "$over_count" FAIL hard
fi

# ============================================================================
# 5. FUNCTION COMPLEXITY (SOFT, optional) — no function > 100 lines.
#    Heuristic: counts lines between a top-level `function`/`const X = (` and
#    the matching closing brace at the same indentation. Not perfect; flagged
#    results should be eyeballed before treating as a violation.
# ============================================================================
header "5. Function size — no function > 100 lines (optional heuristic)"
func_over_list=""
func_over_count=0
if command -v awk >/dev/null 2>&1; then
  # Per-file state machine: when we see a function-shaped opener that leaves
  # an unclosed `{`, count braces forward until they close. Conservative —
  # matches `function name(`, `const x = (..) => {`, and `name(args): T {`
  # openers. Brace chars inside strings/comments are counted too, which can
  # cause false negatives (a `}` in a string ending a function early) but
  # never false positives. Flagged results should be eyeballed before being
  # treated as violations — this is informational, not a hard gate.
  : > /tmp/ir-funcs.$$
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    awk -v F="$f" '
      {
        line = $0
        if (!in_fn) {
          is_opener = (line ~ /function[[:space:]]+[A-Za-z_]/ && line ~ /\{/) || \
                      (line ~ /[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*\(?.*\)?[[:space:]]*=>[[:space:]]*\{/) || \
                      (line ~ /[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(.*\)[[:space:]]*:[[:space:]]*[A-Za-z].*\{/)
          if (is_opener) {
            depth = 0
            for (i = 1; i <= length(line); i++) {
              c = substr(line, i, 1)
              if (c == "{") depth++
              else if (c == "}") depth--
            }
            if (depth > 0) { in_fn = 1; start = NR }
          }
        } else {
          for (i = 1; i <= length(line); i++) {
            c = substr(line, i, 1)
            if (c == "{") depth++
            else if (c == "}") depth--
          }
          if (depth <= 0) {
            len = NR - start + 1
            if (len > 100) printf "  %s:%d  %d lines\n", F, start, len
            in_fn = 0
          }
        }
      }
    ' "$f" >> /tmp/ir-funcs.$$ 2>/dev/null
  done < <(find src -type f \( -name '*.ts' -o -name '*.tsx' \))
  func_over_list=$(cat /tmp/ir-funcs.$$ 2>/dev/null)
  rm -f /tmp/ir-funcs.$$
  func_over_count=$(printf '%s' "$func_over_list" | grep -c ":" || echo 0)
  [ -z "$func_over_count" ] && func_over_count=0
fi
if [ "$func_over_count" -eq 0 ]; then
  pass "no functions detected over 100 lines (heuristic)"
  add_row "Functions > 100 lines" "0" "0" PASS soft
else
  warn "$func_over_count function(s) over 100 lines (heuristic — eyeball before treating as a violation)"
  printf '%s\n' "$func_over_list" | head -10
  add_row "Functions > 100 lines" "0 (target)" "$func_over_count" WARN soft
fi

# ============================================================================
# 6. SECURITY — bun audit (SOFT, baseline-tracked) — 0 high/critical.
#    Current baseline: 62 high/critical (5 crit + 57 high). Almost all are
#    transitive deps of next-intl, @reactuses/core, react-syntax-highlighter.
#    Goal: 0 — see CONSTRAINTS.md §7 for the upgrade plan.
# ============================================================================
header "6. Security — bun audit (0 high/critical)"
if command -v bun >/dev/null 2>&1; then
  audit_out=$(bun audit 2>&1)
  audit_status=$?
  # The summary line looks like: "107 vulnerabilities (5 critical, 57 high, 39 moderate, 6 low)"
  summary_line=$(printf '%s' "$audit_out" | grep -E '^[0-9]+ vulnerabilities' | tail -1)
  crit=$(printf '%s' "$summary_line" | grep -oE '[0-9]+ critical' | grep -oE '[0-9]+' || echo 0)
  high=$(printf '%s' "$summary_line" | grep -oE '[0-9]+ high'      | grep -oE '[0-9]+' || echo 0)
  [ -z "$crit" ] && crit=0
  [ -z "$high" ] && high=0
  hc=$((crit + high))
  if [ "$hc" -eq 0 ]; then
    pass "0 high/critical vulnerabilities"
    add_row "Audit high/critical" "0" "0" PASS soft
  else
    warn "$hc high/critical ($crit critical + $high high) — baseline 62, see CONSTRAINTS.md §7"
    printf '%s\n' "$summary_line" | sed 's/^/    /'
    # Baseline is 62. Anything above is a regression (hard fail).
    if [ "$hc" -le 62 ]; then
      add_row "Audit high/critical" "0 (target)" "$hc" WARN soft
    else
      fail "$hc high/critical exceeds baseline of 62 — regression"
      add_row "Audit high/critical" "0 (target)" "$hc" FAIL hard
    fi
  fi
else
  warn "bun not installed — skipping bun audit"
  add_row "Audit high/critical" "0" "skipped" WARN soft
fi

# ============================================================================
# 7. BUNDLE SIZE (informational) — production JS < 500KB gzipped.
#    Reported only when .next/build exists; full check requires `bun run build`.
# ============================================================================
header "7. Bundle size — production JS < 500KB gzipped (informational)"
if [ -d ".next" ] && find .next -name '*.js' -size +1c 2>/dev/null | head -1 | grep -q .; then
  # Sum gzip sizes of all built JS chunks. This is approximate — real First
  # Load JS is reported by `next build` itself. See CONSTRAINTS.md §4.
  bundle_kb=$(find .next -name '*.js' -type f 2>/dev/null \
    | xargs gzip -c 2>/dev/null | wc -c \
    | awk '{ printf "%.1f", $1 / 1024 }')
  note "approx total gzipped JS in .next: ${bundle_kb}KB (use 'next build' report for First Load JS per route)"
  add_row "Bundle (gzipped)" "<500KB" "${bundle_kb}KB" WARN soft
else
  note "no .next build present — run 'bun run build' for the real measurement"
  add_row "Bundle (gzipped)" "<500KB" "not built" WARN soft
fi

# ============================================================================
# SUMMARY TABLE
# ============================================================================
echo ""
echo "${BOLD}────────────────────────────────────────────────────────────────────────${RESET}"
echo "${BOLD} Constraint summary${RESET}"
echo "${BOLD}────────────────────────────────────────────────────────────────────────${RESET}"
printf " ${BOLD}%-26s %-18s %-18s %-8s %-6s${RESET}\n" "Constraint" "Threshold" "Measured" "Status" "Kind"
printf " %-26s %-18s %-18s %-8s %-6s\n" "--------------------------" "------------------" "------------------" "--------" "------"
for entry in "${rows[@]}"; do
  IFS='|' read -r name threshold measured status kind <<< "$entry"
  case "$status" in
    PASS) sc="${GREEN}PASS${RESET}";;
    WARN) sc="${YELLOW}WARN${RESET}";;
    FAIL) sc="${RED}FAIL${RESET}";;
    *)    sc="$status";;
  esac
  case "$kind" in
    hard) kc="${RED}hard${RESET}";;
    soft) kc="${BLUE}soft${RESET}";;
    *)    kc="$kind";;
  esac
  # Use printf %s for the visible name/threshold/measured (no ANSI), then
  # color only status/kind. The width specifiers apply to the visible width,
  # which is correct because name/threshold/measured contain no ANSI codes.
  printf " %-26s %-18s %-18s %-8s %-6s\n" \
    "$name" "$threshold" "$measured" "$status" "$kind" \
    | sed -E "s/ PASS / ${GREEN}PASS${RESET} /; s/ WARN / ${YELLOW}WARN${RESET} /; s/ FAIL / ${RED}FAIL${RESET} /; s/ hard / ${RED}hard${RESET} /; s/ soft / ${BLUE}soft${RESET} /"
done
echo ""

# Verdict
echo "${BOLD}────────────────────────────────────────────────────────────────────────${RESET}"
if [ "$hard_failures" -gt 0 ]; then
  echo "${RED}${BOLD}FAIL${RESET} — $hard_failures hard constraint(s) failed."
  echo "Fix the FAIL rows above before pushing. CI will block the PR otherwise."
  exit 1
fi
if [ "$soft_violations" -gt 0 ]; then
  echo "${YELLOW}${BOLD}PASS with warnings${RESET} — $soft_violations soft constraint(s) reported violations."
  echo "Hard constraints all green; safe to push. Review the WARN rows above — they"
  echo "track baseline debt toward the targets in CONSTRAINTS.md."
  exit 0
fi
echo "${GREEN}${BOLD}PASS${RESET} — all constraints green."
exit 0
