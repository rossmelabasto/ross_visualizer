#!/usr/bin/env bash
# Open the app on a virtual X11 display and confirm it stays up, and that asking for the overlay
# on a session without layer-shell is refused instead of opening a broken window.
#   smoke.sh <command...>
set -euo pipefail

# CI containers can't create the sandbox WebKit wants. Only this test turns it off.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export LIBGL_ALWAYS_SOFTWARE=1
export SMOKE_CMD="$*"

timeout 60 xvfb-run -a dbus-run-session -- bash -c '
  log=$(mktemp)
  $SMOKE_CMD >"$log" 2>&1 &
  pid=$!
  sleep 8
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "The app died on startup:" >&2
    cat "$log" >&2
    exit 1
  fi
  $SMOKE_CMD overlay toggle >>"$log" 2>&1 || true
  sleep 2
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "The app died when asked for the overlay:" >&2
    cat "$log" >&2
    exit 1
  fi
  if ! grep -q "no layer-shell" "$log"; then
    echo "The overlay should have been refused here:" >&2
    cat "$log" >&2
    exit 1
  fi
  kill "$pid"
  echo "Smoke test passed: the app runs on X11 and refuses the overlay"
'
