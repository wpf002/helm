#!/usr/bin/env bash
# Builds Helm, installs it to /Applications, and pins it to the Dock.
# Idempotent: re-running replaces the installed copy and does not stack a
# second Dock icon.
#
#   ./scripts/install.sh
#
# HELM_INSTALL_STEP splits it for the updater: `build` builds and signs without
# touching /Applications, so it can run while Helm is open; `install` copies the
# already-built app in, which takes seconds. Unset runs both.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APP_SRC="$ROOT/apps/desktop/release/mac-arm64/Helm.app"
APP_DEST="/Applications/Helm.app"
STEP="${HELM_INSTALL_STEP:-all}"

if [ "$STEP" != install ]; then
  echo "==> building"
  pnpm build
  pnpm --filter @helm/desktop exec electron-builder --mac --dir

  [ -d "$APP_SRC" ] || { echo "error: $APP_SRC not produced by the build." >&2; exit 1; }

  # ---------------------------------------------------------------- signing
  #
  # The Full Disk Access grant is keyed to the code signature. electron-builder
  # signs ad-hoc by default, producing a fresh signature every build, and macOS
  # silently drops the grant each time. Signing with a stable self-signed
  # identity keeps it. create-signing-identity.sh makes that identity without
  # admin rights or any manual Keychain work.
  IDENTITY="${HELM_SIGN_IDENTITY:-Helm Dev}"
  # Create it on first run so a fresh clone does not silently fall back to
  # ad-hoc signing and lose Full Disk Access on every rebuild.
  ./scripts/create-signing-identity.sh
  # Test for the certificate, not `find-identity -p codesigning`: that omits
  # identities with no trust settings, which codesign accepts perfectly well.
  if security find-certificate -c "$IDENTITY" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1; then
    echo "==> signing with '$IDENTITY'"
    ./scripts/sign-dev.sh
  else
    echo "==> WARNING: could not create or find '$IDENTITY'."
    echo "    Falling back to electron-builder's ad-hoc signature; Full Disk"
    echo "    Access will be revoked on every rebuild."
  fi
fi

if [ "$STEP" = build ]; then
  echo "==> built and signed: $APP_SRC"
  exit 0
fi
[ -d "$APP_SRC" ] || { echo "error: nothing built at $APP_SRC." >&2; exit 1; }

# ------------------------------------------------------------- install
echo "==> installing to $APP_DEST"
# A build staged by Helm's own updater is now older than this one. Clear it
# before quitting Helm, or Helm's quit hook would copy it in over this install.
rm -rf "$HOME/.helm/staged"
if [ -d "$APP_DEST" ]; then
  # Quit a running copy first, or the replace leaves a half-written bundle.
  osascript -e 'tell application "Helm" to quit' >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$APP_DEST"
fi
cp -R "$APP_SRC" "$APP_DEST"

# The quarantine bit makes Gatekeeper refuse a self-signed build.
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

# --------------------------------------------------------------- updates
# Run by hand, this clone becomes the one Helm keeps itself current from: every
# five minutes Helm fast-forwards it to GitHub's main (only when that cannot
# touch your work), tests it, builds it, and installs it when you quit. No
# second checkout, no background job. PATH is recorded because a Dock-launched
# app has no node or pnpm on its own.
#
# Not when the launchd updater runs this (HELM_INSTALL_STEP is set): that
# machine's updates belong to com.helm.update, and two updaters would race.
if [ "$STEP" = all ]; then
  mkdir -p "$HOME/.helm"
  printf '%s\n' "$ROOT" > "$HOME/.helm/source-repo"
  printf '%s\n' "$PATH" > "$HOME/.helm/build-path"
  git -C "$ROOT" rev-parse HEAD > "$HOME/.helm/installed-sha" 2>/dev/null || true
  echo "==> Helm will keep itself current from $ROOT"
fi

# --------------------------------------------------------------- env
# A Dock-launched app starts inside /Applications and can never walk up to the
# repo, so it cannot see ./.env. Without credentials there the agent fails on
# every turn with an authentication error. ~/.helm/.env is the location the app
# checks first.
USER_ENV="$HOME/.helm/.env"
if [ -f .env ] && [ ! -f "$USER_ENV" ]; then
  mkdir -p "$HOME/.helm"
  cp .env "$USER_ENV"
  chmod 600 "$USER_ENV"
  echo "==> copied .env to $USER_ENV (mode 600) so the installed app can authenticate"
elif [ -f "$USER_ENV" ]; then
  echo "==> using existing $USER_ENV"
else
  echo "==> WARNING: no .env found; the agent will have no credentials."
fi

# ------------------------------------------------------------- dock
# Skip the add when it is already pinned, so re-running does not stack icons.
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "$APP_DEST"; then
  echo "==> already in the Dock, leaving it alone"
else
  echo "==> pinning to the Dock"
  defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict>
     <key>_CFURLString</key><string>$APP_DEST</string>
     <key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
  killall Dock
fi

cat <<'NOTE'

==> installed.

Full Disk Access has to be granted by hand — it cannot be scripted:

  1. System Settings > Privacy & Security > Full Disk Access
  2. Click +, then choose /Applications/Helm.app
  3. Toggle it on, and quit and reopen Helm

Without it, reads into Documents, Desktop and Downloads fail even though the
agent is scoped to your home directory.
NOTE
