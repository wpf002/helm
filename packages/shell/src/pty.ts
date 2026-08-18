import { randomUUID } from 'node:crypto';
import { spawn as spawnNodePty, type IPty } from 'node-pty';

export interface PtyConfig {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtySession {
  readonly id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Current working directory, tracked via OSC 7 if the shell emits it. */
  cwd(): string;
  kill(): void;
}

export interface PtyCallbacks {
  onData(sessionId: string, data: string): void;
  onExit(sessionId: string, code: number): void;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/**
 * OSC 7 carries the shell's cwd as `ESC ] 7 ; file://<host><path> BEL`, or
 * ST-terminated (`ESC \`). The host segment is optional and the path is
 * percent-encoded. Built from char codes so no raw control bytes sit in source.
 */
const OSC7 = new RegExp(
  `${ESC}\\]7;file://([^/]*)([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`,
  'g',
);

/** Cap on retained partial-escape bytes so a hostile stream cannot grow this. */
const MAX_RESIDUAL = 4096;

/**
 * Main-process only. node-pty is native but N-API (node-addon-api ^7), so the
 * prebuilt binary loads under both Node and Electron with no rebuild. Its
 * `spawn-helper` does need its executable bit restored after install —
 * scripts/postinstall.mjs handles that. Without it, spawn fails with
 * "posix_spawnp failed." while the module itself loads fine.
 */
export function spawnPty(config: PtyConfig, callbacks: PtyCallbacks): PtySession {
  const id = randomUUID();

  const pty: IPty = spawnNodePty(config.shell, [], {
    name: 'xterm-256color',
    cols: Math.max(1, Math.floor(config.cols)),
    rows: Math.max(1, Math.floor(config.rows)),
    cwd: config.cwd,
    env: config.env,
  });

  let currentCwd = config.cwd;
  let residual = '';
  let dead = false;

  /**
   * Scans a chunk for OSC 7 without consuming it — the sequence is still
   * forwarded to the renderer verbatim. Sequences can straddle chunk
   * boundaries, so an unterminated trailing escape is carried forward.
   */
  const trackCwd = (chunk: string): void => {
    const buf = residual + chunk;
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    OSC7.lastIndex = 0;

    while ((match = OSC7.exec(buf)) !== null) {
      const encoded = match[2];
      if (encoded) {
        try {
          currentCwd = decodeURIComponent(encoded);
        } catch {
          // A malformed percent-escape should not discard the update entirely.
          currentCwd = encoded;
        }
      }
      lastEnd = OSC7.lastIndex;
    }

    const tail = buf.slice(lastEnd);
    const esc = tail.lastIndexOf(ESC);
    residual = esc === -1 ? '' : tail.slice(esc).slice(0, MAX_RESIDUAL);
  };

  pty.onData((data) => {
    trackCwd(data);
    callbacks.onData(id, data);
  });

  pty.onExit(({ exitCode }) => {
    dead = true;
    callbacks.onExit(id, exitCode);
  });

  return {
    id,
    write(data) {
      if (!dead) pty.write(data);
    },
    resize(cols, rows) {
      if (dead) return;
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
      try {
        pty.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
      } catch {
        // The pty can die between the liveness check and the resize call.
      }
    },
    cwd() {
      return currentCwd;
    },
    kill() {
      if (dead) return;
      try {
        pty.kill();
      } catch {
        // Already gone.
      }
    },
  };
}
