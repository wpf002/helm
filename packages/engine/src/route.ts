import { readdir } from 'node:fs/promises';
import { delimiter } from 'node:path';
import type { Factor, InputRoute } from '@helm/shared';

/**
 * Builtins are not on PATH but are unmistakably shell. This is the fallback
 * only: when scripts/helm-osc7.zsh is sourced the shell reports its own
 * vocabulary — builtins, reserved words, functions and the user's aliases —
 * which no hand-maintained list can match. An earlier bash-centric version of
 * this list sent `print`, `setopt` and `autoload` to the agent, costing an API
 * turn and a permission prompt each.
 */
const SHELL_BUILTINS = new Set([
  // POSIX / bash
  'cd', 'export', 'source', 'alias', 'unalias', 'set', 'unset', 'echo', 'pwd',
  'exit', 'jobs', 'fg', 'bg', 'kill', 'wait', 'type', 'which', 'command',
  'history', 'eval', 'exec', 'test', 'read', 'shift', 'trap', 'umask',
  'ulimit', 'local', 'return', 'declare', 'typeset', 'let', 'pushd', 'popd',
  'dirs', 'hash', 'times', 'time', 'builtin', 'enable', 'disown', 'suspend',
  'getopts', 'printf', 'true', 'false', 'break', 'continue', 'readonly',
  // zsh
  'print', 'setopt', 'unsetopt', 'autoload', 'whence', 'bindkey', 'zmodload',
  'zstyle', 'compdef', 'compinit', 'zle', 'emulate', 'functions', 'integer',
  'float', 'noglob', 'nocorrect', 'zcompile', 'zparseopts', 'zregexparse',
  'add-zsh-hook', 'vared', 'fc', 'rehash', 'ttyctl', 'sched', 'limit',
  'unlimit', 'unfunction', 'unhash', 'where', 'zargs', 'zed', 'zmv',
  // reserved words
  'if', 'fi', 'else', 'elif', 'for', 'while', 'until', 'do', 'done', 'case',
  'esac', 'function', 'select', 'repeat', 'foreach', 'end', 'coproc',
]);

/**
 * Function words that almost never appear in a shell command but are the
 * backbone of an English sentence. This is the signal that separates
 * `find . -name x` from `find the config file` — both start with a token that
 * resolves on PATH, so the first token alone cannot decide.
 */
const PROSE_MARKERS = new Set([
  'the', 'a', 'an', 'my', 'your', 'our', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did',
  'what', 'why', 'how', 'when', 'where', 'which', 'who', 'whom', 'whose',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'please', 'me', 'us', 'it', 'them', 'him', 'her', 'i', 'you', 'we', 'they',
  'and', 'but', 'or', 'if', 'then', 'than', 'because', 'about', 'into',
  'from', 'with', 'without', 'for', 'to', 'of', 'in', 'on', 'at', 'by',
]);

