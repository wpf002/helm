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

/**
 * Main-process only. node-pty is a native module and must be rebuilt against
 * Electron's ABI — `electron-builder install-app-deps` in postinstall handles
 * this. If you see NODE_MODULE_VERSION errors, that step didn't run.
 */
export declare function spawnPty(config: PtyConfig, callbacks: PtyCallbacks): PtySession;
