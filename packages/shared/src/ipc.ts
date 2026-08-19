export const IPC = {
  // renderer -> main
  AgentPrompt: 'agent:prompt',
  AgentInterrupt: 'agent:interrupt',
  PermissionResolve: 'permission:resolve',
  PtyWrite: 'pty:write',
  PtyResize: 'pty:resize',
  SessionNew: 'session:new',
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
