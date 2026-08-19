// Append-only log of every routing decision, so the misroute rate can be
// measured from real use rather than guessed at. One JSON object per line;
// `pnpm routing:report` reads it back.

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Factor, InputRoute } from '@helm/shared';

export const ROUTING_LOG = join(homedir(), '.helm', 'routing.jsonl');

export interface RoutingRecord {
  ts: string;
  /** What was typed, before any prefix was stripped. */
  input: string;
  /** Where it actually went. */
  target: 'shell' | 'agent';
  /** What routeInput() would have chosen, when that differs from `target`. */
  inferred?: 'shell' | 'agent';
  /** Which rules fired, and why. */
  factors: Factor[];
  /**
   * 'live'   — inference chose the destination.
   * 'prefix' — an explicit $ or ? chose it.
   * 'shadow' — the user's own choice stood; inference was only recorded.
   */
  mode: 'live' | 'prefix' | 'shadow';
}

let warned = false;

/** Never let logging break the terminal: a failed write is swallowed once. */
export async function logRouting(record: RoutingRecord): Promise<void> {
  try {
    await mkdir(dirname(ROUTING_LOG), { recursive: true });
    await appendFile(ROUTING_LOG, JSON.stringify(record) + '\n', 'utf8');
  } catch (error) {
    if (!warned) {
      warned = true;
      console.error(`[helm] routing log unavailable: ${String(error)}`);
    }
  }
}

export function recordFor(
  input: string,
  route: InputRoute,
  factors: Factor[],
  mode: RoutingRecord['mode'],
  actual?: 'shell' | 'agent',
): RoutingRecord {
  const inferred = route.target;
  const target = actual ?? inferred;
  return {
    ts: new Date().toISOString(),
    input,
    target,
    ...(inferred === target ? {} : { inferred }),
    factors,
    mode,
  };
}
