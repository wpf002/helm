// The approval UI. Shows what the call would actually touch — resolved,
// symlink-followed absolute paths — instead of the raw JSON the SDK hands over.
// This is the one thing Helm has that the official app does not, so it has to
// answer "what does this reach, and is it outside my roots" at a glance.

import type { PermissionRequest } from '@helm/shared';

interface Props {
  request: PermissionRequest;
  onDecide: (behavior: 'allow' | 'deny', persist: boolean) => void;
}

function shorten(path: string, home: string): string {
  return home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

export function PermissionOverlay({ request, onDecide }: Props): JSX.Element {
  const home = request.roots[0] ?? '';
  const { outOfScope, affectedPaths, factors } = request;

  // A call whose paths could not be resolved is not the same as one that
  // touches nothing, and must not read as safe.
  const unresolved = affectedPaths.length === 0 && outOfScope;

  return (
    <div className="perm">
      <div className={`perm__card${outOfScope ? ' perm__card--warn' : ''}`}>
        <header className="perm__head">
          <span className="perm__tool">{request.toolName}</span>
          {outOfScope ? (
            <span className="perm__flag perm__flag--out">
              {unresolved ? 'paths unresolved' : 'outside your roots'}
            </span>
          ) : (
            <span className="perm__flag perm__flag--in">within your roots</span>
          )}
        </header>

        <section className="perm__section">
          <h4 className="perm__label">
            {affectedPaths.length > 0 ? 'Resolved paths' : 'No paths resolved'}
          </h4>
          {affectedPaths.length > 0 ? (
            <ul className="perm__paths">
              {affectedPaths.map((path) => (
                <li key={path} className="perm__path">
                  {shorten(path, home)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="perm__none">
              {unresolved
                ? 'This call could not be reduced to specific paths. It may reach anywhere.'
                : 'This call declares no filesystem paths.'}
            </p>
          )}
        </section>

        {factors.length > 0 && (
          <section className="perm__section">
            <h4 className="perm__label">Why</h4>
            <ul className="perm__factors">
              {factors.map((factor, index) => (
                <li key={`${factor.rule}-${index}`} className={`perm__factor perm__factor--${factor.effect}`}>
                  <code className="perm__rule">{factor.rule}</code>
                  <span className="perm__detail">{factor.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <details className="perm__raw">
          <summary>Raw input</summary>
          <pre>{JSON.stringify(request.input, null, 2)}</pre>
        </details>

        <footer className="perm__actions">
          <button className="perm__btn perm__btn--deny" onClick={() => onDecide('deny', false)}>
            Deny <kbd>n</kbd>
          </button>
          <button className="perm__btn" onClick={() => onDecide('allow', true)}>
            Allow for session <kbd>a</kbd>
          </button>
          <button
            className={`perm__btn perm__btn--primary${outOfScope ? ' perm__btn--risky' : ''}`}
            onClick={() => onDecide('allow', false)}
          >
            Allow once <kbd>y</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
