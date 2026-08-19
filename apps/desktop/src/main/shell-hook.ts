// Installing the zsh integration.
//
// Without it Helm silently degrades: the line-editor widget never announces
// itself, so plain English is not routed to the agent and you are back to the
// `?` prefix without being told why. Making the user find and paste a source
// line by hand is the difference between a feature that works and a feature
// nobody switches on.

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import type { ShellHookStatus } from '@helm/shared';

const MARKER = '# helm shell integration';

/** The hook ships inside the bundle; in development it sits in the repo. */
export function hookPath(): string {
  const packaged = join(process.resourcesPath ?? '', 'helm-osc7.zsh');
  if (existsSync(packaged)) return packaged;
  const repo = join(app.getAppPath(), '..', '..', 'scripts', 'helm-osc7.zsh');
  return repo;
}

function rcPath(): string {
  return join(homedir(), '.zshrc');
}

export function hookStatus(): ShellHookStatus {
  const rc = rcPath();
  let installed = false;
  try {
    installed = existsSync(rc) && readFileSync(rc, 'utf8').includes(MARKER);
  } catch {
    installed = false;
  }
  return { installed, hookPath: hookPath(), rcPath: rc };
}

/**
 * Appends the source line. Deliberately additive — it never rewrites or
 * reorders an existing .zshrc, and it is a no-op if the marker is present.
 */
export function installHook(): ShellHookStatus {
  const status = hookStatus();
  if (status.installed) return status;
  try {
    appendFileSync(
      status.rcPath,
      `\n${MARKER}\n[ -f "${status.hookPath}" ] && source "${status.hookPath}"\n`,
      'utf8',
    );
  } catch {
    return hookStatus();
  }
  return hookStatus();
}
