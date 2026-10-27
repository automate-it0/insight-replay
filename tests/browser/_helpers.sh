#!/bin/bash
# Shared helpers for Insight Replay browser E2E tests.
# Sourced by every spec script. Provides: session setup, navigation,
# assertion primitives, pass/fail accounting, and cleanup.
#
# Usage in a spec:
#   source "$(dirname "$0")/_helpers.sh"
#   setup_session "01-dashboard"
#   open_app
#   open_project
#   assert_contains "TOTAL SESSIONS" "overview KPIs render"
#   finish

set -u

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL="${BASE_URL:-http://localhost:81}"
# Per-command timeout so a hung agent-browser call can never wedge a spec.
AB_TIMEOUT="${AB_TIMEOUT:-25}"

# ---------------------------------------------------------------------------
# Pass/fail accounting
# ---------------------------------------------------------------------------
PASSES=0
FAILS=0

record_pass() { PASSES=$((PASSES + 1)); printf '[PASS] %s\n' "$1"; }
record_fail() { FAILS=$((FAILS + 1)); printf '[FAIL] %s\n' "$1" >&2; }

# ---------------------------------------------------------------------------
# agent-browser wrapper with a hard timeout so a stuck command never wedges
# the whole suite. Forwards all args; echoes stdout on success.
# ---------------------------------------------------------------------------
ab() {
  timeout "$AB_TIMEOUT" agent-browser "$@"
}

# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------
# Sets a unique named browser session so parallel/sequential specs never
# collide on the shared default session.
setup_session() {
  local name="${1:-spec}"
  export AGENT_BROWSER_SESSION="ir-e2e-${name}-$$"
  trap 'agent-browser close >/dev/null 2>&1 || true' EXIT INT TERM
}

# Open the dashboard root and wait until the real app shell (not the sandbox
# warm-up interstitial) is present. The warm-up page lacks "Insight Replay"
# in the title, so we detect that and retry once after the interstitial's
# own 5s self-redirect.
open_app() {
  ab open "$BASE_URL/" >/dev/null 2>&1
  ab wait --load load >/dev/null 2>&1 || true
  local title
  title="$(ab get title 2>/dev/null | tr -d '"' || true)"
  if [[ "$title" != *"Insight Replay"* ]]; then
    # Likely the warm-up interstitial; let it self-redirect then re-check.
    ab wait 6000 >/dev/null 2>&1 || true
    ab wait --load load >/dev/null 2>&1 || true
  fi
  ab wait --text "Insight Replay" 2>/dev/null >/dev/null || ab wait 2000 >/dev/null 2>&1 || true
}

# Navigate from the projects dashboard into the Acme project. Works whether
# we're already on the dashboard or already inside the project (the sidebar
# Acme button is always present). Leaves the Overview tab selected.
open_project() {
  # The sidebar project button is the most stable target — it is rendered on
  # both the projects list and the project view.
  ab find text "Acme Inc." click >/dev/null 2>&1 || true
  # Wait for the project shell: the Overview tab becoming selected.
  local i
  for i in 1 2 3 4 5; do
    local sel
    sel="$(ab eval "document.querySelector('[role=tab][aria-selected=true]')?.textContent || ''" 2>/dev/null | tr -d '"' || true)"
    if [[ "$sel" == *"Overview"* ]]; then
      break
    fi
    ab wait 1000 >/dev/null 2>&1 || true
  done
  # Give stats a moment so KPI labels (CSS-uppercased) are in innerText.
  ab wait 1500 >/dev/null 2>&1 || true
}

# Click a tab by its visible label (e.g. "Recordings", "Live"). Tabs render
# as role=tab; we match on trimmed textContent so the "Live 16" badge doesn't
# break the lookup.
click_tab() {
  local label="$1"
  ab eval "
    (function(){
      var tabs = document.querySelectorAll('[role=tab]');
      for (var i=0;i<tabs.length;i++){
        var t = (tabs[i].textContent||'').trim();
        if (t === '$label' || t.indexOf('$label') === 0){
          tabs[i].click();
          return 'clicked';
        }
      }
      return 'not-found';
    })()
  " >/dev/null 2>&1 || true
  ab wait 1200 >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

# Assert that the active tabpanel's visible text contains a substring.
# Falls back to body.innerText if no tabpanel is present (dashboard root).
assert_panel_contains() {
  local needle="$1"
  local desc="$2"
  local result
  result="$(ab eval "
    (function(){
      var tp = document.querySelector('[role=tabpanel]');
      var text = tp ? tp.innerText : document.body.innerText;
      return text.indexOf($(js_str "$needle")) !== -1 ? 'PASS' : 'FAIL';
    })()
  " 2>/dev/null | tr -d '"' || true)"
  if [[ "$result" == "PASS" ]]; then
    record_pass "$desc"
  else
    record_fail "$desc (panel did not contain '$needle')"
  fi
}

# Assert that the whole document body contains a substring.
assert_contains() {
  local needle="$1"
  local desc="$2"
  local result
  result="$(ab eval "
    document.body.innerText.indexOf($(js_str "$needle")) !== -1 ? 'PASS' : 'FAIL'
  " 2>/dev/null | tr -d '"' || true)"
  if [[ "$result" == "PASS" ]]; then
    record_pass "$desc"
  else
    record_fail "$desc (body did not contain '$needle')"
  fi
}

# Assert that a JS expression evaluates truthy. The expression is run in the
# browser and must return 'PASS' or 'FAIL'.
assert_js() {
  local js="$1"
  local desc="$2"
  local result
  result="$(ab eval "$js" 2>/dev/null | tr -d '"' || true)"
  if [[ "$result" == "PASS" ]]; then
    record_pass "$desc"
  else
    record_fail "$desc (js returned: ${result:-<empty>})"
  fi
}

# Print the spec summary and exit with the right status. Call at end of spec.
finish() {
  local spec_name="${1:-spec}"
  echo "-------------------------------------------"
  echo "SUMMARY [$spec_name]: $PASSES passed, $FAILS failed"
  if [[ "$FAILS" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# Internal: escape a string into a JS single-quoted string literal.
# ---------------------------------------------------------------------------
js_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\'/\\\'}"
  printf "'%s'" "$s"
}