/** Syntax that only a shell command carries. */
function shellSyntax(line: string, tokens: readonly string[]): string[] {
  const seen: string[] = [];
  if (/(^|\s)-{1,2}[A-Za-z0-9]/.test(line)) seen.push('flag');
  if (/[|;]|&&|\|\|/.test(line)) seen.push('operator');
  if (/(^|\s)[<>]|>>/.test(line)) seen.push('redirect');
  if (/(^|\s)(\.{1,2}\/|\/|~\/)/.test(line)) seen.push('path');
  if (/\$\{?[A-Za-z_]/.test(line)) seen.push('variable');
  if (/[*?[\]]/.test(line) && tokens.length > 1) seen.push('glob');
  if (/`|\$\(/.test(line)) seen.push('substitution');
  if (/[A-Za-z0-9._-]+=[^\s]/.test(line)) seen.push('assignment');
  if (/(^|\s)['"]/.test(line)) seen.push('quoted');
  return seen;
}

/**
 * Blanks quoted spans. Text inside quotes is an argument, not grammar:
 * `git commit -m 'fix the thing'` is a command whose message happens to
 * contain English, and counting those words as prose sent it to the agent.
 */
function withoutQuoted(line: string): string {
  return line.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}

/** Punctuation that reads as a sentence rather than an argument. */
function sentencePunctuation(line: string): string[] {
  const seen: string[] = [];
  if (/\?\s*$/.test(line)) seen.push('trailing-question-mark');
  if (/[a-z]\.\s*$/.test(line) && line.split(/\s+/).length > 2) seen.push('trailing-period');
  if (/!\s*$/.test(line) && !/\bhistory\b/.test(line)) seen.push('trailing-exclamation');
  if (/,\s/.test(line)) seen.push('comma');
  if (/\b(can't|won't|don't|isn't|doesn't|it's|i'm|i'd|let's)\b/i.test(line)) {
    seen.push('contraction');
  }
  return seen;
}

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
export function routeInput(line: string, pathBinaries: ReadonlySet<string>): InputRoute {
  return routeInputWithFactors(line, pathBinaries).route;
}

/** The same decision with the reasoning attached, for the routing log. */
export function routeInputWithFactors(
  line: string,
  pathBinaries: ReadonlySet<string>,
): { route: InputRoute; factors: Factor[] } {
  const factors: Factor[] = [];
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    factors.push({ rule: 'empty-line', detail: 'Nothing to route.', effect: 'info' });
    return { route: { target: 'agent', prompt: '' }, factors };
  }

  // ---- rule 1: explicit prefixes win outright.
  if (trimmed.startsWith('$')) {
    factors.push({ rule: 'explicit-shell-prefix', detail: 'Line begins with $.', effect: 'info' });
    return { route: { target: 'shell', command: trimmed.slice(1).trim() }, factors };
  }
  if (trimmed.startsWith('?')) {
    factors.push({ rule: 'explicit-agent-prefix', detail: 'Line begins with ?.', effect: 'info' });
    return { route: { target: 'agent', prompt: trimmed.slice(1).trim() }, factors };
  }

  // ---- rule 2: does it look like a command?
  const tokens = trimmed.split(/\s+/);
  // `FOO=bar cmd` puts an assignment where the command would be; the shell
  // strips those before resolving, so we do too.
  let commandIndex = 0;
  while (
    commandIndex < tokens.length - 1 &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex] ?? '')
  ) {
    commandIndex++;
  }
  // Operators bind to the token without whitespace: `false;` and `ls;echo`
  // both hid the command name, so lookup failed and the line went to the
  // agent — which then tried to run it as a tool call.
  const first = (tokens[commandIndex] ?? '').split(/[;|&<>()]/)[0] ?? '';
  const head = first.replace(/^.*\//, '');
  const isBuiltin = SHELL_BUILTINS.has(first);
  const onPath = pathBinaries.has(first) || pathBinaries.has(head);
  const looksExecutablePath = /^(\.{1,2}\/|\/|~\/)/.test(first);

  if (!isBuiltin && !onPath && !looksExecutablePath) {
    factors.push({
      rule: 'first-token-unknown',
      detail: `"${first}" is not a shell builtin and does not resolve on PATH.`,
      effect: 'info',
    });
    return { route: { target: 'agent', prompt: trimmed }, factors };
  }

  factors.push({
    rule: isBuiltin ? 'first-token-builtin' : 'first-token-on-path',
    detail: `"${first}" ${isBuiltin ? 'is a shell builtin' : 'resolves to an executable'}.`,
    effect: 'info',
  });

  /**
   * Control structures and operators are shell grammar, not English. `for f in
   * *; do ...; done` is full of words that look like prose — "in", "do" — but
   * the construct itself is unambiguous, so it must outrank the prose check.
   */
  const RESERVED_STARTS = new Set([
    'if', 'for', 'while', 'until', 'case', 'select', 'repeat', 'function',
    'foreach', 'coproc', 'do', 'then',
  ]);
  if (RESERVED_STARTS.has(first)) {
    factors.push({
      rule: 'shell-control-structure',
      detail: `"${first}" opens a shell control structure.`,
      effect: 'info',
    });
    return { route: { target: 'shell', command: trimmed }, factors };
  }

  const punctuation = sentencePunctuation(withoutQuoted(trimmed));
  const prose = withoutQuoted(trimmed)
    .split(/\s+/)
    .slice(commandIndex + 1)
    .filter((word) => PROSE_MARKERS.has(word.toLowerCase()));
  const syntax = shellSyntax(trimmed, tokens);

  if (syntax.length > 0) {
    factors.push({
      rule: 'shell-syntax-present',
      detail: `Carries shell syntax: ${syntax.join(', ')}.`,
      effect: 'info',
    });
  }

  if (punctuation.length > 0) {
    factors.push({
      rule: 'sentence-punctuation',
      detail: `Reads as a sentence: ${punctuation.join(', ')}.`,
      effect: 'info',
    });
    return { route: { target: 'agent', prompt: trimmed }, factors };
  }

  // Operators and redirects are grammar no sentence carries. They do outrank
  // prose markers, unlike a bare path — `find the file in /tmp` has a path and
  // is still not a command, but `cat a | grep b` cannot be anything else.
  const strongSyntax = syntax.filter((s) =>
    ['operator', 'redirect', 'substitution'].includes(s),
  );
  if (strongSyntax.length > 0) {
    factors.push({
      rule: 'shell-grammar',
      detail: `Carries shell grammar no sentence would: ${strongSyntax.join(', ')}.`,
      effect: 'info',
    });
    return { route: { target: 'shell', command: trimmed }, factors };
  }

  if (prose.length > 0) {
    // Shell syntax does not rescue a line full of function words: `find the
    // file in /tmp` has a path and still is not a command.
    factors.push({
      rule: 'prose-markers',
      detail: `Contains English function words: ${prose.slice(0, 4).join(', ')}.`,
      effect: 'info',
    });
    return { route: { target: 'agent', prompt: trimmed }, factors };
  }

  // The first token resolves, nothing reads as a sentence, and no function
  // words appear outside quotes. An earlier version also demanded the line be
  // short, which sent `echo one two three four five six` to the agent —
  // length is not evidence of prose.
  factors.push({
    rule: 'resolves-and-clean',
    detail: 'First token resolves and nothing reads as prose.',
    effect: 'info',
  });
  return { route: { target: 'shell', command: trimmed }, factors };
}

/** Built once at startup by walking PATH. Refresh on shell profile change. */
export async function scanPathBinaries(): Promise<Set<string>> {
  const found = new Set<string>();
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);

  await Promise.all(
    dirs.map(async (dir) => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return; // A PATH entry that does not exist is normal.
      }
      for (const entry of entries) {
        // Trust the directory listing rather than stat-ing thousands of files;
        // a name in a PATH directory is what the shell would try to run.
        found.add(entry);
      }
    }),
  );

  // Shell functions and aliases live in the user's profile, not on PATH. The
  // builtins are the portion we can know without asking the shell.
  for (const builtin of SHELL_BUILTINS) found.add(builtin);

  return found;
}
