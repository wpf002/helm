import type { Terminal } from '@xterm/xterm';
import type { StreamEvent } from '@helm/shared';

const ESC = String.fromCharCode(0x1b);
const sgr = (code: string): string => `${ESC}[${code}m`;

const RESET = sgr('0');
/** The gutter is the only thing distinguishing the streams. Not layout. */
const GUTTER = sgr('38;5;68') + '│ ' + RESET;
const AGENT_TEXT = sgr('38;5;152');
const THINKING = sgr('38;5;242') + sgr('3');
const TOOL = sgr('38;5;108');
const TOOL_FAIL = sgr('38;5;174');
const ERROR = sgr('38;5;203');
const META = sgr('38;5;242');
const BOLD = sgr('1');
const CODE = sgr('38;5;180');
const BULLET = sgr('38;5;68');

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
      // A heading has no place here, but the agent occasionally emits one.
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
  /**
   * Markdown spans cross token boundaries, so text is held until the line is
   * complete. Lines still appear as they are generated — the unit of streaming
   * is a line rather than a token, which reads better anyway.
   */
  private pending = '';

  constructor(private readonly term: Terminal) {}

  /** True while a turn is producing output, so Ctrl+C knows to interrupt. */
  get isStreaming(): boolean {
    return this.streaming;
  }

  private raw(text: string): void {
    this.term.write(text);
  }

  /** Emits one finished line, gutter-marked and markdown-rendered. */
  private emitLine(line: string, colour: string): void {
    this.raw(GUTTER + colour + renderMarkdown(line, colour) + RESET + '\r\n');
    this.atLineStart = true;
  }

  /** Buffers until a line is complete, then renders it. */
  private gutterWrite(text: string, colour: string): void {
    this.pending += text.replace(/\r/g, '');
    let index = this.pending.indexOf('\n');
    while (index !== -1) {
      this.emitLine(this.pending.slice(0, index), colour);
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
  }

  /**
   * Renders the submitted prompt. Used when the shell's line editor owned the
   * text and cleared it on submit, so the scrollback would otherwise lose it.
   */
  echoPrompt(text: string): void {
    this.closeLine();
    this.raw(`${GUTTER}${sgr('38;5;110')}${sgr('1')}${text}${RESET}\r\n`);
    this.atLineStart = true;
    this.streaming = true;
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

      case 'tool_start':
        this.closeLine();
        this.raw(`${GUTTER}${TOOL}● ${event.toolName}${RESET}\r\n`);
        break;

      case 'tool_result': {
        // One line, never raw JSON. The full input is in the permission prompt.
        const firstLine = event.output.split('\n').find((l) => l.trim().length > 0) ?? '';
        const trimmed = firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
        const colour = event.ok ? META : TOOL_FAIL;
        const mark = event.ok ? '└' : '└ failed:';
        this.closeLine();
        this.raw(`${GUTTER}${colour}  ${mark} ${trimmed}${RESET}\r\n`);
        break;
      }

      case 'error':
        this.closeLine();
        this.raw(`${GUTTER}${ERROR}${event.message}${RESET}\r\n`);
        break;

      case 'turn_end': {
        this.closeLine();
        this.streaming = false;
        if (event.usage) {
          const { input, output, cacheRead, cacheWrite } = event.usage;
          this.raw(
            `${GUTTER}${META}${input + cacheRead + cacheWrite} in / ${output} out` +
              `${cacheRead ? ` (${cacheRead} cached)` : ''}${RESET}\r\n`,
          );
        }
        break;
      }

      case 'shell_echo':
        break;
    }
  }
}
