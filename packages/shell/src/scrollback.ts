// What the terminal has actually shown, kept as plain text so the agent can be
// asked about it.
//
// Helm's whole premise is one buffer, but the agent could only see the half it
// wrote itself — "why did that fail?" was unanswerable about the failure three
// lines up. This keeps a bounded, per-session tail of the shell's output. It is
// never injected into a prompt: the agent asks for it through a tool, so a
// session that never asks pays nothing for it.

/** Roughly a screen and a half of history per session. Enough to answer a
 *  question about what just happened; small enough never to be a leak. */
const MAX_LINES = 300;
/** One command can emit an enormous single line. Cut it rather than store it. */
const MAX_LINE = 2000;
/** Longest escape sequence worth waiting for the rest of. Helm's own OSC 7376
 *  carries the shell's whole vocabulary and runs to tens of kilobytes. */
const MAX_PENDING_ESCAPE = 65_536;

/* Matching control characters is the entire job of this file: it exists to
   take them out of pty output before a model ever sees them. */
/* eslint-disable no-control-regex */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** A short (non-OSC) escape sequence, complete, anchored at the start. */
const COMPLETE_SHORT_ESCAPE = new RegExp(
  '^\\u001b(?:\\[[0-9;?]*[ -/]*[@-~]|[()][A-Za-z0-9]|[=>])',
);

/**
 * Escape sequences a pty emits constantly: colours, cursor moves, OSC titles
 * and Helm's own private OSC reports. All of it is invisible on screen and
 * would be noise — or a false clue — in a model's context.
 */
const ANSI = new RegExp(
  [
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)', // OSC ... BEL or ST
    '\\u001b\\[[0-9;?]*[ -/]*[@-~]', // CSI
    '\\u001b[()][A-Za-z0-9]', // charset selection
    '\\u001b[=>]', // keypad mode
    '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', // stray control bytes
  ].join('|'),
  'g',
);

interface Buffer {
  lines: string[];
  /** The line still being written, before its newline arrives. */
  partial: string;
  /**
   * A trailing escape sequence whose terminator has not arrived yet. A pty
   * splits its output on buffer boundaries, not on sequence boundaries, so
   * cleaning each chunk in isolation left half-sequences behind — which is how
   * a base64 OSC payload ended up quoted back to the model as terminal output.
   */
  escape: string;
}

const buffers = new Map<string, Buffer>();

/**
 * Splits text at the start of an unterminated trailing escape sequence, so the
 * remainder can wait for the rest of itself.
 */
function splitPendingEscape(text: string): [ready: string, pending: string] {
  const start = text.lastIndexOf(ESC);
  if (start === -1) return [text, ''];

  const tail = text.slice(start);
  if (tail.length > MAX_PENDING_ESCAPE) return [text, ''];

  const kind = tail[1];
  // OSC runs until BEL or ST. Everything else terminates within a few bytes,
  // so a complete one matches from the very start of the tail.
  const terminated =
    kind === ']'
      ? tail.includes(BEL, 1) || tail.includes(`${ESC}\\`, 1)
      : COMPLETE_SHORT_ESCAPE.test(tail);
  return terminated ? [text, ''] : [text.slice(0, start), tail];
}

/** Strips escape sequences from pty output. Exported so a captured command's
 *  output can be cleaned the same way the scrollback is. */
export function stripAnsi(data: string): string {
  return data.replace(/\r\n/g, '\n').replace(ANSI, '').replace(/\r/g, '\n');
}

/** Feeds raw pty output in. Called for every chunk, so it stays cheap. */
export function recordScrollback(sessionId: string, data: string): void {
  let buffer = buffers.get(sessionId);
  if (!buffer) {
    buffer = { lines: [], partial: '', escape: '' };
    buffers.set(sessionId, buffer);
  }

  const [ready, pending] = splitPendingEscape(buffer.escape + data);
  buffer.escape = pending;
  if (!ready) return;

  const text = buffer.partial + stripAnsi(ready);
  const parts = text.split('\n');
  buffer.partial = (parts.pop() ?? '').slice(0, MAX_LINE);
  for (const part of parts) buffer.lines.push(part.slice(0, MAX_LINE));
  if (buffer.lines.length > MAX_LINES) buffer.lines.splice(0, buffer.lines.length - MAX_LINES);
}

/** Returns the last `lines` lines of a session, oldest first. */
export function readScrollback(sessionId: string | null, lines: number): string {
  const buffer = sessionId ? buffers.get(sessionId) : undefined;
  if (!buffer) return '';
  const wanted = Math.max(1, Math.min(MAX_LINES, lines));
  const all = buffer.partial ? [...buffer.lines, buffer.partial] : buffer.lines;
  return all
    .slice(-wanted)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function dropScrollback(sessionId: string): void {
  buffers.delete(sessionId);
}
