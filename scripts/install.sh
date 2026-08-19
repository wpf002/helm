#!/usr/bin/env bash
# Builds Helm, installs it to /Applications, and pins it to the Dock.
# Idempotent: re-running replaces the installed copy and does not stack a
# second Dock icon.
#
#   ./scripts/install.sh

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APP_SRC="$ROOT/apps/desktop/release/mac-arm64/Helm.app"
APP_DEST="/Applications/Helm.app"

echo "==> building"
pnpm build
pnpm --filter @helm/desktop exec electron-builder --mac --dir

[ -d "$APP_SRC" ] || { echo "error: $APP_SRC not produced by the build." >&2; exit 1; }

# ---------------------------------------------------------------- signing
#
# The Full Disk Access grant is keyed to the code signature. electron-builder
# signs ad-hoc by default, producing a fresh signature every build, and macOS
# silently drops the grant each time. Signing with a stable self-signed
# identity keeps it. Creating that identity is a one-time manual Keychain
# step — see the header of scripts/sign-dev.sh.
IDENTITY="${HELM_SIGN_IDENTITY:-Helm Dev}"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "==> signing with '$IDENTITY'"
  ./scripts/sign-dev.sh
else
  echo "==> WARNING: no '$IDENTITY' code-signing identity found."
  echo "    Falling back to the ad-hoc signature electron-builder produced."
  echo "    Full Disk Access will be revoked on every rebuild until you create"
  echo "    the identity. Instructions: head -20 scripts/sign-dev.sh"
fi

# ------------------------------------------------------------- install
echo "==> installing to $APP_DEST"
if [ -d "$APP_DEST" ]; then
  # Quit a running copy first, or the replace leaves a half-written bundle.
  osascript -e 'tell application "Helm" to quit' >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$APP_DEST"
fi
cp -R "$APP_SRC" "$APP_DEST"

# The quarantine bit makes Gatekeeper refuse a self-signed build.
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

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
