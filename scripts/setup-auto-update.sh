#!/bin/zsh
# One-time setup for com.helm.update: a deploy-only clone at ~/helm and the
# LaunchAgent that keeps /Applications/Helm.app on origin/main from it.
# Idempotent. Undo with:
#   launchctl bootout gui/$(id -u)/com.helm.update
#   rm ~/Library/LaunchAgents/com.helm.update.plist
set -eu
SRC="${0:A:h}"
DEPLOY="$HOME/helm"
PLIST="$HOME/Library/LaunchAgents/com.helm.update.plist"
URL=$(git -C "$SRC/.." remote get-url origin)

if [ ! -d "$DEPLOY/.git" ]; then
  echo "==> cloning $URL to $DEPLOY (deploy-only; do not edit it)"
  git clone --quiet "$URL" "$DEPLOY"
fi

mkdir -p "$HOME/.helm" "$HOME/Library/LaunchAgents"
cp "$SRC/com.helm.update.plist" "$PLIST"
launchctl bootout "gui/$(id -u)/com.helm.update" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "==> com.helm.update loaded. It checks every 5 minutes; log: ~/.helm/update.log"
