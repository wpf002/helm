import type { InputRoute } from '@helm/shared';

/**
 * Decides whether a line of input is a shell command or a prompt.
 *
 * Rules, in order:
 *   1. Leading `$` forces shell. Leading `?` forces agent. Both are stripped.
 *   2. A line whose first token resolves to an executable on PATH, or is a
 *      shell builtin, and which contains no sentence punctuation, is shell.
 *   3. Everything else is agent.
 *
 * Rule 2 is the ambiguous one — `find . -name x` is shell, `find the config
 * file` is not. Bias toward agent on a tie: a misrouted prompt is a wasted
 * turn, a misrouted shell command can be destructive.
 */
export declare function routeInput(line: string, pathBinaries: ReadonlySet<string>): InputRoute;

/** Built once at startup by walking PATH. Refresh on shell profile change. */
export declare function scanPathBinaries(): Promise<Set<string>>;
