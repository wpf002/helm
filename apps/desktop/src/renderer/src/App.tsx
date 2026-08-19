// One xterm buffer per session; the shell and the agent write into the same
// scrollback in real time order. Switching tabs swaps which surface is visible
// rather than replaying anything, so each session keeps its own history.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HelmConfig, PermissionRequest, ShellHookStatus, TranscriptEntry, UsageTotals } from '@helm/shared';
import { PermissionOverlay } from './PermissionOverlay';
import { FindBar } from './FindBar';
import { Preferences } from './Preferences';
import { createTerminal, newSession, replay, type Session } from './session';

const RESIZE_DEBOUNCE_MS = 80;
const ESC = String.fromCharCode(0x1b);
const CTRL_C = String.fromCharCode(0x03);
const BACKSPACE = String.fromCharCode(0x7f);

/**
 * atob() yields a binary string, one char per byte. Feeding that straight back
 * to the pty re-encodes every byte as UTF-8, so `café` came back as `cafÃ©` and
 * any accented filename, CJK or emoji typed at the prompt was mangled.
 */
function decodeBase64Utf8(data: string): string {
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function displayCwd(cwd: string, home: string): string {
  if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}

/** Last path segment, for the tab label. */
function leaf(cwd: string): string {
  if (!cwd) return 'shell';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '/';
}

export default function App(): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const activeRef = useRef(0);
  /** Which session a running agent turn belongs to. */
  const agentOwnerRef = useRef<string | null>(null);
  const permissionRef = useRef<PermissionRequest | null>(null);
  const decideRef = useRef<((b: 'allow' | 'deny', p: boolean) => void) | null>(null);
  const switchRef = useRef<(i: number) => void>(() => {});
  const addRef = useRef<() => void>(() => {});
  const closeRef = useRef<(i: number) => void>(() => {});
  const resumeRef = useRef<() => void>(() => {});

  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((n) => n + 1), []);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [permissionMode, setPermissionMode] = useState<'off' | 'prompt' | 'auto'>('prompt');
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<HelmConfig | null>(null);
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const [hook, setHook] = useState<ShellHookStatus | null>(null);
  const [showFind, setShowFind] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const configRef = useRef<HelmConfig | null>(null);
  const searchRef = useRef<((q: string, d: 'next' | 'previous') => boolean) | null>(null);
  const applyFontRef = useRef<(size: number) => void>(() => {});
  const focusRef = useRef<() => void>(() => {});

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    const active = (): Session | undefined => sessionsRef.current[activeRef.current];
    const byId = (id: string): Session | undefined =>
      sessionsRef.current.find((s) => s.id === id);

    const showActive = (): void => {
      sessionsRef.current.forEach((s, i) => {
        s.host.style.display = i === activeRef.current ? 'block' : 'none';
      });
      const s = active();
      if (!s) return;
      try {
        s.fit.fit();
      } catch {
        /* not laid out yet */
      }
      if (s.id) {
        window.helm.pty.resize(s.id, s.term.cols, s.term.rows);
        window.helm.session.activate(s.id);
      }
      s.term.focus();
      bump();
    };

    const notice = (s: Session, text: string): void => {
      s.term.write(`\r\n${ESC}[38;5;245m${text}${ESC}[0m\r\n`);
    };

    /** Spawns (or respawns) the pty behind a session. */
    const start = async (s: Session): Promise<void> => {
      const info = await window.helm.pty.create({ cols: s.term.cols, rows: s.term.rows });
      if (disposed) return;
      s.id = info.id;
      s.home = info.cwd;
      s.cwd = info.cwd;
      s.title = leaf(info.cwd);
      s.exited = null;
      s.atLineStart = true;
      setPermissionMode(info.permissionMode);
      window.helm.session.activate(s.id);
      bump();
    };

    /** Routes a finished line handed over by the shell's line editor. */
    const submitLine = async (s: Session, line: string): Promise<void> => {
      const route = await window.helm.route.submit(line);
      if (route.target === 'shell') {
        if (s.id) window.helm.pty.write(s.id, route.command + '\n');
        return;
      }
      if (!route.prompt) return;
      s.writer.echoPrompt(route.prompt);
      agentOwnerRef.current = s.id;
      setBusy(true);
      window.helm.agent.prompt(route.prompt);
    };

    const wire = (s: Session): void => {
      s.term.open(s.host);

      s.term.parser.registerOscHandler(7376, (data) => {
        try {
          const words = decodeBase64Utf8(data).split(/\s+/).filter(Boolean);
          if (words.length > 0) window.helm.route.vocabulary(words);
        } catch {
          /* malformed vocabulary report */
        }
        return true;
      });

      s.term.parser.registerOscHandler(7375, () => {
        s.widget = true;
        return true;
      });

      s.term.parser.registerOscHandler(7374, (data) => {
        try {
          void submitLine(s, decodeBase64Utf8(data));
        } catch {
          /* malformed submission */
        }
        return true;
      });

      s.term.parser.registerOscHandler(7373, (data) => {
        try {
          window.helm.route.observe(decodeBase64Utf8(data), 'shell');
        } catch {
          /* malformed report */
        }
        return true;
      });

      s.term.parser.registerOscHandler(7, (data) => {
        const match = /^file:\/\/[^/]*(.*)$/.exec(data);
        if (match && match[1]) {
          try {
            s.cwd = decodeURIComponent(match[1]);
          } catch {
            s.cwd = match[1];
          }
          s.title = leaf(s.cwd);
          bump();
        }
        return false;
      });

      const onInput = s.term.onData((data) => {
        if (permissionRef.current) {
          const key = data[0];
          if (key === 'y') decideRef.current?.('allow', false);
          else if (key === 'a') decideRef.current?.('allow', true);
          else if (key === 'n' || key === CTRL_C) decideRef.current?.('deny', false);
          return;
        }

        if (data.includes(CTRL_C) && s.writer.isStreaming) {
          window.helm.agent.interrupt();
          s.term.write(`\r\n${ESC}[38;5;242m^C interrupted${ESC}[0m\r\n`);
          setBusy(false);
          return;
        }

        if (s.exited !== null) {
          if (data.includes('\r') || data.includes('\n')) {
            notice(s, '[starting a new shell]');
            void start(s);
          }
          return;
        }

        // Input arrives in chunks, not keystrokes, so routing walks the chunk.
        let pending = '';
        const flush = (): void => {
          if (pending && s.id) {
            window.helm.pty.write(s.id, pending);
            pending = '';
          }
        };

        for (const char of data) {
          if (s.compose !== null) {
            if (char === '\r' || char === '\n') {
              s.term.write('\r\n');
              const text = s.compose;
              s.compose = null;
              s.atLineStart = true;
              if (text.trim()) {
                s.writer.beginTurn();
                agentOwnerRef.current = s.id;
                setBusy(true);
                window.helm.route.observe(text, 'agent');
                window.helm.agent.prompt(text);
              }
            } else if (char === BACKSPACE) {
              if (s.compose.length > 0) {
                s.compose = s.compose.slice(0, -1);
                s.term.write('\b \b');
              }
            } else if (char === CTRL_C) {
              s.compose = null;
              s.atLineStart = true;
              s.term.write(`${ESC}[38;5;242m ^C${ESC}[0m\r\n`);
            } else if (char >= ' ') {
              s.compose += char;
              s.term.write(char);
            }
            continue;
          }

          // Prefix fallback, only when the zsh widget is not installed.
          if (s.atLineStart && !s.widget) {
            if (char === '?') {
              flush();
              s.compose = '';
              s.term.write(`${ESC}[38;5;68m│ ${ESC}[38;5;110m`);
              continue;
            }
            if (char === '$') {
              s.atLineStart = false;
              continue;
            }
          }

          pending += char;
          if (char === '\r' || char === '\n') s.atLineStart = true;
          else if (char >= ' ' && char !== BACKSPACE) s.atLineStart = false;
        }
        flush();
      });

      // Copy on select and middle-click paste are what every other terminal
      // does; without them selection is decorative.
      const onSelection = s.term.onSelectionChange(() => {
        if (!configRef.current?.copyOnSelect) return;
        const text = s.term.getSelection();
        if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
      });

      const onMouse = (event: MouseEvent): void => {
        if (event.button !== 1 || !configRef.current?.middleClickPaste) return;
        event.preventDefault();
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text && s.id) window.helm.pty.write(s.id, text);
          })
          .catch(() => undefined);
      };
      s.host.addEventListener('mousedown', onMouse);

      const previous = s.dispose;
      s.dispose = () => {
        onInput.dispose();
        onSelection.dispose();
        s.host.removeEventListener('mousedown', onMouse);
        previous();
      };
    };

    const addSession = async (entries?: readonly TranscriptEntry[]): Promise<void> => {
      const parts = createTerminal(
        configRef.current?.fontSize ?? 13,
        configRef.current?.scrollback ?? 50_000,
      );
      const s = newSession(parts);
      mount.appendChild(s.host);
      sessionsRef.current.push(s);
      activeRef.current = sessionsRef.current.length - 1;
      wire(s);
      showActive();
      if (entries && entries.length > 0) {
        replay(s, entries);
        s.term.write(
          `\r\n${ESC}[38;5;68m│ ${ESC}[38;5;245m` +
            `── replayed transcript above; a fresh shell follows ──${ESC}[0m\r\n\r\n`,
        );
      }
      await start(s);
      showActive();
    };

    const closeSession = async (index: number): Promise<void> => {
      const s = sessionsRef.current[index];
      if (!s) return;
      if (s.id) await window.helm.session.close(s.id);
      s.dispose();
      s.host.remove();
      sessionsRef.current.splice(index, 1);
      if (sessionsRef.current.length === 0) {
        await addSession();
        return;
      }
      activeRef.current = Math.min(activeRef.current, sessionsRef.current.length - 1);
      showActive();
    };

    // ---- global listeners -------------------------------------------------
    const offData = window.helm.pty.onData(({ sessionId, data }) => {
      byId(sessionId)?.term.write(data);
    });

    const offExit = window.helm.pty.onExit(({ sessionId, code }) => {
      const s = byId(sessionId);
      if (!s) return;
      s.exited = code;
      notice(s, `[shell exited with code ${code} — press Enter to start a new one]`);
      bump();
    });

    const offStream = window.helm.agent.onStream((event) => {
      const owner = byId(agentOwnerRef.current ?? '') ?? active();
      owner?.writer.handle(event);
      if (event.kind === 'turn_end') setBusy(false);
    });

    const answerPermission = (behavior: 'allow' | 'deny', persist: boolean): void => {
      const request = permissionRef.current;
      if (!request) return;
      permissionRef.current = null;
      setPendingPermission(null);
      window.helm.agent.resolvePermission({ id: request.id, behavior, persist });
      const s = byId(agentOwnerRef.current ?? '') ?? active();
      s?.term.write(
        `${ESC}[38;5;68m│ ${ESC}[38;5;242m${behavior}${persist ? ' (session)' : ''}` +
          ` ${request.toolName}${request.outOfScope ? ' [out of scope]' : ''}${ESC}[0m\r\n`,
      );
      s?.term.focus();
    };
    decideRef.current = answerPermission;

    const offPermission = window.helm.agent.onPermissionRequest((request) => {
      permissionRef.current = request;
      setPendingPermission(request);
      const s = byId(agentOwnerRef.current ?? '') ?? active();
      s?.term.write(
        `\r\n${ESC}[38;5;68m│ ${ESC}[38;5;215mpermission: ${request.toolName}` +
          `${request.outOfScope ? ' — outside your roots' : ''}${ESC}[0m\r\n`,
      );
    });

    searchRef.current = (query, direction) => {
      const s = active();
      if (!s) return false;
      return direction === 'next'
        ? s.search.findNext(query, { incremental: false })
        : s.search.findPrevious(query, { incremental: false });
    };

    focusRef.current = () => active()?.term.focus();

    applyFontRef.current = (size) => {
      for (const s of sessionsRef.current) {
        s.term.options.fontSize = size;
        try {
          s.fit.fit();
        } catch {
          /* not laid out */
        }
        if (s.id && s.exited === null) window.helm.pty.resize(s.id, s.term.cols, s.term.rows);
      }
    };

    const offFind = window.helm.onFind(() => setShowFind(true));
    const offPrefs = window.helm.onPreferences(() => setShowPrefs(true));
    const offUpdateReq = window.helm.updates.onRequested(() => {
      setShowPrefs(true);
      void window.helm.updates.check().then((r) => setUpdateMessage(r.message));
    });
    const offUsage = window.helm.usage.onChanged((totals) => setUsage(totals));

    const offFont = window.helm.onFontStep((step) => {
      const current = configRef.current?.fontSize ?? 13;
      const next = step === 0 ? 13 : Math.min(24, Math.max(8, current + step));
      void window.helm.config.set({ fontSize: next }).then((updated) => {
        configRef.current = updated;
        setConfig(updated);
        applyFontRef.current(updated.fontSize);
      });
    });

    // Load preferences and status before the first session, so the terminal is
    // created at the right size rather than resized a frame later.
    void (async () => {
      const [loaded, totals, hookStatus] = await Promise.all([
        window.helm.config.get(),
        window.helm.usage.get(),
        window.helm.shellHook.status(),
      ]);
      if (disposed) return;
      configRef.current = loaded;
      setConfig(loaded);
      setUsage(totals);
      setHook(hookStatus);
      if (loaded.checkForUpdates) {
        void window.helm.updates.check().then((r) => {
          if (r.checked && r.behind > 0) setUpdateMessage(r.message);
        });
      }
    })();

    const offClear = window.helm.onClear(() => active()?.term.clear());
    const offNewTab = window.helm.session.onNew(() => void addSession());
    const offCloseTab = window.helm.session.onClose(() => void closeSession(activeRef.current));
    const doResume = (): void => {
      void (async () => {
        const list = await window.helm.session.transcripts();
        const newest = Array.isArray(list) ? list[0] : undefined;
        if (!newest) {
          active()?.term.write(`\r\n${ESC}[38;5;245m[no previous session to resume]${ESC}[0m\r\n`);
          return;
        }
        const entries = await window.helm.session.transcript(newest.id);
        await addSession(entries);
      })();
    };
    resumeRef.current = doResume;
    const offResume = window.helm.session.onResume(doResume);

    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const s = active();
        if (!s) return;
        try {
          s.fit.fit();
        } catch {
          return;
        }
        if (s.id && s.exited === null) window.helm.pty.resize(s.id, s.term.cols, s.term.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(mount);

    switchRef.current = (index: number) => {
      if (index < 0 || index >= sessionsRef.current.length) return;
      activeRef.current = index;
      showActive();
    };
    addRef.current = () => void addSession();
    closeRef.current = (index: number) => void closeSession(index);

    void addSession();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      observer.disconnect();
      offData();
      offExit();
      offStream();
      offPermission();
      offClear();
      offNewTab();
      offCloseTab();
      offResume();
      offFind();
      offPrefs();
      offFont();
      offUsage();
      offUpdateReq();
      for (const s of sessionsRef.current) s.dispose();
      sessionsRef.current = [];
    };
  }, [bump]);

  const sessions = sessionsRef.current;
  const current = sessions[activeRef.current];

  return (
    <div className="app">
      <header className={`titlebar${permissionMode === 'off' ? ' titlebar--unguarded' : ''}`}>
        <span className="titlebar__name">Helm</span>
        {permissionMode === 'off' && (
          <span className="titlebar__unguarded">approvals off</span>
        )}
        <nav className="tabs">
          {sessions.map((s, i) => (
            <button
              key={s.key}
              className={`tab${i === activeRef.current ? ' tab--active' : ''}`}
              onClick={() => switchRef.current(i)}
              title={s.cwd}
            >
              {s.title}
              {s.exited !== null && <span className="tab__dead">✕</span>}
              {sessions.length > 1 && (
                <span
                  className="tab__close"
                  role="button"
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeRef.current(i);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          <button
            className="tab tab--new"
            onClick={() => addRef.current()}
            title="New session (⌘T)"
          >
            +
          </button>
          <button
            className="tab tab--resume"
            onClick={() => resumeRef.current()}
            title="Resume previous session (⌘⇧R)"
          >
            ⟲
          </button>
        </nav>
        {current?.cwd && (
          <span className="titlebar__cwd">{displayCwd(current.cwd, current.home)}</span>
        )}
        {busy && <span className="titlebar__busy">agent working — ^C to stop</span>}
        {hook && !hook.installed && (
          <button
            className="titlebar__nudge"
            onClick={() => setShowPrefs(true)}
            title="Plain English is not routed to the agent until the shell integration is installed"
          >
            shell integration off
          </button>
        )}
        {usage && usage.turns > 0 && (
          <button
            className="titlebar__usage"
            onClick={() => setShowPrefs(true)}
            title={`${usage.turns} turns today · ${usage.input + usage.cacheRead + usage.cacheWrite} in / ${usage.output} out (estimate)`}
          >
            ${usage.costUsd.toFixed(2)} today
          </button>
        )}
      </header>
      <div className="surfaces" ref={mountRef} />
      {showFind && (
        <FindBar
          onSearch={(query, direction) => searchRef.current?.(query, direction) ?? false}
          onClose={() => {
            setShowFind(false);
            focusRef.current();
          }}
        />
      )}
      {showPrefs && config && (
        <Preferences
          config={config}
          hook={hook}
          updateMessage={updateMessage}
          onChange={(patch) => {
            void window.helm.config.set(patch).then((updated) => {
              configRef.current = updated;
              setConfig(updated);
              if (patch.fontSize !== undefined) applyFontRef.current(updated.fontSize);
            });
          }}
          onInstallHook={() => {
            void window.helm.shellHook.install().then((status) => setHook(status));
          }}
          onCheckUpdates={() => {
            setUpdateMessage('Checking…');
            void window.helm.updates.check().then((r) => setUpdateMessage(r.message));
          }}
          onClose={() => setShowPrefs(false)}
        />
      )}
      {pendingPermission && (
        <PermissionOverlay
          request={pendingPermission}
          onDecide={(behavior, persist) => decideRef.current?.(behavior, persist)}
        />
      )}
    </div>
  );
}
