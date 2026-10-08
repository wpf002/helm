#!/bin/zsh
# Installs a Helm build that another machine shipped here. Runs on a machine
# with no toolchain of its own — the Mac Studio has no node — under the
# com.helm.apply LaunchAgent, which fires when a build lands and every five
# minutes besides. Set up from the building machine with scripts/setup-mirror.sh.
#
# Why ship instead of build: the build carries the signing machine's identity,
# so a Full Disk Access grant keyed to that signature survives every update.
# Building here would sign with a different certificate and silently drop it.
#
# It never quits Helm under you. With Helm open it watches for a quit and
# installs seconds after, exactly like the updater on the building machine.
set -u
STATE="${HELM_STATE:-$HOME/.helm}"   # overridable so the install path can be
APP="${HELM_APP:-/Applications/Helm.app}" # tested without touching the real app
STAGED="$STATE/staged"
STAMP="$STATE/installed-sha"
NOTIFIED="$STATE/apply-notified-sha"
WAIT_TICKS="${HELM_UPDATE_WAIT_TICKS:-90}" # 3s each
APP_BIN="$APP/Contents/MacOS/Helm"

log() { echo "$(date '+%F %T') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Helm\"" >/dev/null 2>&1 || true; }
helm_running() { pgrep -qf "^$APP_BIN( |$)"; }

# The sender writes the zip first and the sha last, so a sha with no zip, or a
# sha that names what is already installed, means there is nothing to do.
[ -f "$STAGED/sha" ] && [ -f "$STAGED/Helm.zip" ] || exit 0
want=$(cat "$STAGED/sha")
short=${want[1,7]}
[ "$want" = "$(cat "$STAMP" 2>/dev/null)" ] && exit 0

if helm_running; then
  if [ "$want" != "$(cat "$NOTIFIED" 2>/dev/null)" ]; then
    notify "Helm update ready. Quit Helm to install it; it takes a few seconds."
    echo "$want" > "$NOTIFIED"
    log "update $short ready; waiting for Helm to quit"
  fi
  for _ in $(seq 1 "$WAIT_TICKS"); do
    sleep 3
    helm_running || break
  done
  helm_running && exit 0 # the next tick keeps watching
fi

work=$(mktemp -d) || exit 0
trap 'rm -rf "$work"' EXIT
if ! ditto -x -k "$STAGED/Helm.zip" "$work" || [ ! -d "$work/Helm.app" ]; then
  log "staged build $short would not unpack; waiting for the next one"
  exit 0
fi
# A truncated transfer must never replace a working app.
if ! codesign --verify --strict "$work/Helm.app" >/dev/null 2>&1; then
  log "staged build $short failed signature verification; keeping the installed one"
  exit 0
fi

rm -rf "$APP"
mv "$work/Helm.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
echo "$want" > "$STAMP"
log "installed $short"
notify "Helm is updated. Open it again to use it."
