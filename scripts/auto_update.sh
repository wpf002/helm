#!/bin/zsh
# Keeps /Applications/Helm.app on the latest origin/main. Runs on a timer
# (com.helm.update, every 5 minutes) from a deploy-only checkout, never from the
# clone you work in: it hard-resets $HELM_REPO to GitHub.
#
#   push to main -> next tick tests, builds and signs it, even with Helm open
#                -> the moment Helm is closed, it is copied in (seconds)
#
# It never quits Helm under you. Installing used to wait for a tick that found
# Helm closed, and a quit-and-reopen inside five minutes missed it every time,
# so a tick with an update ready now watches for Helm to close instead of
# exiting. A commit that fails the gate is skipped until a newer one arrives.
set -u
REPO="${HELM_REPO:-$HOME/helm}"   # deploy-only; never point this at a dev clone
STATE="$HOME/.helm"
STAMP="$STATE/installed-sha"      # what /Applications/Helm.app was built from
FAILED="$STATE/update-failed-sha" # last commit that failed the gate
NOTIFIED="$STATE/update-notified-sha"
CHECKED="$STATE/update-checked"    # when the last successful check ran
BUILT="$STATE/update-built-sha"    # commit whose app is built, signed and ready to copy in
WAIT_TICKS="${HELM_UPDATE_WAIT_TICKS:-90}" # 3s each: watch for a quit for most of the 5 minutes
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
# The log stays silent when there is nothing new, which looks like a stalled
# job. This records that the check itself ran.
date '+%F %T' > "$CHECKED"
target=$(git rev-parse origin/main)
short=${target[1,7]}

[ "$target" = "$(cat "$STAMP" 2>/dev/null)" ] && exit 0
[ "$target" = "$(cat "$FAILED" 2>/dev/null)" ] && exit 0

if [ "$target" != "$(cat "$BUILT" 2>/dev/null)" ]; then
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
  # Building never touches /Applications, so it is safe with Helm open.
  if ! HELM_INSTALL_STEP=build ./scripts/install.sh >/dev/null 2>&1; then
    echo "$target" > "$FAILED"
    log "build failed for $short; run scripts/install.sh by hand from $REPO to see why"
    notify "Update $short failed to build. Kept the current Helm."
    exit 0
  fi
  echo "$target" > "$BUILT"
  log "built $short ($subject)"
fi
subject=$(git log -1 --format=%s "$target")

if helm_running; then
  if [ "$target" != "$(cat "$NOTIFIED" 2>/dev/null)" ]; then
    notify "Helm update ready. Quit Helm to install it; it takes a few seconds."
    echo "$target" > "$NOTIFIED"
    log "update $short ready; waiting for Helm to quit"
  fi
  for _ in $(seq 1 "$WAIT_TICKS"); do
    sleep 3
    helm_running || break
  done
  helm_running && exit 0 # the next tick keeps watching
fi

if HELM_INSTALL_STEP=install ./scripts/install.sh >/dev/null 2>&1; then
  echo "$target" > "$STAMP"
  rm -f "$FAILED" "$BUILT"
  log "installed $short ($subject)"
  notify "Helm is updated ($subject). Open it again to use it."
else
  # The built app was not usable; build it again next tick rather than giving up.
  rm -f "$BUILT"
  log "install failed for $short; will rebuild and retry"
  notify "Helm update did not install. It will try again."
fi
