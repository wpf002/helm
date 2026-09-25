// Runs a command in the user's own shell rather than in the agent's subprocess.
//
// The agent's Bash tool has no controlling terminal, so anything that needs one
// fails there: `sudo` cannot read a password, an installer cannot prompt, a
// pager has nothing to page to. Helm already owns a real pty with the user
// sitting in front of it, and that pty is a TTY — `tty` reports /dev/ttysNNN
// and `sudo` prompts normally. This routes those commands there.
//
// The password is typed by the user, into their own shell. It is never sent to
// the model, and Helm never sees it: the agent gets the command's output and
// exit status, nothing else.

import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '@helm/shell';

/** A command that never finishes must not hold the tool call open forever. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Enough output to be useful, bounded so a runaway command cannot blow up the
 *  message. The full output is still on screen for the user. */
const MAX_OUTPUT = 20_000;

/** The shell hook's precmd emits this with $? after every command. */
// eslint-disable-next-line no-control-regex
const STATUS_OSC = /\u001b\]7377;(-?\d+)\u0007/;

export interface TerminalRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * What a program waiting for a secret looks like. sudo, ssh, gpg and the rest
 * all print a short line ending in a colon and then block with echo off.
 */
const PROMPT_PATTERNS = [
  /(^|\n)[Pp]assword:\s*$/,
  /(^|\n)[Pp]assword for [^\n]*:\s*$/,
  /[Pp]assphrase[^\n]*:\s*$/,
  /\[sudo\] password for [^\n]*:\s*$/,
  /(^|\n)Verification code:\s*$/,
];

/** A human has to notice the prompt and go and type. Two minutes is the
 *  default for a command; a prompt gets much longer before giving up. */
const PROMPT_TIMEOUT_MS = 600_000;

interface Pending {
  chunks: string[];
  resolve: (result: TerminalRunResult) => void;
  timer: NodeJS.Timeout;
  timeoutMs: number;
  /** Set once the prompt has been announced, so it is announced only once. */
  awaiting: boolean;
}

/** Notified when a command stops to ask the user for something. */
let onAwaitingInput: ((sessionId: string, waiting: boolean) => void) | null = null;

export function setAwaitingInputHandler(
  handler: (sessionId: string, waiting: boolean) => void,
): void {
  onAwaitingInput = handler;
}

/** At most one command in flight per session: a shell runs one thing at a time. */
const pending = new Map<string, Pending>();

function finish(sessionId: string, exitCode: number | null, timedOut: boolean): void {
  const run = pending.get(sessionId);
  if (!run) return;
  pending.delete(sessionId);
  clearTimeout(run.timer);
  // The prompt is answered, or gave up waiting. Either way stop saying so.
  if (run.awaiting) onAwaitingInput?.(sessionId, false);

  const text = stripAnsi(run.chunks.join(''))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    // The shell echoes the command back before running it; that line is the
    // agent's own input and says nothing about the result.
    .slice(1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const body =
    text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '\n…output truncated' : text;
  run.resolve({
    exitCode,
    // A timeout at a prompt is not a hung command; saying so stops the agent
    // guessing, and stops it polling terminal_output every few seconds.
    output:
      timedOut && run.awaiting
        ? `Still waiting at a prompt for the user to type something.\n${body}`
        : body,
    timedOut,
  });
}

/**
 * Feeds pty output to whichever command is in flight. Called for every chunk,
 * so it does nothing at all when no command is pending.
 */
export function observeForRun(sessionId: string, data: string): void {
  const run = pending.get(sessionId);
  if (!run) return;

  run.chunks.push(data);
  const joined = run.chunks.join('');

  // A program that has stopped to ask for a secret looks finished from the
  // outside: no more output, no exit status. Say so, restart the clock, and
  // let the renderer put it where the user cannot miss it.
  if (!run.awaiting) {
    const tail = stripAnsi(joined).replace(/\r/g, '\n').slice(-200);
    if (PROMPT_PATTERNS.some((p) => p.test(tail))) {
      run.awaiting = true;
      clearTimeout(run.timer);
      run.timer = setTimeout(
        () => finish(sessionId, null, true),
        Math.max(run.timeoutMs, PROMPT_TIMEOUT_MS),
      );
      onAwaitingInput?.(sessionId, true);
    }
  }

  const match = STATUS_OSC.exec(joined);
  if (!match) return;

  // Trim at the marker so a later command's output cannot leak into this one.
  run.chunks = [joined.slice(0, match.index)];
  finish(sessionId, Number(match[1]), false);
}

/** True when the shell hook is not installed, so no status will ever arrive. */
export function isRunning(sessionId: string): boolean {
  return pending.has(sessionId);
}

/**
 * Anything with a newline in it goes to a file and runs as one line.
 *
 * Writing a multi-line script into an interactive line editor types it a line
 * at a time, and a heredoc, a `for` loop or a stray `#` comment then arrives in
 * pieces the editor is free to reinterpret. It killed a real shell: a heredoc
 * writing sshd_config produced `zsh: invalid mode specification` and the shell
 * exited, after which nothing else in this file could work. A script file has
 * no such failure mode, and the user still sees exactly one command run.
 */
function asSingleLine(command: string): { line: string; scriptPath?: string } {
  const trimmed = command.replace(/\s+$/, '');
  if (!trimmed.includes('\n')) return { line: trimmed };

  const scriptPath = join(
    tmpdir(),
    `helm-run-${randomUUID().slice(0, 8)}.zsh`,
  );
  writeFileSync(scriptPath, trimmed + '\n', { mode: 0o700 });
  return { line: `zsh ${scriptPath}`, scriptPath };
}

export function runInTerminal(
  sessionId: string,
  write: (data: string) => void,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TerminalRunResult> {
  if (pending.has(sessionId)) {
    return Promise.resolve({
      exitCode: null,
      output: 'Another command is already running in this terminal.',
      timedOut: false,
    });
  }

  let prepared: { line: string; scriptPath?: string };
  try {
    prepared = asSingleLine(command);
  } catch (error) {
    return Promise.resolve({
      exitCode: null,
      output: `Could not stage the command: ${(error as Error).message}`,
      timedOut: false,
    });
  }

  return new Promise<TerminalRunResult>((resolve) => {
    const timer = setTimeout(() => finish(sessionId, null, true), timeoutMs);
    pending.set(sessionId, {
      chunks: [],
      resolve: (result) => {
        if (prepared.scriptPath) rmSync(prepared.scriptPath, { force: true });
        resolve(result);
      },
      timer,
      timeoutMs,
      awaiting: false,
    });
    // A newline, not the Enter key: the zsh widget binds ^M and would hand the
    // line back to Helm for routing instead of running it. ^J stays bound to
    // accept-line, which is why shell-routed lines are submitted this way too.
    write(prepared.line + '\n');
  });
}

export function cancelRun(sessionId: string): void {
  if (pending.has(sessionId)) finish(sessionId, null, true);
}
