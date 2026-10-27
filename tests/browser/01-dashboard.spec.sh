#!/bin/bash
# 01-dashboard.spec.sh — Dashboard loads, project opens, Overview renders.
#
# Verifies:
#   - The app shell loads at http://localhost:81/
#   - "Insight Replay" branding is present
#   - A project card for "Acme" exists
#   - Clicking the project navigates to the project view
#   - The Overview tab is selected and its KPIs render ("TOTAL SESSIONS")

source "$(dirname "$0")/_helpers.sh"

setup_session "01-dashboard"
open_app

assert_contains "Insight Replay" "app branding is visible"
assert_contains "Acme"          "Acme project is listed"

open_project

# Overview tab should be the default selection after entering a project.
assert_js \
  "(document.querySelector('[role=tab][aria-selected=true]')||{}).textContent === 'Overview' ? 'PASS' : 'FAIL'" \
  "Overview tab is selected by default"

# KPI labels are CSS-uppercased ("Total sessions" → "TOTAL SESSIONS").
assert_contains "TOTAL SESSIONS" "Overview KPIs render"

finish "01-dashboard"
