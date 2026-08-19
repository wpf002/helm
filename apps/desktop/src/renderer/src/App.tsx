// Single-column layout: one xterm buffer carries both streams. The shell and
// the agent write into the same scrollback in real time order — that unified
// scroll is the entire point of the app, so there is deliberately no second
// transcript surface.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { PermissionRequest } from '@helm/shared';
import { AgentWriter } from './agentWriter';

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
const ESC = String.fromCharCode(0x1b);
const CTRL_C = String.fromCharCode(0x03);
const BACKSPACE = String.fromCharCode(0x7f);

function displayCwd(cwd: string, home: string): string {
  if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}

export default function App(): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<string | null>(null);
  const exitedRef = useRef(false);
  const homeRef = useRef('');

  // Agent compose mode: Helm owns the line, so it must echo what is typed.
  const composeRef = useRef<string | null>(null);
  const atLineStartRef = useRef(true);
  const writerRef = useRef<AgentWriter | null>(null);
  const permissionRef = useRef<PermissionRequest | null>(null);

  const [cwd, setCwd] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        'SFMono-Regular, "SF Mono", Menlo, Monaco, "JetBrains Mono", "Fira Code", monospace',
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
    term.open(host);

    const writer = new AgentWriter(term);
    writerRef.current = writer;

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

    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }

    const notice = (text: string): void => {
      term.write(`\r\n${ESC}[38;5;245m${text}${ESC}[0m\r\n`);
    };

    let disposed = false;

    const startSession = async (): Promise<void> => {
      const info = await window.helm.pty.create({ cols: term.cols, rows: term.rows });
      if (disposed) return;
      sessionRef.current = info.id;
      homeRef.current = info.cwd;
      exitedRef.current = false;
      atLineStartRef.current = true;
      setExitCode(null);
      setCwd(info.cwd);
      term.focus();
    };

    const toPty = (data: string): void => {
      const id = sessionRef.current;
      if (id) window.helm.pty.write(id, data);
    };

    // ---- agent stream ------------------------------------------------------
    const offStream = window.helm.agent.onStream((event) => {
      writer.handle(event);
      if (event.kind === 'turn_end') setBusy(false);
    });

    const answerPermission = (behavior: 'allow' | 'deny', persist: boolean): void => {
      const request = permissionRef.current;
      if (!request) return;
      permissionRef.current = null;
      window.helm.agent.resolvePermission({ id: request.id, behavior, persist });
      term.write(
        `${ESC}[38;5;68m│ ${ESC}[38;5;242m  ${behavior}${persist ? ' (session)' : ''}${ESC}[0m\r\n`,
      );
    };

    const offPermission = window.helm.agent.onPermissionRequest((request) => {
      permissionRef.current = request;
      // Phase 2 shows raw JSON deliberately; Phase 4 replaces this with the
      // resolved-path overlay, which is the feature this app exists for.
      const json = JSON.stringify(request.input, null, 2);
      term.write(
        `\r\n${ESC}[38;5;68m│ ${ESC}[38;5;215mpermission: ${request.toolName}${ESC}[0m\r\n`,
      );
      for (const line of json.split('\n').slice(0, 20)) {
        term.write(`${ESC}[38;5;68m│ ${ESC}[38;5;242m${line}${ESC}[0m\r\n`);
      }
      term.write(
        `${ESC}[38;5;68m│ ${ESC}[38;5;215m[y] allow  [a] allow for session  [n] deny${ESC}[0m\r\n`,
      );
    });

    const submitPrompt = (text: string): void => {
      composeRef.current = null;
      atLineStartRef.current = true;
      if (!text.trim()) {
        term.write('\r\n');
        return;
      }
      writer.echoPrompt(text);
      setBusy(true);
      window.helm.agent.prompt(text);
    };

    // ---- input routing -----------------------------------------------------
    const offInput = term.onData((data) => {
      // 1. A pending permission owns the keyboard until answered.
      if (permissionRef.current) {
        if (data === 'y') answerPermission('allow', false);
        else if (data === 'a') answerPermission('allow', true);
        else if (data === 'n' || data === CTRL_C) answerPermission('deny', false);
        return;
      }

      // 2. Ctrl+C during a turn interrupts the agent, never the pty.
      if (data === CTRL_C && writer.isStreaming) {
        window.helm.agent.interrupt();
        term.write(`\r\n${ESC}[38;5;242m^C interrupted${ESC}[0m\r\n`);
        setBusy(false);
        return;
      }

      // 3. Agent compose mode: Helm owns the line and echoes it itself.
      const composing = composeRef.current;
      if (composing !== null) {
        if (data === '\r' || data === '\n') {
          term.write('\r\n');
          submitPrompt(composing);
        } else if (data === BACKSPACE) {
          if (composing.length > 0) {
            composeRef.current = composing.slice(0, -1);
            term.write('\b \b');
          }
        } else if (data === CTRL_C) {
          composeRef.current = null;
          atLineStartRef.current = true;
          term.write(`${ESC}[38;5;242m ^C${ESC}[0m\r\n`);
        } else if (data >= ' ') {
          composeRef.current = composing + data;
          term.write(data);
        }
        return;
      }

      // 4. Dead shell: Enter respawns.
      if (exitedRef.current) {
        if (data.includes('\r') || data.includes('\n')) {
          notice('[starting a new shell]');
          void startSession();
        }
        return;
      }

      // 5. Prefix routing, only at the start of a line.
      if (atLineStartRef.current) {
        if (data === '?') {
          composeRef.current = '';
          term.write(`${ESC}[38;5;68m│ ${ESC}[38;5;110m`);
          return;
        }
        if (data === '$') {
          // Swallow the marker; the rest of the line goes raw to the shell so
          // zsh keeps its own history and completion.
          atLineStartRef.current = false;
          return;
        }
      }

      if (data.includes('\r') || data.includes('\n')) atLineStartRef.current = true;
      else if (data >= ' ') atLineStartRef.current = false;

      toPty(data);
    });

    const offData = window.helm.pty.onData(({ sessionId, data }) => {
      if (sessionId === sessionRef.current) term.write(data);
    });

    const offExit = window.helm.pty.onExit(({ sessionId, code }) => {
      if (sessionId !== sessionRef.current) return;
      exitedRef.current = true;
      setExitCode(code);
      notice(`[shell exited with code ${code} — press Enter to start a new one]`);
    });

    const offClear = window.helm.onClear(() => term.clear());

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
      offStream();
      offPermission();
      offInput.dispose();
      term.dispose();
      writerRef.current = null;
    };
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <span className="titlebar__name">Helm</span>
        {cwd && <span className="titlebar__cwd">{displayCwd(cwd, homeRef.current)}</span>}
        {busy && <span className="titlebar__busy">agent working — ^C to stop</span>}
        {exitCode !== null && <span className="titlebar__badge">shell exited ({exitCode})</span>}
      </header>
      <div className="terminal" ref={hostRef} />
    </div>
  );
}
