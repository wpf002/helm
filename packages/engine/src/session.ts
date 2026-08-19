import { randomUUID } from 'node:crypto';
import type {
  HookJSONOutput,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionDecision, PermissionRequest, StreamEvent, TokenUsage } from '@helm/shared';
import { evaluateScope } from './scope.js';

export interface EngineConfig {
  /** cwd the agent is launched in. Everything else must be an explicit root. */
  homeRoot: string;
  extraRoots: string[];
  permissionMode: 'off' | 'prompt' | 'auto';
  /** Path to a separately installed claude binary. Undefined = bundled. */
  pathToClaudeCodeExecutable?: string;
  /** Defaults to Sonnet. Opus with a 1M context costs ~$0.16 per trivial turn. */
  model?: string;
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
 * Phase 0 measured a trivial turn at $0.164, of which $0.163 was 26k tokens of
 * system prompt against a 1M-context Opus. Sonnet is the default, dynamic
 * sections are dropped, settings files are not loaded, and the tool set is
 * limited to what a terminal agent actually needs — every unused tool still
 * ships its JSON schema on every turn.
 */
const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * Trimmed via disallowedTools, never allowedTools. A bare name in allowedTools
 * auto-approves that tool *before* canUseTool is consulted, which would silently
 * disable the permission layer — the SDK warns about this and it is exactly the
 * failure Phase 4 is built to prevent. Everything not listed here falls through
 * to canUseTool.
 */
const DISALLOWED_TOOLS = [
  'Task',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
  'ExitPlanMode',
  'SlashCommand',
];

const SYSTEM_APPEND =
  'You are running inside Helm, a terminal. Output is rendered as plain text in ' +
  'a scrollback buffer shared with the user\'s shell. Keep replies short and ' +
  'concrete. Do not use markdown headings or tables.';

/**
 * Hands prompts to the SDK's streaming-input mode. Streaming input is what makes
 * interrupt() and multi-turn conversation possible; single-prompt mode exits the
 * process after one turn.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffered: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    const message = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    } as unknown as SDKUserMessage;

    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: message, done: false });
    } else {
      this.buffered.push(message);
    }
  }

  close(): void {
    this.closed = true;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.buffered.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiting = resolve;
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** One line per tool call. The raw JSON belongs in the permission prompt, not the buffer. */
function summariseTool(toolName: string, input: unknown): string {
  if (!isRecord(input)) return toolName;
  const pick = (key: string): string | undefined =>
    typeof input[key] === 'string' ? (input[key] as string) : undefined;

  switch (toolName) {
    case 'Bash':
      return `Bash ${pick('command') ?? ''}`.trim();
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${toolName} ${pick('file_path') ?? ''}`.trim();
    case 'Glob':
    case 'Grep':
      return `${toolName} ${pick('pattern') ?? ''}`.trim();
    default: {
      const keys = Object.keys(input).slice(0, 3).join(', ');
      return keys ? `${toolName} (${keys})` : toolName;
    }
  }
}

function readUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const num = (key: string): number => (typeof raw[key] === 'number' ? (raw[key] as number) : 0);
  return {
    input: num('input_tokens'),
    output: num('output_tokens'),
    cacheRead: num('cache_read_input_tokens'),
    cacheWrite: num('cache_creation_input_tokens'),
  };
}

/**
 * Wraps the Agent SDK's query() loop. Owns no Electron imports — this package
 * must stay runnable from a plain node script so the Phase 0 auth probe and any
 * later headless use don't drag the desktop app in.
 *
 * Creating a session is deliberately cheap: it allocates an id and returns. The
 * SDK subprocess is not spawned until the first prompt, so the terminal is never
 * waiting on the agent to come up. See the always-available constraint.
 */
export async function createSession(
  config: EngineConfig,
  callbacks: EngineCallbacks,
): Promise<AgentSession> {
  const id = randomUUID();
  const queue = new PromptQueue();

  let active: Query | null = null;
  let pump: Promise<void> | null = null;
  let disposed = false;

  const emit = (event: StreamEvent): void => {
    if (!disposed) callbacks.onEvent(event);
  };

  const roots = [config.homeRoot, ...config.extraRoots];

  /** Deterministic scope check, then the user. No model on this path. */
  const ask = async (toolName: string, input: unknown): Promise<PermissionDecision> => {
    const verdict = await evaluateScope(toolName, input, config.homeRoot, roots);
    return callbacks.requestPermission({
      id: randomUUID(),
      toolName,
      input,
      affectedPaths: verdict.paths,
      outOfScope: verdict.outOfScope,
      factors: verdict.factors,
      roots,
    });
  };

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const decision = await ask(toolName, input);
    return decision.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision.reason ?? 'Denied in Helm.' };
  };

  /**
   * canUseTool alone is not a gate. The SDK auto-approves tools it classifies
   * as safe — a plain `ls` never reaches the callback — so with Full Disk
   * Access granted, reads across the whole machine would bypass Helm entirely.
   * A PreToolUse hook fires for every call regardless of that classification,
   * which is what makes the permission layer actually total.
   */
  const preToolUse = async (hookInput: unknown): Promise<HookJSONOutput> => {
    const record = isRecord(hookInput) ? hookInput : {};
    const toolName = typeof record['tool_name'] === 'string' ? record['tool_name'] : 'unknown';
    const toolInput = record['tool_input'];

    const decision = await ask(toolName, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.behavior === 'allow' ? 'allow' : 'deny',
        permissionDecisionReason: decision.reason ?? 'Decided in Helm.',
      },
    } as HookJSONOutput;
  };

  const options: Options = {
    cwd: config.homeRoot,
    additionalDirectories: config.extraRoots,
    model: config.model ?? DEFAULT_MODEL,
    disallowedTools: DISALLOWED_TOOLS,
    // Dynamic sections carry git status and directory listings that change every
    // turn, which defeats prompt caching as well as costing tokens outright.
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: SYSTEM_APPEND,
      excludeDynamicSections: true,
    },
    // Do not load user/project settings or CLAUDE.md files: Helm's scope is the
    // whole home directory, so those would be picked up unpredictably.
    settingSources: [],
    includePartialMessages: true,
    permissionMode: config.permissionMode === 'off' ? 'bypassPermissions' : 'default',
    ...(config.permissionMode === 'off'
      ? {}
      : {
          canUseTool,
          hooks: {
            PreToolUse: [{ hooks: [preToolUse as never] }],
          },
        }),
    ...(config.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable }
      : {}),
  };

  /** Translates SDK messages into the renderer's StreamEvent union. */
  const consume = async (running: Query): Promise<void> => {
    try {
      for await (const message of running as AsyncIterable<SDKMessage>) {
        if (disposed) return;

        if (message.type === 'stream_event') {
          const event = message.event as unknown;
          if (!isRecord(event) || event['type'] !== 'content_block_delta') continue;
          const delta = event['delta'];
          if (!isRecord(delta)) continue;
          if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            emit({ kind: 'text', sessionId: id, text: delta['text'] });
          } else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
            emit({ kind: 'thinking', sessionId: id, text: delta['thinking'] });
          }
          continue;
        }

        if (message.type === 'assistant') {
          const content = message.message?.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (isRecord(block) && block['type'] === 'tool_use') {
              emit({
                kind: 'tool_start',
                sessionId: id,
                toolId: String(block['id'] ?? ''),
                toolName: summariseTool(String(block['name'] ?? ''), block['input']),
                input: block['input'],
              });
            }
          }
          continue;
        }

        if (message.type === 'user') {
          const content = message.message?.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (isRecord(block) && block['type'] === 'tool_result') {
              const raw = block['content'];
              const text =
                typeof raw === 'string'
                  ? raw
                  : Array.isArray(raw)
                    ? raw
                        .map((part) =>
                          isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '',
                        )
                        .join('')
                    : '';
              emit({
                kind: 'tool_result',
                sessionId: id,
                toolId: String(block['tool_use_id'] ?? ''),
                ok: block['is_error'] !== true,
                output: text,
              });
            }
          }
          continue;
        }

        if (message.type === 'result') {
          const usage = readUsage((message as unknown as Record<string, unknown>)['usage']);
          if (message.subtype !== 'success' || message.is_error) {
            const text =
              'result' in message && typeof message.result === 'string'
                ? message.result
                : `Agent turn ended: ${message.subtype}`;
            emit({ kind: 'error', sessionId: id, message: text });
          }
          emit({ kind: 'turn_end', sessionId: id, ...(usage ? { usage } : {}) });
        }
      }
    } catch (error) {
      if (disposed) return;
      const text = error instanceof Error ? error.message : String(error);
      emit({ kind: 'error', sessionId: id, message: text });
      emit({ kind: 'turn_end', sessionId: id });
      // Drop the query so the next prompt starts a fresh one rather than
      // wedging the session on a dead subprocess.
      active = null;
      pump = null;
    }
  };

  return {
    id,

    async prompt(text: string): Promise<void> {
      if (disposed) return;
      // First prompt pays the subprocess spawn; the terminal never does.
      if (!active) {
        // Dynamic import, not a static one: the SDK is ESM and Electron 32 runs
        // Node 20, where require(esm) throws ERR_REQUIRE_ESM from the CommonJS
        // main bundle. It also keeps the SDK off the startup path entirely —
        // the terminal never pays for loading it.
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        active = query({ prompt: queue, options });
        pump = consume(active);
        void pump;
      }
      queue.push(text);
    },

    async interrupt(): Promise<void> {
      if (!active) return;
      try {
        await active.interrupt();
      } catch {
        // Nothing running, or the subprocess already went away.
      }
    },

    async dispose(): Promise<void> {
      disposed = true;
      queue.close();
      const running = active;
      active = null;
      if (running) {
        try {
          await running.interrupt();
        } catch {
          // Best effort.
        }
      }
      pump = null;
    },
  };
}
