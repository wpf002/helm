// Measures what a turn actually costs, end to end, through the real engine.
//
//   pnpm tokens:report
//
// Exists because the intuitive optimisations are wrong here. Trimming the
// system prompt or the tool set invalidates the prompt cache, and a cold turn
// costs three to four times a cached one — so "using fewer tokens" by changing
// the configuration makes it more expensive, not less. Re-run this before
// believing any claim about token cost, including the ones in the README.
//
// This spends real money: four short turns, about five cents.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Credentials live in ~/.helm/.env for the packaged app, or the repo in a
// checkout. Real environment variables win over both.
for (const candidate of [join(homedir(), '.helm', '.env'), join(here, '..', '.env')]) {
  if (!existsSync(candidate)) continue;
  for (const line of readFileSync(candidate, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match && match[1] && !process.env[match[1]]) process.env[match[1]] = match[2] ?? '';
  }
  break;
}

const { createSession } = await import(
  join(here, '..', 'packages', 'engine', 'dist', 'index.js')
);

/** Sonnet list prices, USD per million tokens. A cached read is a tenth of a fresh one. */
const PRICE = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
const costOf = (u) =>
  (u.input * PRICE.input +
    u.cacheWrite * PRICE.cacheWrite +
    u.cacheRead * PRICE.cacheRead +
    u.output * PRICE.output) /
  1e6;

const turns = [];
const session = await createSession(
  { homeRoot: homedir(), extraRoots: [], permissionMode: 'auto' },
  {
    onEvent: (event) => {
      if (event.kind === 'turn_end' && event.usage) turns.push(event.usage);
    },
    requestPermission: async (request) => ({ id: request.id, behavior: 'allow', persist: false }),
  },
);

const asks = ['Reply: one', 'Reply: two', 'Use Bash to run: echo three', 'Reply: four'];
for (const ask of asks) {
  const before = turns.length;
  await session.prompt(ask);
  const start = Date.now();
  while (turns.length === before && Date.now() - start < 120_000) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
await session.dispose();

if (turns.length === 0) {
  console.log('No turns completed — check credentials in ~/.helm/.env.');
  process.exit(1);
}

console.log('\nturn   fresh   cached   out      cost');
let total = 0;
turns.forEach((usage, index) => {
  const cost = costOf(usage);
  total += cost;
  console.log(
    `${String(index + 1).padStart(4)}   ${String(usage.input + usage.cacheWrite).padStart(5)}   ` +
      `${String(usage.cacheRead).padStart(6)}   ${String(usage.output).padStart(3)}   $${cost.toFixed(4)}`,
  );
});

const average = total / turns.length;
console.log(`\n${turns.length} turns, $${total.toFixed(4)} total, $${average.toFixed(4)} average`);
console.log(`100 turns is about $${(average * 100).toFixed(2)}`);

// The first turn writes the cache; the rest read it. If that gap closes, the
// cache is not holding and something in the configuration is churning.
if (turns.length > 1) {
  const first = costOf(turns[0]);
  const rest = turns.slice(1).reduce((sum, u) => sum + costOf(u), 0) / (turns.length - 1);
  console.log(
    `\nfirst turn $${first.toFixed(4)} vs $${rest.toFixed(4)} after — ` +
      `${first > rest ? 'the cache is holding' : 'the cache is NOT holding; check for config churn'}`,
  );
}
process.exit(0);
