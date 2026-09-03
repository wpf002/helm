// Connectors, from ~/.helm/mcp.json.
//
// The same shape Claude Code uses, so a server you already have configured can
// be pasted straight across:
//
//   { "mcpServers": { "github": { "command": "npx", "args": ["-y", "…"] } } }
//
// Read once, when the agent is built. A malformed file must never stop the
// terminal from opening, so every failure here is silent except in the log.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MCP_PATH = join(homedir(), '.helm', 'mcp.json');

export function loadMcpServers(): Record<string, unknown> {
  if (!existsSync(MCP_PATH)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(MCP_PATH, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    // Accept both the wrapped form and a bare map of servers.
    const record = raw as Record<string, unknown>;
    const servers = 'mcpServers' in record ? record['mcpServers'] : record;
    if (typeof servers !== 'object' || servers === null) return {};

    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      // `helm` is Helm's own in-process server and is not overridable.
      if (name === 'helm' || typeof value !== 'object' || value === null) continue;
      out[name] = value;
    }
    return out;
  } catch (error) {
    console.error(`[helm] ignoring ${MCP_PATH}: ${(error as Error).message}`);
    return {};
  }
}
