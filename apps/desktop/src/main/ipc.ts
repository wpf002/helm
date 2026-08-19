// Registers every IPC.* channel. One file so the full surface is auditable in
// a single read. Each handler validates its payload before acting.

import { ipcMain, type BrowserWindow } from 'electron';
import { spawnPty, type PtySession } from '@helm/shell';
import { createSession, type AgentSession } from '@helm/engine';
import { IPC, type SessionCreateOptions, type SessionInfo } from '@helm/shared';
import type { HelmEnv } from './env.js';
import { clearPermissionState, requestPermission, resolvePermission } from './permissions.js';

/**
 * Phase 1 runs exactly one persistent shell. The map is keyed by session id
 * anyway so Phase 5's multi-session work does not have to unpick this.
 */
const sessions = new Map<string, PtySession>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readSize(value: unknown): { cols: number; rows: number } {
  const cols = isRecord(value) && typeof value['cols'] === 'number' ? value['cols'] : 80;
  const rows = isRecord(value) && typeof value['rows'] === 'number' ? value['rows'] : 24;
  return {
    cols: Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 80,
    rows: Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24,
  };
}

/** node-pty wants a plain string map; process.env is sparse. */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  // Advertise ourselves so shell profiles can special-case Helm if wanted.
  out['TERM'] = 'xterm-256color';
  out['TERM_PROGRAM'] = 'Helm';
  out['COLORTERM'] = 'truecolor';

  // macOS does not put LANG in the environment of a GUI-launched app, and an
  // unset LANG drops the shell into the C locale. Output still passes through,
  // but zsh's line editor then renders typed multi-byte characters as raw
  // bytes — accented filenames, emoji and box-drawing TUIs all break. A
  // terminal launched from the Dock must not behave differently from one
  // launched from a shell, so fill it in when the launcher did not.
  if (!out['LANG'] && !out['LC_ALL'] && !out['LC_CTYPE']) {
    out['LANG'] = `${systemLocale()}.UTF-8`;
  }
  return out;
}

/** Best-effort POSIX locale name (`en_US`) from the runtime's own locale. */
function systemLocale(): string {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    const [language, region] = tag.split('-');
    if (language && region && /^[a-z]{2,3}$/.test(language) && /^[A-Z]{2}$/.test(region)) {
      return `${language}_${region}`;
    }
  } catch {
    // Fall through to the default.
  }
  return 'en_US';
}

/**
 * The agent session, created lazily and never awaited on the startup path. The
 * terminal must be usable the instant the window appears; if the agent is slow
 * or fails outright, Helm degrades to a plain terminal rather than blocking.
 */
let agent: AgentSession | null = null;
let agentStarting: Promise<AgentSession | null> | null = null;
/** Tool name by request id, so a session-scoped grant knows what it granted. */
const requestTools = new Map<string, string>();

export function killAllSessions(): void {
  for (const session of sessions.values()) session.kill();
  sessions.clear();
}

export async function disposeAgent(): Promise<void> {
  clearPermissionState();
  requestTools.clear();
  const current = agent;
  agent = null;
  agentStarting = null;
  if (current) await current.dispose();
}

export function registerIpc(win: BrowserWindow, env: HelmEnv): void {
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  ipcMain.handle(IPC.SessionNew, (_event, raw: unknown): SessionInfo => {
    // A respawn is just a new session; drop any previous one so a dead shell
    // does not leak a pty. Session-scoped permission grants die with it —
    // a remembered "allow" must not outlive the session that granted it.
    killAllSessions();
    clearPermissionState();

    const { cols, rows } = readSize(raw as SessionCreateOptions);
    const session = spawnPty(
      { shell: env.shell, cwd: env.homeRoot, env: cleanEnv(), cols, rows },
      {
        onData: (sessionId, data) => send(IPC.PtyData, { sessionId, data }),
        onExit: (sessionId, code) => {
          sessions.delete(sessionId);
          send(IPC.PtyExit, { sessionId, code });
        },
      },
    );

    sessions.set(session.id, session);
    return { id: session.id, shell: env.shell, cwd: session.cwd(), permissionMode: env.permissionMode };
  });

  ipcMain.on(IPC.PtyWrite, (_event, raw: unknown) => {
    if (!isRecord(raw)) return;
    const { sessionId, data } = raw;
    if (typeof sessionId !== 'string' || typeof data !== 'string') return;
    sessions.get(sessionId)?.write(data);
  });

  ipcMain.on(IPC.PtyResize, (_event, raw: unknown) => {
    if (!isRecord(raw)) return;
    const { sessionId } = raw;
    if (typeof sessionId !== 'string') return;
    const { cols, rows } = readSize(raw);
    sessions.get(sessionId)?.resize(cols, rows);
  });

  ipcMain.handle(IPC.SessionList, (): SessionInfo[] =>
    [...sessions.values()].map((s) => ({
      id: s.id,
      shell: env.shell,
      cwd: s.cwd(),
      permissionMode: env.permissionMode,
    })),
  );

  /** Creates the agent on first use. Cheap: the SDK subprocess spawns lazily. */
  const ensureAgent = async (): Promise<AgentSession | null> => {
    if (agent) return agent;
    if (agentStarting) return agentStarting;

    agentStarting = createSession(
      {
        homeRoot: env.homeRoot,
        extraRoots: env.extraRoots,
        permissionMode: env.permissionMode,
        ...(env.model ? { model: env.model } : {}),
      },
      {
        onEvent: (event) => send(IPC.AgentStream, event),
        requestPermission: async (request) => {
          requestTools.set(request.id, request.toolName);
          const decision = await requestPermission(win, request);
          requestTools.delete(request.id);
          return decision;
        },
      },
    )
      .then((created) => {
        agent = created;
        return created;
      })
      .catch((error: unknown) => {
        // A dead agent must not take the terminal with it.
        const message = error instanceof Error ? error.message : String(error);
        send(IPC.AgentStream, { kind: 'error', sessionId: '', message });
        agentStarting = null;
        return null;
      });

    return agentStarting;
  };

  ipcMain.on(IPC.AgentPrompt, (_event, raw: unknown) => {
    if (typeof raw !== 'string' || raw.length === 0) return;
    void (async () => {
      const session = await ensureAgent();
      if (!session) return;
      try {
        await session.prompt(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(IPC.AgentStream, { kind: 'error', sessionId: session.id, message });
        send(IPC.AgentStream, { kind: 'turn_end', sessionId: session.id });
      }
    })();
  });

  ipcMain.on(IPC.AgentInterrupt, () => {
    void agent?.interrupt();
  });

  ipcMain.on(IPC.PermissionResolve, (_event, raw: unknown) => {
    if (!isRecord(raw)) return;
    const { id, behavior, persist } = raw;
    if (typeof id !== 'string') return;
    if (behavior !== 'allow' && behavior !== 'deny') return;
    resolvePermission(
      {
        id,
        behavior,
        persist: persist === true,
        ...(typeof raw['reason'] === 'string' ? { reason: raw['reason'] } : {}),
      },
      requestTools.get(id),
    );
  });
}
