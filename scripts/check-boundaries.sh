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

# The Agent SDK is ESM-only and the main process is bundled as CommonJS, so a
# static import of it anywhere on main's import graph throws ERR_REQUIRE_ESM at
# launch — before a window exists, with nothing on stderr. It has cost a day
# twice. Every path into the SDK must be a dynamic import() or `import type`.
STATIC=$(grep -rEn "^import [^t].*'@anthropic-ai/claude-agent-sdk'" \
  packages/engine/src apps/desktop/src/main 2>/dev/null || true)

if [ -n "$STATIC" ]; then
  echo "the Agent SDK is imported statically; main will not launch:" >&2
  echo "$STATIC" >&2
  exit 1
fi

BUILT=apps/desktop/out/main/index.cjs
if [ -f "$BUILT" ] && grep -q 'require("@anthropic-ai/claude-agent-sdk")' "$BUILT"; then
  echo "built main requires the SDK synchronously; it will crash at launch:" >&2
  exit 1
fi
echo "==> SDK stays behind a dynamic import"
