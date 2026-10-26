#!/bin/sh
# Launch the app for UI testing without disturbing the focused monitor.
# Usage: scripts/dev-launch.sh [prod|dev|stop]
#   prod (default): electron . (uses the existing out/ build)
#   dev:            electron-vite dev (dev server + HMR)
#   stop:           stop whatever this script started
# The window is placed on workspace 7 silently (runtime Hyprland window rule,
# plus a silent move as fallback), and the remote debugging port 9333 is opened.
set -u
MODE=${1:-prod}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOG=${CCD_LOG:-/tmp/claude-1000/-home-zeljko/057c681b-9b2a-4cc8-a0ee-d83f47a9e044/scratchpad/app.log}
WS=${CCD_WORKSPACE:-7}
CLASS=hearth

PIDFILE=${XDG_RUNTIME_DIR:-/tmp}/hearth-dev.pid
# Stop a dev server started earlier by this script, then any electron.
if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE"; fi
pkill -x electron 2>/dev/null
[ "$MODE" = stop ] && exit 0
# Wait for the old instance (and its debug port) to go away.
i=0
while pgrep -x electron >/dev/null || curl -s -o /dev/null localhost:9333/json/version; do
  i=$((i + 1)); [ $i -gt 40 ] && { echo "old electron did not exit" >&2; exit 1; }
  sleep 0.25
done

# Runtime window rule (registered once per Hyprland session, lost on reload).
if command -v hyprctl >/dev/null; then
  out=$(hyprctl repl "if not _G.__ccd_rule then _G.__ccd_rule = hl.window_rule({ match = { class = \"^($CLASS)\$\" }, workspace = \"$WS silent\", no_initial_focus = true }) end return 'ok'" 2>&1)
  case "$out" in *ok*) ;; *) echo "window rule failed: $out" >&2 ;; esac
fi

cd "$ROOT" || exit 1
if [ "$MODE" = dev ]; then
  setsid -f sh -c "echo \$\$ > '$PIDFILE'; exec node_modules/.bin/electron-vite dev --remoteDebuggingPort 9333" >"$LOG" 2>&1 </dev/null
else
  setsid -f node_modules/.bin/electron . --remote-debugging-port=9333 >"$LOG" 2>&1 </dev/null
fi

# Wait for the window to map.
i=0
while [ $i -lt 120 ]; do
  ws=$(hyprctl clients -j | jq -r ".[] | select(.class == \"$CLASS\") | .workspace.id" | head -1)
  [ -n "$ws" ] && break
  sleep 0.25; i=$((i + 1))
done
if [ -z "$ws" ]; then echo "window never appeared (see $LOG)" >&2; exit 1; fi

if [ "$ws" != "$WS" ]; then
  W="(function() for _,w in ipairs(hl.get_windows()) do if w.class == \"$CLASS\" then return w end end end)()"
  out=$(hyprctl dispatch "hl.dsp.window.move({ workspace = $WS, window = $W, silent = true })")
  case "$out" in ok*|"") ;; *) echo "move failed: $out" >&2 ;; esac
  ws=$(hyprctl clients -j | jq -r ".[] | select(.class == \"$CLASS\") | .workspace.id" | head -1)
fi
echo "window on workspace $ws"
dp1=$(hyprctl monitors -j | jq -r '.[] | select(.name == "DP-1") | .activeWorkspace.id')
echo "DP-1 active workspace: $dp1"
[ "$dp1" = 6 ] || echo "WARNING: DP-1 no longer on workspace 6" >&2

i=0
until curl -s localhost:9333/json | grep -q '"type": *"page"'; do
  i=$((i + 1)); [ $i -gt 120 ] && { echo "debug port never came up" >&2; exit 1; }
  sleep 0.25
done
echo "debug page ready"
