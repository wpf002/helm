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
import { PermissionOverlay } from './PermissionOverlay';

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
  // True once the zsh widget announces itself. While it is live, zsh owns the
  // line editor and Helm must not intercept keystrokes as well.
  const widgetRef = useRef(false);

  const [cwd, setCwd] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Mirrored into permissionRef so the input handler can read it synchronously.
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [permissionMode, setPermissionMode] = useState<'off' | 'prompt' | 'auto'>('prompt');
  const decideRef = useRef<((behavior: 'allow' | 'deny', persist: boolean) => void) | null>(null);

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

    /**
     * The shell's line editor handed us a finished line. Route it: shell-bound
     * lines are written back with a newline (still bound to accept-line, so no
     * loop), prompts go to the agent.
     */
    const submitLine = async (line: string): Promise<void> => {
      const route = await window.helm.route.submit(line);
      if (route.target === 'shell') {
        const id = sessionRef.current;
        if (id) window.helm.pty.write(id, route.command + '\n');
        return;
      }
      if (!route.prompt) return;
      writer.echoPrompt(route.prompt);
      setBusy(true);
      window.helm.agent.prompt(route.prompt);
    };

    term.parser.registerOscHandler(7375, () => {
      widgetRef.current = true;
      return true;
    });

    term.parser.registerOscHandler(7374, (data) => {
      try {
        void submitLine(atob(data));
      } catch {
        // A malformed submission is dropped rather than guessed at.
      }
      return true;
    });

    // Helm's own sequence: zsh reports each command as it runs so routing can
    // be measured against what was actually typed. Consumed, not forwarded.
    term.parser.registerOscHandler(7373, (data) => {
      try {
        window.helm.route.observe(atob(data), 'shell');
      } catch {
        // A malformed report is not worth disturbing the terminal over.
      }
      return true;
    });

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
      setPermissionMode(info.permissionMode);
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
      setPendingPermission(null);
      window.helm.agent.resolvePermission({ id: request.id, behavior, persist });
      // Keep a trace in the scrollback: the decision belongs in the log too.
      const scope = request.outOfScope ? ' [out of scope]' : '';
      term.write(
        `${ESC}[38;5;68m│ ${ESC}[38;5;242m${behavior}${persist ? ' (session)' : ''}` +
          ` ${request.toolName}${scope}${ESC}[0m\r\n`,
      );
      term.focus();
    };
    decideRef.current = answerPermission;

    const offPermission = window.helm.agent.onPermissionRequest((request) => {
      permissionRef.current = request;
      setPendingPermission(request);
      // A one-line marker keeps the scrollback honest about what was asked;
      // the detail lives in the overlay.
      term.write(
        `\r\n${ESC}[38;5;68m│ ${ESC}[38;5;215mpermission: ${request.toolName}` +
          `${request.outOfScope ? ' — outside your roots' : ''}${ESC}[0m\r\n`,
      );
    });

    const submitPrompt = (text: string): void => {
      composeRef.current = null;
      atLineStartRef.current = true;
      if (!text.trim()) {
        term.write('\r\n');
        return;
      }
      writer.beginTurn();
      setBusy(true);
      window.helm.route.observe(text, 'agent');
      window.helm.agent.prompt(text);
    };

    // ---- input routing -----------------------------------------------------
    //
    // Input arrives as chunks, not keystrokes: a paste (and any programmatic
    // insert) delivers a whole line in one event. Routing therefore walks the
    // chunk character by character rather than comparing the whole payload —
    // comparing `data === '?'` only ever matches hand-typing, so a pasted
    // command silently misroutes.
    const offInput = term.onData((data) => {
      // A pending permission owns the keyboard until answered.
      if (permissionRef.current) {
        const key = data[0];
        if (key === 'y') answerPermission('allow', false);
        else if (key === 'a') answerPermission('allow', true);
        else if (key === 'n' || key === CTRL_C) answerPermission('deny', false);
        return;
      }

      // Ctrl+C during a turn interrupts the agent, never the pty.
      if (data.includes(CTRL_C) && writer.isStreaming) {
        window.helm.agent.interrupt();
        term.write(`\r\n${ESC}[38;5;242m^C interrupted${ESC}[0m\r\n`);
        setBusy(false);
        return;
      }

      // Dead shell: Enter respawns.
      if (exitedRef.current) {
        if (data.includes('\r') || data.includes('\n')) {
          notice('[starting a new shell]');
          void startSession();
        }
        return;
      }

      // Shell-bound characters are batched so a paste stays one pty write.
      let pending = '';
      const flush = (): void => {
        if (pending) {
          toPty(pending);
          pending = '';
        }
      };

      for (const char of data) {
        // Agent compose mode: Helm owns the line and echoes it itself.
        if (composeRef.current !== null) {
          if (char === '\r' || char === '\n') {
            term.write('\r\n');
            submitPrompt(composeRef.current);
          } else if (char === BACKSPACE) {
            if (composeRef.current.length > 0) {
              composeRef.current = composeRef.current.slice(0, -1);
              term.write('\b \b');
            }
          } else if (char === CTRL_C) {
            composeRef.current = null;
            atLineStartRef.current = true;
            term.write(`${ESC}[38;5;242m ^C${ESC}[0m\r\n`);
          } else if (char >= ' ' && char !== BACKSPACE) {
            composeRef.current += char;
            term.write(char);
          }
          continue;
        }

        // Prefix routing, only at the start of a line — and only when the zsh
        // widget is absent. With the widget live, zsh owns the buffer and
        // grabbing keys here would fight it.
        if (atLineStartRef.current && !widgetRef.current) {
          if (char === '?') {
            flush();
            composeRef.current = '';
            term.write(`${ESC}[38;5;68m│ ${ESC}[38;5;110m`);
            continue;
          }
          if (char === '$') {
            // Swallow the marker; the rest of the line goes raw to the shell
            // so zsh keeps its own history and completion.
            atLineStartRef.current = false;
            continue;
          }
        }

        pending += char;
        if (char === '\r' || char === '\n') atLineStartRef.current = true;
        else if (char >= ' ' && char !== BACKSPACE) atLineStartRef.current = false;
      }

      flush();
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
      <header className={`titlebar${permissionMode === 'off' ? ' titlebar--unguarded' : ''}`}>
        <span className="titlebar__name">Helm</span>
        {permissionMode === 'off' && (
          <span className="titlebar__unguarded">approvals off — every tool call runs</span>
        )}
        {cwd && <span className="titlebar__cwd">{displayCwd(cwd, homeRef.current)}</span>}
        {busy && <span className="titlebar__busy">agent working — ^C to stop</span>}
        {exitCode !== null && <span className="titlebar__badge">shell exited ({exitCode})</span>}
      </header>
      <div className="terminal" ref={hostRef} />
      {pendingPermission && (
        <PermissionOverlay
          request={pendingPermission}
          onDecide={(behavior, persist) => decideRef.current?.(behavior, persist)}
        />
      )}
    </div>
  );
}
