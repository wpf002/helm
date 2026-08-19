// Reads ~/.helm/routing.jsonl and prints the distribution.
//
//   pnpm routing:report
//
// `mode` is the important column. 'shadow' means you chose the destination and
// routeInput() only recorded what it would have done — the disagreement rate
// there is the misroute rate you would get by switching inference on.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG = process.argv[2] ?? join(homedir(), '.helm', 'routing.jsonl');

if (!existsSync(LOG)) {
  console.log(`No routing log at ${LOG}.`);
  console.log('Use Helm for a while, then run this again.');
  process.exit(0);
}

const rows = readFileSync(LOG, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

if (rows.length === 0) {
  console.log('Routing log is empty.');
  process.exit(0);
}

const pct = (n, d) => (d === 0 ? '  0.0%' : `${((n / d) * 100).toFixed(1).padStart(5)}%`);
const bar = (n, d, width = 28) => '█'.repeat(d === 0 ? 0 : Math.round((n / d) * width));

const byMode = {};
const byTarget = { shell: 0, agent: 0 };
const byRule = {};
const disagreements = [];

for (const r of rows) {
  byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
  if (r.target in byTarget) byTarget[r.target]++;
  for (const f of r.factors ?? []) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  if (r.inferred && r.inferred !== r.target) disagreements.push(r);
}

const first = rows[0]?.ts?.slice(0, 10) ?? '?';
const last = rows[rows.length - 1]?.ts?.slice(0, 10) ?? '?';

console.log(`\nHelm routing — ${rows.length} decisions, ${first} to ${last}`);
console.log(`${LOG}\n`);

console.log('Where input went');
for (const [target, n] of Object.entries(byTarget)) {
  console.log(`  ${target.padEnd(6)} ${String(n).padStart(5)}  ${pct(n, rows.length)}  ${bar(n, rows.length)}`);
}

console.log('\nHow it was decided');
for (const [mode, n] of Object.entries(byMode).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${mode.padEnd(6)} ${String(n).padStart(5)}  ${pct(n, rows.length)}`);
}

console.log('\nRules fired');
for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule.padEnd(26)} ${String(n).padStart(5)}  ${bar(n, rows.length, 20)}`);
}

// The number the kill gate is about.
const shadow = rows.filter((r) => r.mode === 'shadow');
const shadowDisagree = disagreements.filter((r) => r.mode === 'shadow');
console.log('\nMisroute rate (inference vs. what you actually did)');
if (shadow.length === 0) {
  console.log('  No shadow observations yet.');
} else {
  const rate = (shadowDisagree.length / shadow.length) * 100;
  console.log(`  ${shadowDisagree.length} of ${shadow.length} shadow decisions disagree — ${rate.toFixed(1)}%`);
  console.log(`  Kill gate is 5%: ${rate > 5 ? 'ABOVE — inference is a liability, keep explicit prefixes' : 'below — inference looks safe to switch on'}`);
}

if (shadowDisagree.length > 0) {
  console.log('\nMost recent disagreements');
  for (const r of shadowDisagree.slice(-10)) {
    console.log(`  you:${String(r.target).padEnd(5)} inferred:${String(r.inferred).padEnd(5)} ${JSON.stringify(r.input.slice(0, 58))}`);
    console.log(`      ${(r.factors ?? []).map((f) => f.rule).join(' → ')}`);
  }
}
console.log('');
