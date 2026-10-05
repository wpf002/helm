import type { Terminal } from '@xterm/xterm';
import type { StreamEvent } from '@helm/shared';

const ESC = String.fromCharCode(0x1b);
const sgr = (code: string): string => `${ESC}[${code}m`;
/** 24-bit colour; xterm.js renders it exactly, so the palette is real hex. */
const rgb = (hex: string): string =>
  sgr(`38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`);

/**
 * The palette is Gemini CLI's default dark theme: purple for Helm's voice and
 * inline code, blue for actions, cyan for commands, pale green and pink only
 * for how an action ended, yellow for anything waiting on the user, and grey
 * for detail. Foreground is a touch off white so it does not glare.
 */
const GEMINI = {
  fg: '#eeeeee',
  gray: '#afafaf',
  border: '#878787',
  purple: '#d7afff',
  blue: '#87afff',
  cyan: '#87d7d7',
  green: '#d7ffd7',
  yellow: '#ffffaf',
  red: '#ff87af',
};
const FAINT = sgr('2');

const PALETTE = {
  gutter: FAINT + rgb(GEMINI.border),
  voice: rgb(GEMINI.purple), // ✦, Helm speaking
  text: rgb(GEMINI.fg),
  thinking: rgb(GEMINI.gray) + sgr('3'),
  action: rgb(GEMINI.blue), // a running tool
  edge: FAINT + rgb(GEMINI.blue), // its box while it runs
  closed: rgb(GEMINI.border), // its box once it is done
  command: rgb(GEMINI.cyan),
  detail: rgb(GEMINI.gray),
  ok: rgb(GEMINI.green),
  fail: rgb(GEMINI.red),
  heading: rgb(GEMINI.blue) + sgr('1'),
  prompt: rgb(GEMINI.blue) + sgr('1'),
  code: rgb(GEMINI.purple),
};

const RESET = sgr('0');
const BOLD = sgr('1');
const NORMAL = sgr('22');

/**
 * The gutter is what tells Helm's lines from the shell's in the one buffer they
 * share. Tool boxes draw their own left edge in the same column, so a command
 * reads as part of Helm's turn without a second marker.
 */
const GUTTER_WIDTH = 2;

/** How much of a command to show before cutting it. Enough to recognise it. */
const MAX_COMMAND_LINES = 4;
/** How much of a command's output to show. The agent quotes more if it matters. */
const MAX_OUTPUT_LINES = 3;

/**
 * Renders the small amount of markdown a terminal can honestly show: bold,
 * inline code, bullets, numbered items and single-line headings. Tables and
 * nested lists have no good rendering in a fixed-width buffer, so the system
 * prompt asks for prose instead of pretending otherwise.
 */
