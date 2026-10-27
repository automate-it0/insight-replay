#!/bin/bash
# 05-funnels.spec.sh — Funnel analysis renders list, steps, and drop-off.
#
# Verifies:
#   - The Funnels tab renders the funnel list
#   - Clicking the first funnel selects it
#   - The funnel steps render (contain "Homepage" / "entered the funnel")
#   - Drop-off percentages are shown (a "%" figure in the steps panel)

source "$(dirname "$0")/_helpers.sh"

setup_session "05-funnels"
open_app
open_project

click_tab "Funnels"

# The funnel list is present — the "New funnel" button is always rendered.
assert_panel_contains "New funnel" "funnel list renders"

# Click the first funnel in the list. Funnel rows are buttons whose text
# starts with the funnel name; the first one is "Homepage → Pricing → Signup".
ab eval \
  "(function(){var tp=document.querySelector('[role=tabpanel]');if(!tp)return 'none';var btns=tp.querySelectorAll('button');for(var i=0;i<btns.length;i++){var t=(btns[i].textContent||'').trim();if(t.indexOf('Homepage')!==-1&&t.indexOf('Pricing')!==-1&&t.indexOf('Signup')!==-1&&t.indexOf('Delete')===-1){btns[i].click();return 'clicked';}}return 'none';})()" \
  >/dev/null 2>&1 || true
ab wait 1500 >/dev/null 2>&1 || true

# The selected funnel's steps render — step 1 is always "Homepage".
assert_panel_contains "Homepage" "funnel steps render"

# The steps panel shows the entry count ("entered the funnel").
assert_panel_contains "entered the funnel" "funnel entry count renders"

# Drop-off / conversion percentages are shown as "%" figures in the steps.
assert_js \
  "(function(){var tp=document.querySelector('[role=tabpanel]');if(!tp)return 'FAIL';var t=tp.innerText;var pct=t.match(/\\d+(?:\\.\\d+)?%/g);return (pct&&pct.length>=2)?'PASS':'FAIL';})()" \
  "drop-off percentages render"

finish "05-funnels"
