#!/usr/bin/env bash
# Signs the built .app with a stable self-signed identity so the Full Disk
# Access grant survives rebuilds. Ad-hoc signing (the electron-builder default)
# produces a new signature every build and macOS drops the TCC grant each time.
#
# One-time setup — create the identity in Keychain Access:
#   Keychain Access > Certificate Assistant > Create a Certificate
#     Name: Helm Dev
#     Identity Type: Self Signed Root
#     Certificate Type: Code Signing
#   Then: double-click it > Trust > Code Signing: Always Trust

set -euo pipefail
IDENTITY="${HELM_SIGN_IDENTITY:-Helm Dev}"
APP="apps/desktop/release/mac-arm64/Helm.app"

[ -d "$APP" ] || { echo "error: $APP not found. Run pnpm package first." >&2; exit 1; }

codesign --force --deep --sign "$IDENTITY" \
  --entitlements apps/desktop/build/entitlements.mac.plist \
  "$APP"

codesign --verify --verbose "$APP"
echo "==> signed with '$IDENTITY'"
echo "    Grant Full Disk Access: System Settings > Privacy & Security > Full Disk Access"
