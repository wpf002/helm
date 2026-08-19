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

  constructor(private readonly term: Terminal) {}

  /** True while a turn is producing output, so Ctrl+C knows to interrupt. */
  get isStreaming(): boolean {
    return this.streaming;
  }

  private raw(text: string): void {
    this.term.write(text);
  }

  /** Emits text with the gutter re-applied after every newline. */
  private gutterWrite(text: string, colour: string): void {
    for (const char of text) {
      if (this.atLineStart) {
        this.raw(GUTTER + colour);
        this.atLineStart = false;
      }
      if (char === '\n') {
        this.raw(RESET + '\r\n');
        this.atLineStart = true;
      } else if (char !== '\r') {
        this.raw(char);
      }
    }
  }

  /** Ends the current gutter line so shell output never inherits it. */
  private closeLine(): void {
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
