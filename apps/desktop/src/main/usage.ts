// Cumulative token and cost tracking, kept in ~/.helm/usage.json.
//
// Per-turn numbers already print in the buffer; this answers "what has today
// cost me", which is the question that actually matters when a single turn can
// carry 20k tokens of cached prompt.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TokenUsage } from '@helm/shared';

const USAGE_PATH = join(homedir(), '.helm', 'usage.json');

/**
 * USD per million tokens. Estimates, not billing: the app cannot see your
 * actual invoice, and a cached read is an order of magnitude cheaper than a
 * write, which is why the two are tracked separately.
 */
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const FALLBACK = PRICING['claude-sonnet-5'] as NonNullable<(typeof PRICING)[string]>;

export interface UsageTotals {
  day: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function empty(): UsageTotals {
  return { day: today(), turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

export function estimateCost(usage: TokenUsage, model: string): number {
  const key = Object.keys(PRICING).find((name) => model.includes(name));
  const price = (key ? PRICING[key] : undefined) ?? FALLBACK;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

export function readUsage(): UsageTotals {
  if (!existsSync(USAGE_PATH)) return empty();
  try {
    const raw = JSON.parse(readFileSync(USAGE_PATH, 'utf8')) as Partial<UsageTotals>;
    // Totals are per-day; a new day starts from zero rather than accumulating
    // forever into a number nobody can interpret.
    if (raw.day !== today()) return empty();
    return { ...empty(), ...raw, day: today() };
  } catch {
    return empty();
  }
}

export function recordUsage(usage: TokenUsage, model: string): UsageTotals {
  const totals = readUsage();
  const next: UsageTotals = {
    day: totals.day,
    turns: totals.turns + 1,
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + usage.cacheWrite,
    costUsd: totals.costUsd + estimateCost(usage, model),
  };
  try {
    mkdirSync(dirname(USAGE_PATH), { recursive: true });
    writeFileSync(USAGE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch {
    // Accounting must never break the terminal.
  }
  return next;
}
