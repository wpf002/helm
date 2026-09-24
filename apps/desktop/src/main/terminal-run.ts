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

interface Pending {
  chunks: string[];
  resolve: (result: TerminalRunResult) => void;
  timer: NodeJS.Timeout;
}

/** At most one command in flight per session: a shell runs one thing at a time. */
const pending = new Map<string, Pending>();

function finish(sessionId: string, exitCode: number | null, timedOut: boolean): void {
  const run = pending.get(sessionId);
  if (!run) return;
  pending.delete(sessionId);
  clearTimeout(run.timer);

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

  run.resolve({
    exitCode,
    output: text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '\n…output truncated' : text,
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

  return new Promise<TerminalRunResult>((resolve) => {
    const timer = setTimeout(() => finish(sessionId, null, true), timeoutMs);
    pending.set(sessionId, { chunks: [], resolve, timer });
    // A newline, not the Enter key: the zsh widget binds ^M and would hand the
    // line back to Helm for routing instead of running it. ^J stays bound to
    // accept-line, which is why shell-routed lines are submitted this way too.
    write(command.replace(/\n+$/, '') + '\n');
  });
}

export function cancelRun(sessionId: string): void {
  if (pending.has(sessionId)) finish(sessionId, null, true);
}
