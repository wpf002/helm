// Update checking.
//
// Helm is built and installed from source rather than shipped through a
// release channel, so this reports whether the repository has moved past the
// build you are running and leaves the decision to you. It never downloads or
// installs anything.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';

const run = promisify(execFile);

export interface UpdateStatus {
  checked: boolean;
  behind: number;
  current: string;
  message: string;
}

/** Only meaningful in a checkout; a packaged app has no repository beside it. */
async function repoRoot(): Promise<string | undefined> {
  const candidate = app.isPackaged ? undefined : app.getAppPath();
  if (!candidate) return undefined;
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: candidate });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  const cwd = await repoRoot();
  if (!cwd) {
    return { checked: false, behind: 0, current: app.getVersion(), message: 'Not a checkout; nothing to compare.' };
  }
  try {
    await run('git', ['fetch', '--quiet', 'origin'], { cwd, timeout: 15_000 });
    const { stdout: head } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    const { stdout: counts } = await run('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd });
    const behind = Number.parseInt(counts.trim(), 10) || 0;
    return {
      checked: true,
      behind,
      current: head.trim(),
      message: behind > 0
        ? `${behind} commit${behind === 1 ? '' : 's'} behind origin/main — run ./scripts/install.sh to update.`
        : 'Up to date with origin/main.',
    };
  } catch (error) {
    return {
      checked: false,
      behind: 0,
      current: app.getVersion(),
      message: `Update check failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
}
