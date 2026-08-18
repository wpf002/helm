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