function renderMarkdown(line: string, base: string): string {
  let out = line;

  const bullet = /^(\s*)[-*]\s+/.exec(out);
  if (bullet) {
    out = `${bullet[1] ?? ''}${PALETTE.detail}•${RESET}${base} ${out.slice(bullet[0].length)}`;
  } else {
    const numbered = /^(\s*)(\d+)\.\s+/.exec(out);
    if (numbered) {
      out = `${numbered[1] ?? ''}${PALETTE.detail}${numbered[2]}.${RESET}${base} ${out.slice(numbered[0].length)}`;
    } else {
      const heading = /^(#{1,6})\s+(.*)$/.exec(out);
      if (heading) {
        const level = (heading[1] as string).length;
        const style = level <= 2 ? PALETTE.heading : level === 3 ? BOLD : PALETTE.detail + sgr('3');
        out = `${style}${heading[2] ?? ''}${RESET}${base}`;
      }
    }
  }

  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => `${BOLD}${inner}${NORMAL}${base}`);
  out = out.replace(/(^|[^`])`([^`]+)`/g, (_m, before: string, inner: string) =>
    `${before}${PALETTE.code}${inner}${RESET}${base}`,
  );
  return out;
}

/**
 * Breaks a line to fit the width, on word boundaries where there is one. The
 * terminal would wrap on its own, but into column zero, straight through the
 * gutter. Runs on plain text, before colour: an escape sequence takes no
 * columns and would throw every width off.
 */
function wrapPlain(text: string, width: number): string[] {
  if (width < 8) return [text];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width; // one unbroken token, a path or a URL
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * What a tool call is doing, as a title anyone can read, plus the command or
 * path underneath it. The model writes a plain description for every shell
 * command; the other tools get one built from their arguments.
 */
function describe(rawName: string, input: unknown, shorten: (p: string) => string): { title: string; command: string } {
  const name = /^mcp__.+?__(.+)$/.exec(rawName)?.[1] ?? rawName;
  const str = (key: string): string => (isRecord(input) && typeof input[key] === 'string' ? (input[key] as string) : '');
  const said = oneLine(str('description'));

  switch (name) {
    case 'Bash':
      return { title: said || 'Run a command', command: str('command') };
    case 'run_in_terminal':
      return { title: said || 'Run a command in your terminal', command: str('command') };
    case 'Read':
      return { title: `Read ${shorten(str('file_path'))}`, command: '' };
    case 'Write':
      return { title: `Write ${shorten(str('file_path'))}`, command: '' };
    case 'Edit':
    case 'MultiEdit':
      return { title: `Edit ${shorten(str('file_path'))}`, command: '' };
    case 'Glob':
      return { title: `Look for files matching ${str('pattern')}`, command: '' };
    case 'Grep':
      return { title: `Search files for “${oneLine(str('pattern'))}”`, command: '' };
    case 'WebSearch':
      return { title: `Search the web for “${oneLine(str('query'))}”`, command: '' };
    case 'WebFetch':
      return { title: `Open ${str('url')}`, command: '' };
    case 'terminal_output':
      return { title: 'Read what the terminal shows', command: '' };
    case 'remember':
      return { title: 'Save a note to memory', command: '' };
    case 'forget':
      return { title: 'Remove a note from memory', command: '' };
    default:
      return { title: said || `Use ${name}`, command: '' };
  }
}

function formatCost(costUsd: number): string {
  if (costUsd < 0.01) return 'less than 1¢';
  if (costUsd < 1) return `about ${Math.round(costUsd * 100)}¢`;
  return `about $${costUsd.toFixed(2)}`;
}

function formatSeconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Writes agent output into the same xterm buffer the shell writes to. The two
 * streams are told apart by colour and the gutter, never by layout — a separate
 * transcript pane is the thing this app exists not to have.
 *
 * Text streams in token by token, so it is held until a line is complete and
 * then rendered with the gutter: the unit of streaming is a line.
 */
export class AgentWriter {
  private atLineStart = true;
  private streaming = false;
  /** Set from the session so paths can be shown as `~/…` rather than in full. */
  home = '';
  /** True once anything has been written since the last blank separator. */
  private wroteSinceGap = false;
  private pending = '';
  /** The next prose line starts a new answer block and gets the ✦. */
  private freshBlock = true;
  private turnStarted = 0;
  /** Titles of tools that have started, for results that arrive out of order. */
  private readonly titles = new Map<string, string>();
  /** The tool whose box is open and still the last thing on screen. */
  private openBox: string | null = null;
  /** True while rows belong to a tool box, so its edge is drawn in the box colour. */
  private inBox = false;

  constructor(private readonly term: Terminal) {}

  /** Drops buffered state after the buffer itself has been wiped. */
  reset(): void {
    this.pending = '';
    this.atLineStart = true;
    this.wroteSinceGap = false;
    this.freshBlock = true;
    this.openBox = null;
    this.titles.clear();
  }

  /** Ends any open gutter line so something else can write a clean row. */
  endLine(): void {
    this.closeLine();
  }

  /** True while a turn is producing output, so Ctrl+C knows to interrupt. */
  get isStreaming(): boolean {
    return this.streaming;
  }

  private get width(): number {
    return Math.max(20, this.term.cols - GUTTER_WIDTH - 1);
  }

  private shorten = (path: string): string =>
    this.home && path.startsWith(this.home) ? '~' + path.slice(this.home.length) : path;

  private raw(text: string): void {
    this.term.write(text);
  }

  /**
   * One physical row, marked on the left. The shell shares this buffer and may
   * have left the cursor mid-row, so the row is started properly first; the
   * terminal is asked where the cursor is, because nothing else here knows.
   */
  private row(body: string, edge = '│'): void {
    const lead = this.cursorColumn() > 0 ? '\r\n' : '';
    const colour = edge === '╰' ? PALETTE.closed : edge === '│' && !this.inBox ? PALETTE.gutter : PALETTE.edge;
    this.raw(lead + colour + edge + RESET + ' ' + body + RESET + '\r\n');
    this.atLineStart = true;
    this.wroteSinceGap = true;
  }

  /** An empty gutter row between blocks; never two in a row. */
  private gap(): void {
    if (!this.wroteSinceGap) return;
    const lead = this.cursorColumn() > 0 ? '\r\n' : '';
    this.raw(lead + PALETTE.gutter + '│' + RESET + '\r\n');
    this.wroteSinceGap = false;
    this.atLineStart = true;
  }

  /** One logical line of prose, wrapped, rendered, and marked ✦ if it opens a block. */
  private emitLine(line: string, colour: string): void {
    const glyph = colour === PALETTE.text && this.freshBlock;
    if (colour === PALETTE.text) this.freshBlock = false;
    const hanging = /^\s*([-*]|\d+\.)\s/.test(line) ? '  ' : '';
    const segments = wrapPlain(line, this.width - 2);
    segments.forEach((segment, i) => {
      const lead = i === 0 ? (glyph ? `${PALETTE.voice}✦${RESET}${colour} ` : '  ') : `  ${hanging}`;
      this.row(colour + lead + renderMarkdown(segment, colour));
    });
  }

  private gutterWrite(text: string, colour: string): void {
    this.closeBox();
    this.pending += text.replace(/\r/g, '');
    let index = this.pending.indexOf('\n');
    while (index !== -1) {
      const line = this.pending.slice(0, index);
      if (line.trim() === '') this.gap();
      else this.emitLine(line, colour);
      this.pending = this.pending.slice(index + 1);
      index = this.pending.indexOf('\n');
    }
  }

  private flushPending(colour: string): void {
    if (this.pending.length > 0) {
      this.emitLine(this.pending, colour);
      this.pending = '';
    }
  }

  /**
   * Ends the current line so shell output never inherits the gutter. The cursor
   * column comes from the terminal, because the shell writes here too and only
   * the terminal knows where the cursor really is.
   */
  private closeLine(): void {
    this.flushPending(PALETTE.text);
    if (!this.atLineStart || this.cursorColumn() > 0) {
      this.raw(RESET + '\r\n');
      this.atLineStart = true;
    }
  }

  private cursorColumn(): number {
    try {
      return this.term.buffer.active.cursorX;
    } catch {
      return 0;
    }
  }

  /** A box left open by a tool that never reported back gets a quiet bottom edge. */
  private closeBox(): void {
    if (this.openBox === null) return;
    this.openBox = null;
    this.row(`${PALETTE.detail}…`, '╰');
    this.inBox = false;
  }

  beginTurn(): void {
    this.closeLine();
    this.streaming = true;
    this.wroteSinceGap = false;
    this.freshBlock = true;
    this.turnStarted = Date.now();
  }

  /** Re-renders the submitted prompt when the shell's line editor cleared it. */
  echoPrompt(text: string): void {
    this.closeLine();
    const lines = wrapPlain(text, this.width - 2);
    lines.forEach((line, i) => this.row(`${PALETTE.prompt}${i === 0 ? '›' : ' '} ${line}`));
    this.streaming = true;
    this.wroteSinceGap = false;
    this.freshBlock = true;
    this.turnStarted = Date.now();
  }

  handle(event: StreamEvent): void {
    switch (event.kind) {
      case 'text':
        this.streaming = true;
        this.gutterWrite(event.text, PALETTE.text);
        break;

      case 'thinking':
        this.streaming = true;
        this.gutterWrite(event.text, PALETTE.thinking);
        break;

      case 'tool_start': {
        this.closeLine();
        this.closeBox();
        this.gap();
        const { title, command } = describe(event.toolName, event.input, this.shorten);
        this.titles.set(event.toolId, title);
        this.inBox = true;
        const titleLines = wrapPlain(title, this.width - 4);
        titleLines.forEach((line, i) =>
          this.row(`${PALETTE.action}${i === 0 ? '⊷ ' : '  '}${BOLD}${line}${NORMAL}`, i === 0 ? '╭' : '│'),
        );
        if (command) {
          const lines = command
            .split('\n')
            .flatMap((l) => wrapPlain(this.shorten(l), this.width - 6))
            .filter((l) => l.trim().length > 0);
          lines.slice(0, MAX_COMMAND_LINES).forEach((line, i) =>
            this.row(`  ${PALETTE.detail}${i === 0 ? '$' : ' '} ${PALETTE.command}${line}`, '│'),
          );
          if (lines.length > MAX_COMMAND_LINES) {
            this.row(`  ${PALETTE.detail}  … ${lines.length - MAX_COMMAND_LINES} more lines`, '│');
          }
        }
        this.openBox = event.toolId;
        this.freshBlock = true;
        break;
      }

      case 'tool_result': {
        this.closeLine();
        const lines = event.output.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
        const room = this.width - 6;
        const clip = (l: string): string => (l.length > room ? l.slice(0, room - 1) + '…' : l);

        // Its own box is still the last thing drawn: fill it in and close it.
        // Otherwise (tools ran side by side) name the tool on the closing line.
        const inBox = this.openBox === event.toolId;
        if (!inBox) this.closeBox();
        const title = this.titles.get(event.toolId) ?? 'Command';
        this.titles.delete(event.toolId);
        this.openBox = null;

        if (event.ok) {
          if (inBox) {
            for (const line of lines.slice(0, MAX_OUTPUT_LINES)) this.row(`  ${PALETTE.detail}${clip(line)}`, '│');
            if (lines.length > MAX_OUTPUT_LINES) this.row(`  ${PALETTE.detail}… and ${lines.length - MAX_OUTPUT_LINES} more lines`, '│');
          }
          this.row(`${PALETTE.ok}✓ ${inBox ? 'Done' : `Done: ${title}`}${lines.length === 0 ? `${PALETTE.detail} · no output` : ''}`, '╰');
        } else {
          const why = lines.find((l) => /error|fail|denied|not found|no such/i.test(l)) ?? lines[0] ?? '';
          this.row(`${PALETTE.fail}${BOLD}✕${NORMAL} ${inBox ? 'Failed' : `Failed: ${title}`}${why ? `${PALETTE.detail} · ${clip(why)}` : ''}`, '╰');
        }
        this.inBox = false;
        this.gap();
        this.freshBlock = true;
        break;
      }

      case 'error':
        this.closeLine();
        this.closeBox();
        this.gap();
        wrapPlain(event.message, this.width - 2).forEach((line, i) =>
          this.row(`${PALETTE.fail}${i === 0 ? '✕' : ' '} ${line}`),
        );
        this.freshBlock = true;
        break;

      case 'turn_end': {
        this.closeLine();
        this.closeBox();
        this.streaming = false;
        const took = this.turnStarted > 0 ? `Done in ${formatSeconds(Date.now() - this.turnStarted)}` : 'Done';
        const cost = typeof event.usage?.costUsd === 'number' ? ` · ${formatCost(event.usage.costUsd)}` : '';
        this.gap();
        this.row(`${PALETTE.detail}${took}${cost}`);
        this.turnStarted = 0;
        this.freshBlock = true;
        break;
      }

      case 'shell_echo':
        break;
    }
  }
}
