#!/bin/sh
# Runs the KYRA backend (and, through it, the camera sidecar) as a macOS LaunchAgent: started at login,
# restarted within seconds if it ever exits. A LaunchAgent runs in the logged-in user's session, which
# the camera needs.
#
#   deploy/launchd.sh install     write the agent and start it
#   deploy/launchd.sh uninstall   stop it and remove the agent
#   deploy/launchd.sh status      is it running?
#
# Logs: backend/.runtime/logs/kyra-YYYY-MM-DD.log (and launchd.log for anything printed before start).
# The first start may ask for camera access for "node": allow it in System Settings → Privacy & Security.
set -eu

LABEL=com.kyra.mirror
BACKEND_DIR=$(cd "$(dirname "$0")/.." && pwd)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=$(command -v node || true)

case "${1:-}" in
  install)
    [ -n "$NODE" ] || { echo "node not found on PATH" >&2; exit 1; }
    [ -f "$BACKEND_DIR/.env" ] || { echo "Create $BACKEND_DIR/.env first (see .env.example)" >&2; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents" "$BACKEND_DIR/.runtime/logs"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>src/server.js</string></array>
  <key>WorkingDirectory</key><string>$BACKEND_DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>45</integer>
  <key>StandardOutPath</key><string>$BACKEND_DIR/.runtime/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$BACKEND_DIR/.runtime/logs/launchd.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed and started $LABEL ($PLIST)"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" || echo "$LABEL is not installed"
    ;;
  *)
    echo "usage: $0 install|uninstall|status" >&2
    exit 2
    ;;
esac
