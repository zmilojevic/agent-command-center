#!/usr/bin/env bash
# Launch an isolated test instance on the main window's workspace without taking focus. Never kills anything.
PORT=${1:-9334}
PROFILE=${2:-/tmp/ccd-test/profile}
REPO=$(cd "$(dirname "$0")/.." && pwd)

WS=$(hyprctl clients -j | jq -r '[.[] | select(.class=="agent-command-center" and (.title|startswith("CCD-TEST")|not))][0].workspace.id // empty')
[ -n "$WS" ] || WS=$(hyprctl activeworkspace -j | jq -r '.id')

# hl.window_rule registers the rule as a side effect; the "expected a dispatcher" message is expected.
hyprctl dispatch "hl.window_rule({ match = { initial_title = \"^(CCD-TEST)\$\" }, workspace = \"$WS silent\", no_initial_focus = true })" >/dev/null 2>&1 || true

mkdir -p "$PROFILE"
LOG="$(dirname "$PROFILE")/electron.log"
cd "$REPO" || exit 1
CCD_WINDOW_TITLE=CCD-TEST nohup node_modules/.bin/electron . --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" >"$LOG" 2>&1 &
disown

for _ in $(seq 1 30); do
  curl -s "localhost:$PORT/json/version" >/dev/null && break
  sleep 0.5
done
sleep 1

PID=$(hyprctl clients -j | jq -r '[.[] | select(.title=="CCD-TEST")][0].pid // empty')
[ -n "$PID" ] || PID=$(pgrep -f "remote-debugging-port=$PORT" | head -1)
echo "electron pid: $PID"
echo "target workspace: $WS"
echo "window workspace: $(hyprctl clients -j | jq -r '[.[] | select(.title=="CCD-TEST")][0].workspace.id // "none"')"
echo "focused window: $(hyprctl activewindow -j | jq -c '{class, title, workspace: .workspace.id}')"
