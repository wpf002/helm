// Preferences. Everything here used to live only in .env, which meant editing
// a file and restarting to change the font size.
//
// Credentials and roots deliberately stay in .env: they are needed before a
// window exists, and they are not things you toggle mid-session.

import type { HelmConfig, ShellHookStatus } from '@helm/shared';

interface Props {
  config: HelmConfig;
  hook: ShellHookStatus | null;
  updateMessage: string | null;
  onChange: (patch: Partial<HelmConfig>) => void;
  onInstallHook: () => void;
  onCheckUpdates: () => void;
  onClose: () => void;
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label className="pref__row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="pref__label">{label}</span>
        <span className="pref__hint">{hint}</span>
      </span>
    </label>
  );
}

export function Preferences({
  config,
  hook,
  updateMessage,
  onChange,
  onInstallHook,
  onCheckUpdates,
  onClose,
}: Props): JSX.Element {
  return (
    <div className="pref" onClick={onClose}>
      <div className="pref__panel" onClick={(e) => e.stopPropagation()}>
        <header className="pref__head">
          <h3>Preferences</h3>
          <button className="pref__x" onClick={onClose}>
            ×
          </button>
        </header>

        <section className="pref__section">
          <h4 className="pref__title">Shell integration</h4>
          {hook?.installed ? (
            <p className="pref__ok">
              Installed. Plain English is routed to the agent; everything else runs in the shell.
            </p>
          ) : (
            <>
              <p className="pref__warn">
                Not installed. Without it Helm cannot see the finished command line, so plain
                English is <strong>not</strong> routed to the agent — only the <code>?</code> prefix
                works.
              </p>
              <button className="pref__action" onClick={onInstallHook}>
                Add to ~/.zshrc
              </button>
              <p className="pref__hint">
                Appends a source line for <code>{hook?.hookPath ?? 'helm-osc7.zsh'}</code>. Existing
                contents are never rewritten. Open a new shell afterwards.
              </p>
            </>
          )}
        </section>

        <section className="pref__section">
          <h4 className="pref__title">Terminal</h4>
          <label className="pref__row">
            <input
              type="range"
              min={8}
              max={24}
              value={config.fontSize}
              onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
            />
            <span>
              <span className="pref__label">Font size — {config.fontSize}px</span>
              <span className="pref__hint">⌘+ / ⌘− / ⌘0</span>
            </span>
          </label>
          <Toggle
            label="Copy on select"
            hint="Selecting text puts it on the clipboard, as most terminals do."
            checked={config.copyOnSelect}
            onChange={(copyOnSelect) => onChange({ copyOnSelect })}
          />
          <Toggle
            label="Middle-click pastes"
            hint="Pastes the clipboard at the prompt."
            checked={config.middleClickPaste}
            onChange={(middleClickPaste) => onChange({ middleClickPaste })}
          />
        </section>

        <section className="pref__section">
          <h4 className="pref__title">Approvals</h4>
          <label className="pref__row">
            <select
              className="pref__select"
              value={config.permissionMode}
              onChange={(e) =>
                onChange({ permissionMode: e.target.value as 'off' | 'prompt' | 'auto' })
              }
            >
              <option value="prompt">Ask before anything out of scope</option>
              <option value="auto">Only ask before changes outside my roots</option>
              <option value="off">Never ask</option>
            </select>
            <span>
              <span className="pref__label">
                {config.permissionMode === 'prompt' && 'Every out-of-scope call stops for a decision.'}
                {config.permissionMode === 'auto' && 'Reads and in-scope work run silently.'}
                {config.permissionMode === 'off' && 'Nothing is gated. The title bar turns red.'}
              </span>
              <span className="pref__hint">
                {config.permissionMode === 'auto' &&
                  'Anything that could change a file outside your roots still stops.'}
                {config.permissionMode === 'off' &&
                  'With Full Disk Access granted this reaches your whole machine.'}
                {config.permissionMode === 'prompt' &&
                  'Safest, and the noisiest.'}
              </span>
            </span>
          </label>
        </section>

        <section className="pref__section">
          <h4 className="pref__title">Agent</h4>
          <Toggle
            label="Notify when hidden"
            hint="A turn that finishes behind a hidden window may as well not have finished."
            checked={config.notifyWhenHidden}
            onChange={(notifyWhenHidden) => onChange({ notifyWhenHidden })}
          />
        </section>

        <section className="pref__section">
          <h4 className="pref__title">Updates</h4>
          <Toggle
            label="Check on launch"
            hint="Compares your build against origin/main. Never downloads or installs."
            checked={config.checkForUpdates}
            onChange={(checkForUpdates) => onChange({ checkForUpdates })}
          />
          <button className="pref__action" onClick={onCheckUpdates}>
            Check now
          </button>
          {updateMessage && <p className="pref__hint">{updateMessage}</p>}
        </section>

        <footer className="pref__foot">
          Stored in <code>~/.helm/config.json</code>. Credentials and roots stay in{' '}
          <code>.env</code>.
        </footer>
      </div>
    </div>
  );
}
