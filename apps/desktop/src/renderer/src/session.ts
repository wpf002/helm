// One live terminal surface. Each session owns its own xterm instance, so
// switching tabs keeps every scrollback intact rather than replaying it.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { TranscriptEntry } from '@helm/shared';
import { AgentWriter } from './agentWriter';

export const THEME = {
  background: '#0d1017',
  foreground: '#c5cad3',
  cursor: '#6fb2ff',
  cursorAccent: '#0d1017',
  selectionBackground: '#2a3550',
  black: '#1c2028',
  red: '#f0707a',
  green: '#7ec98f',
  yellow: '#e0c07a',
  blue: '#6fb2ff',
  magenta: '#c39ae0',
  cyan: '#68c9c0',
  white: '#c5cad3',
  brightBlack: '#5c6470',
  brightRed: '#ff8b93',
  brightGreen: '#95e0a6',
  brightYellow: '#f2d491',
  brightBlue: '#8cc4ff',
  brightMagenta: '#d6b3f0',
  brightCyan: '#84dfd6',
  brightWhite: '#e8ecf2',
};

export interface Session {
  /** The pty session id, assigned by main. Empty until create() resolves. */
  id: string;
  /** Stable key for React, independent of the pty id. */
  key: number;
  title: string;
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  writer: AgentWriter;
  cwd: string;
  home: string;
  exited: number | null;
  /** Set once the zsh widget announces itself for this session's shell. */
  widget: boolean;
  /** Fallback compose buffer, used only when the widget is absent. */
  compose: string | null;
  atLineStart: boolean;
  dispose: () => void;
}

let nextKey = 1;

export function createTerminal(): { term: Terminal; fit: FitAddon; host: HTMLDivElement } {
  const host = document.createElement('div');
  host.className = 'surface';

  const term = new Terminal({
    fontFamily: 'SFMono-Regular, "SF Mono", Menlo, Monaco, "JetBrains Mono", monospace',
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    scrollback: 50_000,
    macOptionIsMeta: true,
    theme: THEME,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  return { term, fit, host };
}

export function newSession(host: HTMLDivElement, term: Terminal, fit: FitAddon): Session {
  return {
    id: '',
    key: nextKey++,
    title: 'shell',
    host,
    term,
    fit,
    writer: new AgentWriter(term),
    cwd: '',
    home: '',
    exited: null,
    widget: false,
    compose: null,
    atLineStart: true,
    dispose: () => term.dispose(),
  };
}

/**
 * Replays a recorded transcript through the same render path that drew it
 * originally — pty bytes to the terminal, agent events to the writer. Storing
 * events rather than rendered text is what makes this exact.
 */
export function replay(session: Session, entries: readonly TranscriptEntry[]): void {
  for (const entry of entries) {
    if (entry.t === 'pty') session.term.write(entry.d);
    else session.writer.handle(entry.e);
  }
}
