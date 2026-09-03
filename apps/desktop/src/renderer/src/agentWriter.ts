import type { Terminal } from '@xterm/xterm';
import type { StreamEvent } from '@helm/shared';

const ESC = String.fromCharCode(0x1b);
const sgr = (code: string): string => `${ESC}[${code}m`;

const RESET = sgr('0');
/** The gutter is the only thing distinguishing the streams. Not layout. */
const GUTTER_CHAR = '│ ';
const GUTTER = sgr('38;5;68') + GUTTER_CHAR + RESET;
const GUTTER_WIDTH = 2;
const AGENT_TEXT = sgr('38;5;152');
const THINKING = sgr('38;5;242') + sgr('3');
const TOOL = sgr('38;5;108');
const TOOL_ARG = sgr('38;5;66');
const TOOL_FAIL = sgr('38;5;174');
const ERROR = sgr('38;5;203');
const META = sgr('38;5;242');
const BOLD = sgr('1');
const CODE = sgr('38;5;180');
const BULLET = sgr('38;5;68');

/** Longest a tool's argument may run before it is cut. Four lines of a shell
 *  script is enough to recognise it; the rest is noise you did not ask for. */
const MAX_ARG_LINES = 4;

/**
 * Renders the small amount of markdown a terminal can honestly show. The agent
 * writes **bold** labels and `code`, and leaving those as literal asterisks is
 * the difference between a readout you can skim and one you have to decode.
 *
 * Deliberately narrow: bold, inline code, bullets and numbered items. Headings,
 * tables and nested lists have no good rendering in a fixed-width buffer, so
 * the system prompt asks for prose instead of pretending otherwise.
 */
