#!/bin/bash
# RecallNest MCP Server startup script
# Handles first-run bun install automatically
set -e

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Run from the install dir, never the caller's cwd. An MCP client spawns this
# from whatever repo the agent is working in; anything that resolves a relative
# path would otherwise land in that repo. Defense in depth — the code paths
# themselves resolve via src/data-dir.ts. Nothing in the server derives scope
# or config from the cwd, so this is safe to pin.
cd "$PLUGIN_DIR"

if [ ! -d "$PLUGIN_DIR/node_modules" ]; then
  bun install --frozen-lockfile --silent 2>/dev/null
fi

exec bun run "$PLUGIN_DIR/src/mcp-server.ts"
