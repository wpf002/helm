// Measures what a turn actually costs, end to end, through the real engine.
//
//   pnpm tokens:report
//
// Exists because the intuitive optimisations are wrong here. Trimming the
// system prompt or the tool set invalidates the prompt cache, and a cold turn
// costs three to four times a cached one — so "using fewer tokens" by changing
// the configuration makes it more expensive, not less. Re-run this before
// believing any claim about token cost, including mine.

import { readFileSync } from 'node:fs';
for (const line of readFileSync('/Users/willfoti/.helm/.env','utf8').split('\n')) {
  const m=/^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { createSession } = await import('/Users/willfoti/Documents/GitHub/helm/packages/engine/dist/index.js');

const turns = [];
const session = await createSession(
  { homeRoot: process.env.HOME, extraRoots: [], permissionMode: 'auto' },
  { onEvent: (e) => { if (e.kind === 'turn_end' && e.usage) turns.push(e.usage); },
    requestPermission: async (r) => ({ id: r.id, behavior: 'allow', persist: false }) },
);

const asks = ['Reply: one', 'Reply: two', 'Use Bash to run: echo three', 'Reply: four'];
for (const ask of asks) {
  const before = turns.length;
  await session.prompt(ask);
  const start = Date.now();
  while (turns.length === before && Date.now() - start < 120000) await new Promise(r => setTimeout(r, 200));
}
await session.dispose();

const price = (u) => (u.input*3 + u.cacheWrite*3.75 + u.cacheRead*0.30 + u.output*15) / 1e6;
let total = 0;
console.log('turn  fresh   cached   out    cost');
turns.forEach((u, i) => {
  const c = price(u); total += c;
  console.log(`${String(i+1).padStart(4)}  ${String(u.input+u.cacheWrite).padStart(5)}   ${String(u.cacheRead).padStart(6)}  ${String(u.output).padStart(4)}   $${c.toFixed(4)}`);
});
console.log(`\n${turns.length} turns, $${total.toFixed(4)} total, $${(total/turns.length).toFixed(4)} average`);
console.log(`100 turns/day would be about $${(total/turns.length*100).toFixed(2)}`);
process.exit(0);
import { readFileSync } from 'node:fs';
for (const line of readFileSync('/Users/willfoti/.helm/.env','utf8').split('\n')) {
  const m=/^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { createSession } = await import('/Users/willfoti/Documents/GitHub/helm/packages/engine/dist/index.js');

const turns = [];
const session = await createSession(
  { homeRoot: process.env.HOME, extraRoots: [], permissionMode: 'auto' },
  { onEvent: (e) => { if (e.kind === 'turn_end' && e.usage) turns.push(e.usage); },
    requestPermission: async (r) => ({ id: r.id, behavior: 'allow', persist: false }) },
);

const asks = ['Reply: one', 'Reply: two', 'Use Bash to run: echo three', 'Reply: four'];
for (const ask of asks) {
  const before = turns.length;
  await session.prompt(ask);
  const start = Date.now();
  while (turns.length === before && Date.now() - start < 120000) await new Promise(r => setTimeout(r, 200));
}
await session.dispose();

const price = (u) => (u.input*3 + u.cacheWrite*3.75 + u.cacheRead*0.30 + u.output*15) / 1e6;
let total = 0;
console.log('turn  fresh   cached   out    cost');
turns.forEach((u, i) => {
  const c = price(u); total += c;
  console.log(`${String(i+1).padStart(4)}  ${String(u.input+u.cacheWrite).padStart(5)}   ${String(u.cacheRead).padStart(6)}  ${String(u.output).padStart(4)}   $${c.toFixed(4)}`);
});
console.log(`\n${turns.length} turns, $${total.toFixed(4)} total, $${(total/turns.length).toFixed(4)} average`);
console.log(`100 turns/day would be about $${(total/turns.length*100).toFixed(2)}`);
process.exit(0);
