// Keeps the installed Helm on whatever is on GitHub, using the one clone you
// already have — the one install.sh was last run from.
//
// It runs inside Helm rather than as a background job because macOS will not
// let a launchd job read ~/Documents (tested: "Operation not permitted"), and
// the clone lives there. Helm can, so Helm does it.
//
//   every 5 minutes: fetch -> fast-forward your clone -> test -> build -> stage
//   when you quit Helm: the staged build is copied into /Applications
//
// It never touches work in progress. The clone is only moved when it is on
// main, has no uncommitted changes to tracked files, and can fast-forward; if
// any of that is not true it says why in ~/.helm/update.log and waits. It never
// quits Helm under you. A commit that fails its tests is skipped until a newer
// one arrives.

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app, Notification } from 'electron';

const run = promisify(execFile);

const STATE = join(homedir(), '.helm');
/** Written by install.sh when you run it by hand: the clone it ran from. */
const SOURCE_REPO = join(STATE, 'source-repo');
/** Written alongside it: the PATH that had node and pnpm on it. A Dock-launched
 *  app gets a bare PATH with neither. */
const BUILD_PATH = join(STATE, 'build-path');
const INSTALLED = join(STATE, 'installed-sha');
const FAILED = join(STATE, 'update-failed-sha');
const STAGED_DIR = join(STATE, 'staged');
const STAGED_APP = join(STAGED_DIR, 'Helm.app');
const STAGED_SHA = join(STAGED_DIR, 'sha');
const LOG = join(STATE, 'update.log');
/** A machine that updates through the launchd agent (the Mac Studio, whose
 *  clone is outside ~/Documents) must not have two updaters racing. */
const LAUNCH_AGENT = join(homedir(), 'Library', 'LaunchAgents', 'com.helm.update.plist');

const INTERVAL_MS = 5 * 60_000;
const FIRST_CHECK_MS = 30_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const APP_PATH = '/Applications/Helm.app';

export interface SelfUpdateStatus {
  enabled: boolean;
  repo: string | null;
  installed: string | null;
  staged: string | null;
  lastCheck: string | null;
  message: string;
}

let busy = false;
let lastCheck: string | null = null;
let lastMessage = 'Not checked yet.';
let timer: NodeJS.Timeout | null = null;

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

