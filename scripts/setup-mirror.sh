#!/bin/zsh
# Makes another Mac receive every Helm build this one makes.
#
#   scripts/setup-mirror.sh willfoti@100.96.103.37
#
# Run on the building machine (the one with com.helm.update). The target needs
# no node, no checkout and no signing identity: it gets the signed app over SSH
# and installs it whenever Helm is closed there. Idempotent. Undo on the target:
#   launchctl bootout gui/$(id -u)/com.helm.apply
#   rm ~/Library/LaunchAgents/com.helm.apply.plist ~/.helm/bin/helm-apply.sh
# and remove its line from ~/.helm/mirrors here.
set -eu
HOST="${1:?usage: setup-mirror.sh user@host}"
SRC="${0:A:h}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)

"${SSH[@]}" "$HOST" 'mkdir -p ~/.helm/bin ~/.helm/staged ~/Library/LaunchAgents'
scp -q -o BatchMode=yes "$SRC/helm-apply.sh" "$HOST:.helm/bin/helm-apply.sh"

# launchd does not expand ~ or $HOME, so the plist is written on the target
# with its own home directory filled in.
"${SSH[@]}" "$HOST" 'zsh -s' <<'REMOTE'
set -eu
chmod 755 ~/.helm/bin/helm-apply.sh
cat > ~/Library/LaunchAgents/com.helm.apply.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.helm.apply</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>$HOME/.helm/bin/helm-apply.sh</string></array>
  <key>WatchPaths</key><array><string>$HOME/.helm/staged/sha</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.helm/update.log</string>
  <key>StandardErrorPath</key><string>$HOME/.helm/update.err.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/com.helm.apply" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.helm.apply.plist
REMOTE

mkdir -p "$HOME/.helm"
touch "$HOME/.helm/mirrors"
grep -qxF "$HOST" "$HOME/.helm/mirrors" || echo "$HOST" >> "$HOME/.helm/mirrors"
echo "==> $HOST receives every build com.helm.update makes here."
