// The approval UI. It has to be readable by anyone, at a glance: what Helm
// wants to do, the exact command or file, and why it is asking — in plain
// words. The technical evidence (resolved paths, the rules that fired, the raw
// input) is still here, one click down, for whoever wants to check the work.

import type { PermissionRequest } from '@helm/shared';

interface Props {
  request: PermissionRequest;
  /** The highlighted choice, moved with the arrow keys: 0 yes, 1 yes for the session, 2 no. */
  selected: number;
  onDecide: (behavior: 'allow' | 'deny', persist: boolean) => void;
}

/** Plain text with `code` spans, as the engine writes its reasons. */
function inline(text: string): (string | JSX.Element)[] {
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

function shorten(path: string, home: string): string {
  return home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

function field(input: unknown, key: string): string | null {
  return typeof input === 'object' && input !== null && typeof (input as Record<string, unknown>)[key] === 'string'
    ? ((input as Record<string, unknown>)[key] as string)
    : null;
}

export function PermissionOverlay({ request, selected, onDecide }: Props): JSX.Element {
  const home = request.roots[0] ?? '';
  const { outOfScope, affectedPaths, factors } = request;
  const command = field(request.input, 'command');
  // The model says what each command is for; that is the line a person reads first.
  const purpose = field(request.input, 'description');
  // Asking because the command can change things is normal; reaching outside
  // the allowed folders, or using administrator rights, gets the warning look.
  const risky = outOfScope || /administrator/.test(request.reason);

  return (
    <div className="perm" role="dialog" aria-modal="true" aria-labelledby="perm-title">
      <div className={`perm__card${risky ? ' perm__card--warn' : ''}`}>
        <header className="perm__head">
          <span className="perm__mark" aria-hidden="true">
            ?
          </span>
          <div>
            <h3 id="perm-title" className="perm__title">
              {request.summary}
            </h3>
            {purpose && (
              <p className="perm__purpose">
                <span className="perm__lead">To:</span> {purpose}
              </p>
            )}
            <p className="perm__reason">
              <span className="perm__lead">Why it&rsquo;s asking:</span> {inline(request.reason)}
            </p>
          </div>
        </header>

        {command !== null ? (
          <pre className="perm__command">
            <span className="perm__prompt" aria-hidden="true">
              ${' '}
            </span>
            {command}
          </pre>
        ) : affectedPaths.length > 0 ? (
          <ul className="perm__paths">
            {affectedPaths.map((path) => (
              <li key={path} className="perm__path">
                {shorten(path, home)}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="perm__choices">
          {[
            { label: 'Yes, run it', key: 'y', decide: () => onDecide('allow', false) },
            {
              label: `Yes, and don’t ask again for ${request.sessionScope} until you quit Helm`,
              key: 'a',
              decide: () => onDecide('allow', true),
            },
            { label: 'No', key: 'n', decide: () => onDecide('deny', false) },
          ].map((choice, index) => (
            <button
              key={choice.key}
              className={`perm__choice${index === selected ? ' perm__choice--selected' : ''}`}
              onClick={choice.decide}
            >
              <span className="perm__dot" aria-hidden="true">
                {index === selected ? '●' : ''}
              </span>
              <span className="perm__num">{index + 1}.</span>
              <span className="perm__text">{choice.label}</span>
              <kbd>{choice.key}</kbd>
            </button>
          ))}
          <p className="perm__keys">↑ ↓ to move · Enter to choose · Esc for no</p>
        </div>

        <details className="perm__details">
          <summary>Details</summary>
          {affectedPaths.length > 0 && command !== null && (
            <>
              <h4 className="perm__label">Files it names</h4>
              <ul className="perm__paths perm__paths--quiet">
                {affectedPaths.map((path) => (
                  <li key={path} className="perm__path">
                    {shorten(path, home)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {factors.length > 0 && (
            <>
              <h4 className="perm__label">How Helm decided</h4>
              <ul className="perm__factors">
                {factors.map((factor, index) => (
                  <li key={`${factor.rule}-${index}`} className={`perm__factor perm__factor--${factor.effect}`}>
                    <code className="perm__rule">{factor.rule}</code>
                    <span className="perm__detail">{inline(factor.detail)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4 className="perm__label">Exactly what was sent ({request.toolName})</h4>
          <pre className="perm__raw">{JSON.stringify(request.input, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}