function log(message: string): void {
  lastMessage = message;
  try {
    mkdirSync(STATE, { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${message}\n`);
  } catch {
    // Logging must never be the thing that breaks updating.
  }
}

function notify(body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title: 'Helm', body }).show();
  } catch {
    // A missing notification is not worth failing over.
  }
}

/** Only the packaged app on a machine set up by hand updates itself. */
function sourceRepo(): string | null {
  if (!app.isPackaged) return null;
  if (existsSync(LAUNCH_AGENT)) return null;
  const repo = read(SOURCE_REPO);
  return repo && existsSync(join(repo, '.git')) ? repo : null;
}

function childEnv(): NodeJS.ProcessEnv {
  const path = read(BUILD_PATH) ?? process.env['PATH'] ?? '/usr/bin:/bin';
  return { ...process.env, PATH: path };
}

const git = async (repo: string, args: string[]): Promise<string> =>
  (await run('git', ['-C', repo, ...args], { env: childEnv(), timeout: 60_000 })).stdout.trim();

/** Runs a shell step in the clone. Resolves to true on exit 0. */
function step(repo: string, command: string, env: NodeJS.ProcessEnv = childEnv()): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-c', command], { cwd: repo, env, stdio: 'ignore' });
    const kill = setTimeout(() => child.kill('SIGKILL'), BUILD_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(kill);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(kill);
      resolve(code === 0);
    });
  });
}

/**
 * Moves your clone to origin/main if, and only if, nothing of yours is in the
 * way. Returns the reason it did not, or null when the clone is at target.
 */
async function syncClone(repo: string, target: string): Promise<string | null> {
  const head = await git(repo, ['rev-parse', 'HEAD']);
  if (head === target) return null;

  const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') return `your clone is on '${branch}', not main`;

  // Untracked files never block a fast-forward unless they collide, and git
  // refuses that case itself. Modified tracked files are your work.
  const dirty = await git(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) return 'your clone has uncommitted changes';

  try {
    await git(repo, ['merge-base', '--is-ancestor', 'HEAD', target]);
  } catch {
    return 'your local main has commits that are not on GitHub';
  }

  await git(repo, ['merge', '--ff-only', '--quiet', target]);
  return null;
}

async function check(): Promise<void> {
  const repo = sourceRepo();
  if (!repo || busy) return;
  busy = true;
  try {
    try {
      await git(repo, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20', 'fetch', '--quiet', 'origin', 'main']);
    } catch {
      log('could not reach GitHub; will try again');
      return;
    }
    lastCheck = new Date().toISOString();

    const target = await git(repo, ['rev-parse', 'origin/main']);
    const short = target.slice(0, 7);
    if (target === read(INSTALLED) || target === read(STAGED_SHA) || target === read(FAILED)) {
      lastMessage = target === read(STAGED_SHA)
        ? `Update ${short} is ready; it installs when you quit Helm.`
        : 'Up to date with GitHub.';
      return;
    }

    const blocked = await syncClone(repo, target);
    if (blocked) {
      log(`not updating to ${short}: ${blocked}`);
      return;
    }

    log(`building ${short}`);
    const ok =
      (await step(repo, 'pnpm install --frozen-lockfile')) &&
      (await step(repo, 'pnpm test')) &&
      (await step(repo, 'pnpm typecheck')) &&
      (await step(repo, './scripts/install.sh', { ...childEnv(), HELM_INSTALL_STEP: 'build' }));
    if (!ok) {
      writeFileSync(FAILED, target);
      log(`${short} failed its tests or build; keeping the installed Helm`);
      notify(`Update ${short} failed its tests. Kept the current Helm.`);
      return;
    }

    // Staged outside ~/Documents, so installing it after Helm quits needs no
    // access to the clone.
    rmSync(STAGED_DIR, { recursive: true, force: true });
    mkdirSync(STAGED_DIR, { recursive: true });
    const built = join(repo, 'apps', 'desktop', 'release', 'mac-arm64', 'Helm.app');
    if (!(await step(repo, `ditto "${built}" "${STAGED_APP}"`))) {
      log(`could not stage ${short}; will rebuild next check`);
      rmSync(STAGED_DIR, { recursive: true, force: true });
      return;
    }
    writeFileSync(STAGED_SHA, target);
    log(`update ${short} ready; installs when you quit Helm`);
    notify('Helm update ready. It installs the next time you quit Helm.');
  } catch (error) {
    log(`update check failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  } finally {
    busy = false;
  }
}

/**
 * Called on quit. Hands the staged build to a detached shell that waits for
 * Helm to finish exiting, then copies it in. Takes a few seconds.
 */
export function installStagedOnQuit(): void {
  const staged = read(STAGED_SHA);
  if (!staged || staged === read(INSTALLED) || !existsSync(STAGED_APP)) return;

  const short = staged.slice(0, 7);
  const script = [
    // The ^ anchor keeps this from matching itself or Helm's helper processes.
    `for _ in $(seq 1 200); do pgrep -qf "^${APP_PATH}/Contents/MacOS/Helm( |$)" || break; sleep 0.3; done`,
    `pgrep -qf "^${APP_PATH}/Contents/MacOS/Helm( |$)" && exit 0`,
    `codesign --verify --strict "${STAGED_APP}" >/dev/null 2>&1 || { echo "$(date '+%F %T') staged ${short} failed verification; kept the installed Helm" >> "${LOG}"; exit 0; }`,
    `rm -rf "${APP_PATH}" && ditto "${STAGED_APP}" "${APP_PATH}" || exit 0`,
    `xattr -dr com.apple.quarantine "${APP_PATH}" 2>/dev/null`,
    `echo ${staged} > "${INSTALLED}"`,
    `rm -rf "${STAGED_DIR}"`,
    `echo "$(date '+%F %T') installed ${short}" >> "${LOG}"`,
    `osascript -e 'display notification "Helm is updated. Open it again to use it." with title "Helm"' >/dev/null 2>&1`,
  ].join('\n');

  try {
    spawn('/bin/zsh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // It stays staged; the next quit tries again.
  }
}

export function startSelfUpdate(): void {
  if (!sourceRepo() || timer) return;
  setTimeout(() => void check(), FIRST_CHECK_MS);
  timer = setInterval(() => void check(), INTERVAL_MS);
}

export function stopSelfUpdate(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** For Preferences: what the updater is doing, in one line. */
export function selfUpdateStatus(): SelfUpdateStatus {
  const repo = sourceRepo();
  return {
    enabled: repo !== null,
    repo,
    installed: read(INSTALLED),
    staged: read(STAGED_SHA),
    lastCheck,
    message: repo
      ? lastMessage
      : existsSync(LAUNCH_AGENT)
        ? 'Updated by the com.helm.update background job on this Mac.'
        : 'Run ./scripts/install.sh once from your clone to turn on automatic updates.',
  };
}

/** Runs a check now, for the Preferences button. */
export async function checkNow(): Promise<SelfUpdateStatus> {
  await check();
  return selfUpdateStatus();
}
