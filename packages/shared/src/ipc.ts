import type { StreamEvent } from './messages.js';

export const IPC = {
  // renderer -> main
  AgentPrompt: 'agent:prompt',
  AgentInterrupt: 'agent:interrupt',
  PermissionResolve: 'permission:resolve',
  PtyWrite: 'pty:write',
  PtyResize: 'pty:resize',
  InputSubmit: 'input:submit',
  RouteObserve: 'route:observe',
  RouteVocabulary: 'route:vocabulary',
  ConfigGet: 'config:get',
  ConfigSet: 'config:set',
  UsageGet: 'usage:get',
  UsageChanged: 'usage:changed',
  ShellHookStatus: 'shell:hook-status',
  ShellHookInstall: 'shell:hook-install',
  UpdateStatus: 'update:status',
  SessionNew: 'session:new',
  SessionClose: 'session:close',
  SessionActivate: 'session:activate',
  SessionTranscript: 'session:transcript',
  SessionList: 'session:list',

  // main -> renderer
  AgentStream: 'agent:stream',
  PermissionRequest: 'permission:request',
  PtyData: 'pty:data',
  PtyExit: 'pty:exit',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface PermissionRequest {
  id: string;
  toolName: string;
  input: unknown;
  /** Absolute paths the call would touch, resolved before the prompt renders. */
  affectedPaths: string[];
  /** True when any affected path falls outside the configured roots. */
  outOfScope: boolean;
  /** Which rules fired to reach that verdict, and why. */
  factors: Factor[];
  /** The roots the paths were checked against, for display. */
  roots: string[];
}

export interface PermissionDecision {
  id: string;
  behavior: 'allow' | 'deny';
  /** Remember for the rest of this session. */
  persist: boolean;
  reason?: string;
}

export interface PtyResize {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface PtyWrite {
  sessionId: string;
  data: string;
}

export interface PtyDataEvent {
  sessionId: string;
  data: string;
}

export interface PtyExitEvent {
  sessionId: string;
  code: number;
}

export interface SessionCreateOptions {
  cols: number;
  rows: number;
}

/** One persisted transcript entry. Replayed through the same render path. */
export type TranscriptEntry =
  | { t: 'pty'; d: string }
  | { t: 'agent'; e: StreamEvent };

/** Cumulative token spend for the current day. Estimates, not billing. */
export interface UsageTotals {
  day: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface HelmConfig {
  /**
   * 'prompt' asks for anything out of scope. 'auto' runs in-scope and
   * read-only calls silently and only stops for out-of-scope writes. 'off'
   * asks for nothing at all.
   */
  permissionMode: 'off' | 'prompt' | 'auto';
  fontSize: number;
  copyOnSelect: boolean;
  middleClickPaste: boolean;
  notifyWhenHidden: boolean;
  checkForUpdates: boolean;
  scrollback: number;
}

/** Whether the zsh integration is installed, and where it would go. */
export interface ShellHookStatus {
  installed: boolean;
  hookPath: string;
  rcPath: string;
}

export interface SessionInfo {
  id: string;
  shell: string;
  cwd: string;
  /** Surfaced so the title bar can show when approvals are switched off. */
  permissionMode: 'off' | 'prompt' | 'auto';
}

/**
 * Why a derived decision came out the way it did. Every routing and scope
 * decision carries these so the reasoning can be read back without re-running
 * the check — no LLM is involved in producing them.
 */
export interface Factor {
  /** Stable identifier of the rule that fired. */
  rule: string;
  /** What the rule saw, in human terms. */
  detail: string;
  /** What the rule contributed to the outcome. */
  effect: 'in-scope' | 'out-of-scope' | 'info';
}

/** Result of the deterministic scope check for one tool call. */
export interface ScopeVerdict {
  /** Absolute, symlink-resolved paths the call would touch. */
  paths: string[];
  /** True when any resolved path falls outside the configured roots. */
  outOfScope: boolean;
  factors: Factor[];
}
