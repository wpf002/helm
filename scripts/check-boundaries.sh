#!/usr/bin/env bash
# CI guard. The renderer must never import node builtins, node-pty, or the
# engine directly — everything crosses the preload bridge or it doesn't cross.
set -euo pipefail

VIOLATIONS=$(grep -rEn "from '(node:|fs|path|child_process|node-pty|@helm/(engine|shell))" \
  apps/desktop/src/renderer 2>/dev/null || true)

if [ -n "$VIOLATIONS" ]; then
  echo "boundary violation — renderer reached past the preload bridge:" >&2
  echo "$VIOLATIONS" >&2
  exit 1
fi
echo "==> renderer boundary clean"
