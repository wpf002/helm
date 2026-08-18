/**
 * Everything the renderer can be handed for display. One discriminated union so
 * the transcript component is a single exhaustive switch and new event kinds
 * fail the typecheck instead of silently rendering nothing.
 */
export type StreamEvent =
  | { kind: 'text'; sessionId: string; text: string }
  | { kind: 'thinking'; sessionId: string; text: string }
  | { kind: 'tool_start'; sessionId: string; toolId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; sessionId: string; toolId: string; ok: boolean; output: string }
  | { kind: 'shell_echo'; sessionId: string; command: string; cwd: string }
  | { kind: 'error'; sessionId: string; message: string }
  | { kind: 'turn_end'; sessionId: string; usage?: TokenUsage };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type InputRoute =
  | { target: 'shell'; command: string }
  | { target: 'agent'; prompt: string };