function renderMarkdown(line: string, base: string): string {
  let out = line;

  // Bullets first, while the marker is still at the start of the line.
  const bullet = /^(\s*)[-*]\s+/.exec(out);
  if (bullet) {
    out = `${bullet[1] ?? ''}${BULLET}•${RESET}${base} ${out.slice(bullet[0].length)}`;
  } else {
    const numbered = /^(\s*)(\d+)\.\s+/.exec(out);
    if (numbered) {
      out = `${numbered[1] ?? ''}${BULLET}${numbered[2]}.${RESET}${base} ${out.slice(numbered[0].length)}`;
    } else {
      const heading = /^#{1,6}\s+(.*)$/.exec(out);
      if (heading) out = `${BOLD}${heading[1] ?? ''}${sgr('22')}`;
    }
  }

  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => `${BOLD}${inner}${sgr('22')}${base}`);
  out = out.replace(/(^|[^`])`([^`]+)`/g, (_m, before: string, inner: string) =>
    `${before}${CODE}${inner}${RESET}${base}`,
  );
  return out;
}

/**
 * Breaks a line to fit the width, on word boundaries where there is one. A
 * terminal will wrap on its own, but it wraps into column zero — straight
 * through the gutter — so a long paragraph stops being visibly the agent's
 * halfway down. Wrapping here keeps every continuation line inside the gutter.
 *
 * Runs on plain text, before any colour is applied, because an escape sequence
 * occupies no columns and would make every width calculation wrong.
 */
function wrapPlain(text: string, width: number): string[] {
  if (width < 8) return [text];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    // A single unbroken token — a path, a URL — has to be cut mid-word.
    if (cut <= 0) cut = width;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
}

/** Collapses a multi-line argument to one line so it can be wrapped sanely. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Splits a tool call into a name and the one thing about it worth reading.
 * The engine used to fold these together into a single display string, which
 * meant a shell script arrived as one enormous "tool name".
 */
function summarise(toolName: string, input: unknown): { head: string; detail: string } {
  if (!isRecord(input)) return { head: toolName, detail: '' };
  const str = (key: string): string =>
    typeof input[key] === 'string' ? (input[key] as string) : '';

  switch (toolName) {
    case 'Bash':
      return { head: 'Bash', detail: oneLine(str('command')) };
    case 'Read':
    case 'Write':
    case 'Edit':
      return { head: toolName, detail: str('file_path') };
    case 'Glob':
    case 'Grep':
      return { head: toolName, detail: oneLine(`${str('pattern')} ${str('path')}`) };
    case 'WebSearch':
      return { head: 'Search', detail: oneLine(str('query')) };
    case 'WebFetch':
      return { head: 'Fetch', detail: str('url') };
    default: {
      const keys = Object.keys(input).slice(0, 3).join(', ');
      return { head: toolName, detail: keys };
    }
  }
}

/**
 * Writes agent output into the same xterm buffer the shell writes to. The two
 * streams are told apart by colour and a gutter marker, never by layout — a
 * separate transcript pane is the thing this app exists not to have.
 *
 * Streaming text arrives token by token, so the gutter has to be injected at
 * every line break as the text flows, not prepended to a finished block.
 */
export class AgentWriter {
  private atLineStart = true;
  private streaming = false;
  /** Set from the session so paths can be shown as `~/…` rather than in full. */
  home = '';
  /** True once anything has been written since the last blank separator, so
   *  spacing is inserted between blocks and never at the top of a turn. */
  private wroteSinceGap = false;
  /**
   * Markdown spans cross token boundaries, so text is held until the line is
   * complete. Lines still appear as they are generated — the unit of streaming
   * is a line rather than a token, which reads better anyway.
   */
  private pending = '';

  constructor(private readonly term: Terminal) {}

  /**
   * Drops buffered state after the buffer itself has been wiped. Without this
   * a half-written line would be flushed into the fresh screen, gutter and
   * all, as if it belonged to whatever comes next.
   */
  reset(): void {
    this.pending = '';
    this.atLineStart = true;
    this.wroteSinceGap = false;
  }

  /** True while a turn is producing output, so Ctrl+C knows to interrupt. */
  get isStreaming(): boolean {
    return this.streaming;
  }

  private get width(): number {
    return Math.max(20, this.term.cols - GUTTER_WIDTH - 1);
  }

  private shorten(path: string): string {
    return this.home && path.startsWith(this.home) ? '~' + path.slice(this.home.length) : path;
  }

  private raw(text: string): void {
    this.term.write(text);
  }

  /** One physical line, gutter-marked. Never wrapped further. */
  private row(body: string): void {
    this.raw(GUTTER + body + RESET + '\r\n');
    this.atLineStart = true;
    this.wroteSinceGap = true;
  }

  /** An empty gutter line. Blocks need air; two of them in a row do not. */
  private gap(): void {
    if (!this.wroteSinceGap) return;
    this.raw(sgr('38;5;68') + GUTTER_CHAR.trimEnd() + RESET + '\r\n');
    this.wroteSinceGap = false;
    this.atLineStart = true;
  }

  /** Emits one logical line, wrapped to width and markdown-rendered. */
  private emitLine(line: string, colour: string, indent = ''): void {
    const hanging = /^\s*([-*]|\d+\.)\s/.test(line) ? '  ' : '';
    const segments = wrapPlain(line, this.width - indent.length);
    segments.forEach((segment, i) => {
      const lead = indent + (i === 0 ? '' : hanging);
      this.row(colour + lead + renderMarkdown(segment, colour));
    });
  }

  /** Buffers until a line is complete, then renders it. */
  private gutterWrite(text: string, colour: string): void {
    this.pending += text.replace(/\r/g, '');
    let index = this.pending.indexOf('\n');
    while (index !== -1) {
      const line = this.pending.slice(0, index);
      // A blank line in the agent's prose is a paragraph break, not a row.
      if (line.trim() === '') this.gap();
      else this.emitLine(line, colour);
      this.pending = this.pending.slice(index + 1);
      index = this.pending.indexOf('\n');
    }
  }

  /** Flushes a trailing partial line, e.g. when a turn ends mid-sentence. */
  private flushPending(colour: string): void {
    if (this.pending.length > 0) {
      this.emitLine(this.pending, colour);
      this.pending = '';
    }
  }

  /** Ends the current gutter line so shell output never inherits it. */
  private closeLine(): void {
    this.flushPending(AGENT_TEXT);
    if (!this.atLineStart) {
      this.raw(RESET + '\r\n');
      this.atLineStart = true;
    }
  }

  /**
   * Marks the start of a turn. The compose line has already echoed the prompt
   * as it was typed, so re-rendering it here would print it twice.
   */
  beginTurn(): void {
    this.closeLine();
    this.streaming = true;
    this.wroteSinceGap = false;
  }

  /**
   * Renders the submitted prompt. Used when the shell's line editor owned the
   * text and cleared it on submit, so the scrollback would otherwise lose it.
   */
  echoPrompt(text: string): void {
    this.closeLine();
    this.emitLine(text, sgr('38;5;110') + sgr('1'));
    this.streaming = true;
    this.wroteSinceGap = false;
  }

  handle(event: StreamEvent): void {
    switch (event.kind) {
      case 'text':
        this.streaming = true;
        this.gutterWrite(event.text, AGENT_TEXT);
        break;

      case 'thinking':
        this.streaming = true;
        this.gutterWrite(event.text, THINKING);
        break;

      case 'tool_start': {
        this.closeLine();
        this.gap();
        const { head, detail } = summarise(event.toolName, event.input);
        const shown = this.shorten(detail);
        const inline = `● ${head}  ${shown}`;
        if (!shown) {
          this.row(`${TOOL}● ${head}`);
        } else if (inline.length <= this.width) {
          this.row(`${TOOL}● ${head}  ${TOOL_ARG}${shown}`);
        } else {
          // Too long for one line: name first, argument indented under it, so
          // the eye finds the tool without reading the whole command.
          this.row(`${TOOL}● ${head}`);
          const lines = wrapPlain(shown, this.width - 2);
          for (const line of lines.slice(0, MAX_ARG_LINES)) this.row(`${TOOL_ARG}  ${line}`);
          if (lines.length > MAX_ARG_LINES) this.row(`${META}  … ${lines.length - MAX_ARG_LINES} more lines`);
        }
        break;
      }

      case 'tool_result': {
        // A count plus the first line. The whole output belongs in the buffer
        // only when the agent decides to quote it back.
        const lines = event.output.split('\n').filter((l) => l.trim().length > 0);
        const first = lines[0] ?? '';
        const room = this.width - 12;
        const trimmed = first.length > room ? first.slice(0, room - 1) + '…' : first;
        const count = lines.length > 1 ? `${lines.length} lines · ` : '';
        this.closeLine();
        if (event.ok) {
          this.row(`${META}  └ ${count}${trimmed || 'no output'}`);
        } else {
          this.row(`${TOOL_FAIL}  └ failed  ${trimmed}`);
        }
        this.gap();
        break;
      }

      case 'error':
        this.closeLine();
        this.gap();
        this.emitLine(event.message, ERROR);
        break;

      case 'turn_end': {
        this.closeLine();
        this.streaming = false;
        if (event.usage) {
          const { input, output, cacheRead, cacheWrite, costUsd } = event.usage;
          const cost = typeof costUsd === 'number' ? ` · $${costUsd.toFixed(4)}` : '';
          this.gap();
          this.row(
            `${META}${input + cacheRead + cacheWrite} in / ${output} out` +
              `${cacheRead ? ` (${cacheRead} cached)` : ''}${cost}`,
          );
        }
        break;
      }

      case 'shell_echo':
        break;
    }
  }
}
