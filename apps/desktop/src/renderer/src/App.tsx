// Single-column layout: transcript above, unified prompt below. The xterm
// buffer and the agent transcript render into the same scroll container so
// shell output and tool output interleave in real time order.
//
// Phase 1 has no agent, so the buffer is pure PTY. Phase 2 writes agent output
// into this same Terminal instance rather than adding a second surface.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

const THEME = {
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

const RESIZE_DEBOUNCE_MS = 80;

/** Shortens $HOME to ~ for the title bar. */
function displayCwd(cwd: string, home: string): string {
  if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}

export default function App(): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<string | null>(null);
  const exitedRef = useRef(false);
  const homeRef = useRef('');

  const [cwd, setCwd] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        'SFMono-Regular, "SF Mono", Menlo, Monaco, "JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 50_000,
      macOptionIsMeta: true,
      theme: THEME,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    /**
     * Track cwd for the title bar straight off the stream. Returning false
     * leaves the sequence unconsumed so nothing downstream changes behaviour.
     */
    term.parser.registerOscHandler(7, (data) => {
      const match = /^file:\/\/[^/]*(.*)$/.exec(data);
      if (match && match[1]) {
        try {
          setCwd(decodeURIComponent(match[1]));
        } catch {
          setCwd(match[1]);
        }
      }
      return false;
    });

    // A fit before the session exists means the pty is born at the right size
    // rather than starting at 80x24 and reflowing.
    try {
      fit.fit();
    } catch {
      /* host not laid out yet */
    }

    const writeNotice = (text: string): void => {
      term.write(`\r\n\x1b[38;5;245m${text}\x1b[0m\r\n`);
    };

    let disposed = false;

    const startSession = async (): Promise<void> => {
      const info = await window.helm.pty.create({ cols: term.cols, rows: term.rows });
      if (disposed) return;
      sessionRef.current = info.id;
      homeRef.current = info.cwd;
      exitedRef.current = false;
      setExitCode(null);
      setCwd(info.cwd);
      term.focus();
    };

    const offData = window.helm.pty.onData(({ sessionId, data }) => {
      if (sessionId === sessionRef.current) term.write(data);
    });

    const offExit = window.helm.pty.onExit(({ sessionId, code }) => {
      if (sessionId !== sessionRef.current) return;
      exitedRef.current = true;
      setExitCode(code);
      writeNotice(`[shell exited with code ${code} — press Enter to start a new one]`);
    });

    // Keystrokes go to the pty, except when the shell is dead: then Enter
    // respawns instead of vanishing into a closed fd.
    const offInput = term.onData((data) => {
      if (exitedRef.current) {
        if (data.includes('\r') || data.includes('\n')) {
          writeNotice('[starting a new shell]');
          void startSession();
        }
        return;
      }
      const id = sessionRef.current;
      if (id) window.helm.pty.write(id, data);
    });

    const offClear = window.helm.onClear(() => term.clear());

    // FitAddon is driven by the container's real size, not window resize —
    // padding and title bar changes move this box without a window event.
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        const id = sessionRef.current;
        if (id && !exitedRef.current) window.helm.pty.resize(id, term.cols, term.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);

    void startSession();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      observer.disconnect();
      offData();
      offExit();
      offClear();
      offInput.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar__name">Helm</span>
        {cwd && <span className="titlebar__cwd">{displayCwd(cwd, homeRef.current)}</span>}
        {exitCode !== null && <span className="titlebar__badge">shell exited ({exitCode})</span>}
      </header>
      <div className="terminal" ref={hostRef} />
    </div>
  );
}
