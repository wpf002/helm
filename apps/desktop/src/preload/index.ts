// contextBridge surface. This is the entire renderer capability set. If it
// isn't exposed here the renderer cannot do it.
//
// Built to CommonJS on purpose: Electron cannot load an ESM preload when
// sandbox is enabled, and sandbox stays on. See electron.vite.config.ts.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type PermissionDecision,
  type PermissionRequest,
  type PtyDataEvent,
  type PtyExitEvent,
  type SessionCreateOptions,
  type SessionInfo,
  type StreamEvent,
  type InputRoute,
  type TranscriptEntry,
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

  agent: {
    /** Fire-and-forget: the reply arrives as StreamEvents on onStream. */
    prompt: (text: string): void => {
      ipcRenderer.send(IPC.AgentPrompt, text);
    },

    /** Ctrl+C during an agent turn stops the turn, not the shell. */
    interrupt: (): void => {
      ipcRenderer.send(IPC.AgentInterrupt);
    },

    onStream: (handler: (event: StreamEvent) => void): (() => void) =>
      subscribe(IPC.AgentStream, handler),

    onPermissionRequest: (handler: (request: PermissionRequest) => void): (() => void) =>
      subscribe(IPC.PermissionRequest, handler),

    resolvePermission: (decision: PermissionDecision): void => {
      ipcRenderer.send(IPC.PermissionResolve, decision);
    },
  },

  session: {
    close: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.SessionClose, id),
    /** Marks which session agent output and transcripts belong to. */
    activate: (id: string): void => {
      ipcRenderer.send(IPC.SessionActivate, id);
    },
    transcripts: (): Promise<Array<{ id: string; mtime: number; bytes: number }>> =>
      ipcRenderer.invoke(IPC.SessionTranscript),
    transcript: (id: string): Promise<TranscriptEntry[]> =>
      ipcRenderer.invoke(IPC.SessionTranscript, id),
    onNew: (handler: () => void): (() => void) => subscribe('helm:session-new', handler),
    onClose: (handler: () => void): (() => void) => subscribe('helm:session-close', handler),
    onResume: (handler: () => void): (() => void) => subscribe('helm:session-resume', handler),
  },

  route: {
    /**
     * Words the shell itself can run — builtins, reserved words, functions and
     * aliases. PATH scanning cannot see any of them.
     */
    vocabulary: (words: string[]): void => {
      ipcRenderer.send(IPC.RouteVocabulary, words);
    },

    /** Routes a submitted line. Returns where it should go. */
    submit: (line: string): Promise<InputRoute> => ipcRenderer.invoke(IPC.InputSubmit, line),

    /**
     * Reports what the user ran and where it went, so routeInput()'s verdict
     * can be logged against reality. Observation only — it changes nothing.
     */
    observe: (input: string, target: 'shell' | 'agent'): void => {
      ipcRenderer.send(IPC.RouteObserve, { input, target });
    },
  },

  /** UI-only command from the application menu. Carries no capability. */
  onClear: (handler: () => void): (() => void) => subscribe('helm:clear', handler),
};

export type HelmApi = typeof api;

contextBridge.exposeInMainWorld('helm', api);
