import type { PermissionDecision, PermissionRequest, StreamEvent } from '@helm/shared';

export interface EngineConfig {
  /** cwd the agent is launched in. Everything else must be an explicit root. */
  homeRoot: string;
  extraRoots: string[];
  permissionMode: 'off' | 'prompt' | 'auto';
  /** Path to a separately installed claude binary. Undefined = bundled. */
  pathToClaudeCodeExecutable?: string;
}

export interface EngineCallbacks {
  onEvent(event: StreamEvent): void;
  /** Resolves when the renderer's approval UI answers. */
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
}

export interface AgentSession {
  readonly id: string;
  prompt(text: string): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Wraps the Agent SDK's query() loop. Owns no Electron imports — this package
 * must stay runnable from a plain node script so the Phase 0 auth probe and any
 * later headless use don't drag the desktop app in.
 */
export declare function createSession(
  config: EngineConfig,
  callbacks: EngineCallbacks,
): Promise<AgentSession>;
