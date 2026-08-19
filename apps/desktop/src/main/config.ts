// User preferences, kept in ~/.helm/config.json.
//
// Distinct from .env: .env holds credentials and roots that the agent needs
// before a window exists, while this is what the user changes from inside the
// app and expects to survive a restart.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONFIG_PATH = join(homedir(), '.helm', 'config.json');

export interface HelmConfig {
  /** Overrides HELM_PERMISSION_MODE once set from Preferences. */
  permissionMode: 'off' | 'prompt' | 'auto';
  fontSize: number;
  /** Copy the selection to the clipboard as soon as it is made. */
  copyOnSelect: boolean;
  /** Middle-click pastes, as most terminals do. */
  middleClickPaste: boolean;
  /** Notify when an agent turn finishes while the window is hidden. */
  notifyWhenHidden: boolean;
  /** Check GitHub for a newer commit on startup. */
  checkForUpdates: boolean;
  scrollback: number;
}

const DEFAULTS: HelmConfig = {
  permissionMode: 'prompt',
  fontSize: 13,
  copyOnSelect: true,
  middleClickPaste: true,
  notifyWhenHidden: true,
  checkForUpdates: true,
  scrollback: 50_000,
};

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
