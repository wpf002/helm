import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Minimal .env reader. Nothing in the tree loads .env otherwise, so
 * HELM_SHELL / HELM_HOME_ROOT / HELM_EXTRA_ROOTS would silently never apply.
 * Deliberately dependency-free rather than pulling in dotenv.
 *
 * Real environment variables win over the file — exporting a value in the
 * shell you launched from must override a stale checked-out default.
 */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // .env.example ships `HELM_HOME_ROOT=$HOME`, which is a literal string
    // until something expands it.
    value = value.replace(/\$\{?HOME\}?/g, homedir());
    out[key] = value;
  }
  return out;
}

/**
 * Walks up from `start` looking for a .env, stopping at the filesystem root.
 * A packaged app launched from the Dock starts inside /Applications and can
 * never reach the repo, so ~/.helm/.env is checked first — without it the
 * agent has no credentials and every turn fails on authentication.
 */
function findEnvFile(start: string): string | undefined {
  const userEnv = join(homedir(), '.helm', '.env');
  if (existsSync(userEnv)) return userEnv;

  let dir = resolve(start);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export interface HelmEnv {
  shell: string;
  homeRoot: string;
  extraRoots: string[];
  permissionMode: 'off' | 'prompt' | 'auto';
  /** Overrides the engine's default model. Unset means Sonnet. */
  model: string | undefined;
  envFile: string | undefined;
}

export function loadEnv(startDir: string): HelmEnv {
  const envFile = findEnvFile(startDir);
  const fromFile = envFile ? parseEnvFile(readFileSync(envFile, 'utf8')) : {};

  // Publish the file's values into the real environment. The agent SDK runs as
  // a child process and reads credentials from its own environment, so a key
  // that only exists in this object never reaches it — the agent then falls
  // back to whatever stale OAuth record is on the machine and fails to
  // authenticate. Real environment variables still win.
  for (const [key, value] of Object.entries(fromFile)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const read = (key: string): string | undefined => process.env[key] ?? fromFile[key];

  const rawMode = read('HELM_PERMISSION_MODE');
  const permissionMode =
    rawMode === 'off' || rawMode === 'auto' || rawMode === 'prompt' ? rawMode : 'prompt';

  const rawRoots = read('HELM_EXTRA_ROOTS') ?? '';

  return {
    shell: read('HELM_SHELL') || process.env['SHELL'] || '/bin/zsh',
    homeRoot: read('HELM_HOME_ROOT') || homedir(),
    extraRoots: rawRoots.split(':').filter((r) => r.length > 0),
    permissionMode,
    model: read('HELM_MODEL'),
    envFile,
  };
}
