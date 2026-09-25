#!/bin/zsh
# Keeps /Applications/Helm.app on the latest origin/main. Runs on a timer
# (com.helm.update, every 5 minutes) from a deploy-only checkout, never from the
# clone you work in: it hard-resets $HELM_REPO to GitHub.
#
#   push to main -> next tick builds, tests, signs and installs it
#
# It never quits Helm under you. If Helm is open when a new commit lands, it
# posts one notification and waits; the first tick after you quit installs it.
# A commit that fails the gate is skipped until a newer one arrives.
set -u
REPO="${HELM_REPO:-$HOME/helm}"   # deploy-only; never point this at a dev clone
STATE="$HOME/.helm"
STAMP="$STATE/installed-sha"      # what /Applications/Helm.app was built from
FAILED="$STATE/update-failed-sha" # last commit that failed the gate
NOTIFIED="$STATE/update-notified-sha"
APP_BIN="/Applications/Helm.app/Contents/MacOS/Helm"

log() { echo "$(date '+%F %T') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Helm\"" >/dev/null 2>&1 || true; }
# Arguments are allowed after the path: a launch that passes any must still
# count as running, or the update would quit Helm out from under you.
helm_running() { pgrep -qf "^$APP_BIN( |$)"; }

cd "$REPO" || { log "no checkout at $REPO"; exit 0; }

# Same stall guard as Flint's deploy: give up on a dead connection in 20s.
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch --quiet origin main \
  || { log "fetch failed"; exit 0; }
target=$(git rev-parse origin/main)
short=${target[1,7]}

[ "$target" = "$(cat "$STAMP" 2>/dev/null)" ] && exit 0
[ "$target" = "$(cat "$FAILED" 2>/dev/null)" ] && exit 0

if helm_running; then
  if [ "$target" != "$(cat "$NOTIFIED" 2>/dev/null)" ]; then
    notify "Update $short is ready. Quit Helm to install it."
    echo "$target" > "$NOTIFIED"
    log "update $short ready; waiting for Helm to quit"
  fi
  exit 0
fi

log "building $short"
git reset --hard --quiet "$target"
subject=$(git log -1 --format=%s)

if ! pnpm install --frozen-lockfile >/dev/null 2>&1 \
  || ! pnpm test >/dev/null 2>&1 \
  || ! pnpm typecheck >/dev/null 2>&1; then
  echo "$target" > "$FAILED"
  log "gate failed for $short ($subject); keeping the installed build"
  notify "Update $short failed its tests. Kept the current Helm."
  exit 0
fi

# The gate takes a while. If Helm was opened meanwhile, install.sh would quit
# it, so wait for the next tick instead.
if helm_running; then
  log "Helm opened during the build of $short; will install after it quits"
  exit 0
fi

if ./scripts/install.sh >/dev/null 2>&1; then
  echo "$target" > "$STAMP"
  rm -f "$FAILED"
  log "installed $short ($subject)"
  notify "Updated to $short: $subject"
else
  echo "$target" > "$FAILED"
  log "install.sh failed for $short; run it by hand from $REPO to see why"
  notify "Update $short failed to install. Kept the current Helm."
fi
