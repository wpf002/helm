// User preferences, kept in ~/.helm/config.json.
//
// Distinct from .env: .env holds credentials and roots that the agent needs
// before a window exists, while this is what the user changes from inside the
// app and expects to survive a restart.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HelmConfig } from '@helm/shared';

// One definition, shared with the renderer. Two copies of this interface drift,
// and the drift is invisible until a setting silently stops crossing the IPC.
export type { HelmConfig };

export const CONFIG_PATH = join(homedir(), '.helm', 'config.json');


const DEFAULTS: HelmConfig = {
  permissionMode: 'prompt',
  fontSize: 13,
  copyOnSelect: true,
  middleClickPaste: true,
  notifyWhenHidden: true,
  checkForUpdates: true,
  scrollback: 50_000,
  model: 'claude-sonnet-5',
};

const MODELS = new Set<HelmConfig['model']>([
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-haiku-4-5-20251001',
]);

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadConfig(): HelmConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const bool = (key: keyof HelmConfig): boolean =>
      typeof record[key] === 'boolean' ? (record[key] as boolean) : (DEFAULTS[key] as boolean);
    const mode = record['permissionMode'];
    return {
      permissionMode:
        mode === 'off' || mode === 'auto' || mode === 'prompt' ? mode : DEFAULTS.permissionMode,
      fontSize: clamp(record['fontSize'], 8, 32, DEFAULTS.fontSize),
      copyOnSelect: bool('copyOnSelect'),
      middleClickPaste: bool('middleClickPaste'),
      notifyWhenHidden: bool('notifyWhenHidden'),
      checkForUpdates: bool('checkForUpdates'),
      scrollback: clamp(record['scrollback'], 1_000, 500_000, DEFAULTS.scrollback),
      model: MODELS.has(record['model'] as HelmConfig['model'])
        ? (record['model'] as HelmConfig['model'])
        : DEFAULTS.model,
    };
  } catch {
    // A corrupt config must not stop the terminal from opening.
    return { ...DEFAULTS };
  }
}

export function saveConfig(patch: Partial<HelmConfig>): HelmConfig {
  const next = { ...loadConfig(), ...patch };
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch {
    // Preferences are not worth failing over; the in-memory value still applies.
  }
  return next;
}
