// contextBridge surface. This is the entire renderer capability set. If it
// isn't exposed here the renderer cannot do it.
//
// Built to CommonJS on purpose: Electron cannot load an ESM preload when
// sandbox is enabled, and sandbox stays on. See electron.vite.config.ts.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type PtyDataEvent,
  type PtyExitEvent,
  type SessionCreateOptions,
  type SessionInfo,
} from '@helm/shared';

/** Every listener hands back its own unsubscribe so React effects stay clean. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  pty: {
    /** Creates a session, replacing any existing one. Also used for respawn. */
    create: (options: SessionCreateOptions): Promise<SessionInfo> =>
      ipcRenderer.invoke(IPC.SessionNew, options),

    list: (): Promise<SessionInfo[]> => ipcRenderer.invoke(IPC.SessionList),

    write: (sessionId: string, data: string): void => {
      ipcRenderer.send(IPC.PtyWrite, { sessionId, data });
    },

    resize: (sessionId: string, cols: number, rows: number): void => {
      ipcRenderer.send(IPC.PtyResize, { sessionId, cols, rows });
    },

    onData: (handler: (payload: PtyDataEvent) => void): (() => void) =>
      subscribe(IPC.PtyData, handler),

    onExit: (handler: (payload: PtyExitEvent) => void): (() => void) =>
      subscribe(IPC.PtyExit, handler),
  },

  /** UI-only command from the application menu. Carries no capability. */
  onClear: (handler: () => void): (() => void) => subscribe('helm:clear', handler),
};

export type HelmApi = typeof api;

contextBridge.exposeInMainWorld('helm', api);
