#!/bin/bash
# 03-recording-player.spec.sh — Session replay player opens and closes.
#
# Verifies:
#   - The Recordings tab lists sessions
#   - Clicking the first session opens the player overlay
#   - The player overlay shows "Session Replay" branding
#   - The seek bar (clickable h-8 div) exists in the overlay
#   - The side panel (aside) exists in the overlay
#   - Pressing Escape closes the player

source "$(dirname "$0")/_helpers.sh"

setup_session "03-recording-player"
open_app
open_project

click_tab "Recordings"

# Sessions should be listed (aria-label prefix is set by recordings-tab.tsx).
assert_js \
  "document.querySelectorAll('[aria-label^=\"Open recording\"]').length > 0 ? 'PASS' : 'FAIL'" \
  "Recordings tab lists sessions"

# Click the first session to open the player.
ab eval \
  "(function(){var b=document.querySelector('[aria-label^=\"Open recording\"]');if(b){b.click();return 'clicked';}return 'none';})()" \
  >/dev/null 2>&1 || true
ab wait 3000 >/dev/null 2>&1 || true

assert_contains "Session Replay" "player overlay header is visible"

# Seek bar: a clickable div (h-8 + cursor-pointer) inside the fixed overlay.
assert_js \
  "(function(){var o=document.querySelector('.fixed.inset-0.z-50');if(!o)return 'FAIL';var ds=o.querySelectorAll('div');for(var i=0;i<ds.length;i++){var c=ds[i].className||'';if(typeof c==='string'&&c.indexOf('h-8')!==-1&&c.indexOf('cursor-pointer')!==-1)return 'PASS';}return 'FAIL';})()" \
  "seek bar exists in player overlay"

# Side panel: an <aside> inside the overlay.
assert_js \
  "(document.querySelector('.fixed.inset-0.z-50 aside') ? 'PASS' : 'FAIL')" \
  "side panel exists in player overlay"

# Close the player with Escape.
ab press Escape >/dev/null 2>&1 || true
ab wait 1000 >/dev/null 2>&1 || true

assert_js \
  "(document.body.innerText.indexOf('Session Replay') === -1 ? 'PASS' : 'FAIL')" \
  "Escape closes the player overlay"

finish "03-recording-player"
