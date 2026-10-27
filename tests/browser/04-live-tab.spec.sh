#!/bin/bash
# 04-live-tab.spec.sh — Live tab shows real-time cursors that move.
#
# Verifies:
#   - The Live tab renders its header ("Real-time cursor activity" / "Live now")
#   - Cursor SVG elements are rendered (viewBox="0 0 22 22" arrows)
#   - After a 2s wait, cursors are still present and have moved position

source "$(dirname "$0")/_helpers.sh"

setup_session "04-live-tab"
open_app
open_project

click_tab "Live"

# Header text — the panel shows either "Real-time cursor activity" or
# "Live now" depending on whether the socket has connected yet.
assert_js \
  "(function(){var tp=document.querySelector('[role=tabpanel]');var t=tp?tp.innerText:document.body.innerText;return (t.indexOf('Real-time cursor activity')!==-1||t.indexOf('Live now')!==-1)?'PASS':'FAIL';})()" \
  "Live tab header renders"

# Cursor arrows are SVGs with viewBox="0 0 22 22" (see live-tab.tsx:274).
assert_js \
  "(function(){var tp=document.querySelector('[role=tabpanel]');if(!tp)return 'FAIL';return tp.querySelectorAll('svg[viewBox=\"0 0 22 22\"]').length>0?'PASS':'FAIL';})()" \
  "cursor SVGs are rendered"

# Capture cursor positions, wait 2s, then confirm they have moved (the
# ghost-simulation state machine in live-tab-helpers.ts ticks every ~50ms).
POS1="$(ab eval \
  "(function(){var tp=document.querySelector('[role=tabpanel]');if(!tp)return '';var svgs=tp.querySelectorAll('svg[viewBox=\"0 0 22 22\"]');var out=[];for(var i=0;i<svgs.length;i++){var p=svgs[i].parentElement;out.push((p.style.left||'')+'|'+(p.style.top||''));}return out.join(';');})()" \
  2>/dev/null | tr -d '"' || true)"

ab wait 2500 >/dev/null 2>&1 || true

POS2="$(ab eval \
  "(function(){var tp=document.querySelector('[role=tabpanel]');if(!tp)return '';var svgs=tp.querySelectorAll('svg[viewBox=\"0 0 22 22\"]');var out=[];for(var i=0;i<svgs.length;i++){var p=svgs[i].parentElement;out.push((p.style.left||'')+'|'+(p.style.top||''));}return out.join(';');})()" \
  2>/dev/null | tr -d '"' || true)"

if [[ -n "$POS1" && -n "$POS2" && "$POS1" != "$POS2" ]]; then
  record_pass "cursors move over time"
else
  record_fail "cursors move over time (pos1='${POS1:0:60}' pos2='${POS2:0:60}')"
fi

# Cursors are still present after the wait.
assert_js \
  "(function(){var tp=document.querySelector('[role=tabpanel]');if(!tp)return 'FAIL';return tp.querySelectorAll('svg[viewBox=\"0 0 22 22\"]').length>0?'PASS':'FAIL';})()" \
  "cursors still present after 2s"

finish "04-live-tab"
