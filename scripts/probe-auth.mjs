// Phase 0 gate. Runs one trivial agent turn and prints how it authenticated.
// If this bills against your API credits instead of your subscription, stop
// and resolve that before building anything on top.
//
//   node scripts/probe-auth.mjs
//
// Check console.anthropic.com usage immediately after. Zero new usage means
// subscription credentials carried through. Nonzero means metered billing.

import { query } from '@anthropic-ai/claude-agent-sdk';

console.log('ANTHROPIC_API_KEY set:', Boolean(process.env.ANTHROPIC_API_KEY));

const result = query({
  prompt: 'Reply with the single word: ok',
  options: { permissionMode: 'bypassPermissions', allowedTools: [] },
});

for await (const message of result) {
  console.log(JSON.stringify(message));
}
