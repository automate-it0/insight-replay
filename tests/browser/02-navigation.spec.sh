#!/bin/bash
# 02-navigation.spec.sh — Every dashboard tab renders content.
#
# Opens the Acme project, then clicks through all 13 in-scope tabs and
# verifies each one's tabpanel renders its expected content. Reports
# pass/fail per tab so a single broken tab doesn't hide the others.

source "$(dirname "$0")/_helpers.sh"

setup_session "02-navigation"
open_app
open_project

# Each entry: "Tab Label|expected panel text"
TABS=(
  "Overview|Sessions over time"
  "Recordings|AI search"
  "Heatmaps|Heatmap page URL"
  "Live|Real-time cursor activity"
  "Funnels|New funnel"
  "Journeys|User journeys"
  "Visitors|visitors"
  "Retention|Retention"
  "Goals|Goals"
  "Alerts|Alert"
  "Insights|RAGE CLICKS"
  "Errors|Error tracking"
  "Settings|Project details"
)

for entry in "${TABS[@]}"; do
  label="${entry%%|*}"
  needle="${entry##*|}"
  click_tab "$label"
  assert_panel_contains "$needle" "tab '$label' renders"
done

finish "02-navigation"
