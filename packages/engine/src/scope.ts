import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Factor, ScopeVerdict } from '@helm/shared';

/**
 * Which argument of each tool names a path. Anything not listed falls through
 * to a generic sweep, so a tool added later fails loud (unknown paths) rather
 * than silently reporting "touches nothing".
 */
const PATH_KEYS: Record<string, string[]> = {
  Read: ['file_path', 'notebook_path'],
  Write: ['file_path'],
  Edit: ['file_path', 'notebook_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
  LS: ['path'],
};

/** Keys that name a path in any tool, used for the generic sweep. */
const GENERIC_KEYS = ['file_path', 'notebook_path', 'path', 'cwd', 'directory'];

/**
 * Commands that report on the system and cannot change it. Treating `uptime`
 * exactly like `rm -rf` made every prompt uninformative — if everything is
 * flagged, the flag means nothing and you learn to click through it, which is
 * worse than not asking.
 */
const READ_ONLY_COMMANDS = new Set([
  // system state
  'uptime', 'date', 'whoami', 'id', 'hostname', 'uname', 'sw_vers', 'w', 'who',
  'ps', 'top', 'vm_stat', 'df', 'du', 'sysctl', 'pmset', 'iostat', 'nettop',
  'system_profiler', 'ioreg', 'launchctl', 'sysdiagnose', 'memory_pressure',
  'netstat', 'ifconfig', 'arp', 'route', 'scutil', 'networkQuality', 'lsof',
  'defaults', 'stat', 'file', 'which', 'whence', 'type', 'command', 'env',
  'printenv', 'locale', 'groups', 'hostinfo', 'nproc', 'sw_vers',
  // reading and shaping text
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'tr',
  'column', 'fold', 'nl', 'rev', 'jq', 'yq', 'echo', 'printf', 'basename',
  'dirname', 'realpath', 'seq', 'true', 'false', 'awk', 'grep', 'egrep',
  'fgrep', 'rg', 'ag', 'diff', 'cmp', 'md5', 'shasum', 'base64', 'xxd', 'od',
  'ls', 'tree', 'pwd', 'readlink',
]);

/**
 * Tools where the subcommand decides. `git status` and `npm view` only report;
 * `git push` and `npm install` do not. Classifying the whole binary either way
 * would be wrong, and treating them all as mutating meant the most common
 * informational commands prompted every time.
 */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    'status', 'log', 'diff', 'show', 'branch', 'remote', 'tag', 'blame',
    'describe', 'shortlog', 'ls-files', 'ls-remote', 'rev-parse', 'rev-list',
    'cat-file', 'reflog', 'stash', 'whatchanged', 'grep', 'count-objects',
  ]),
  npm: new Set(['view', 'ls', 'list', 'outdated', 'search', 'info', 'why', 'ping', 'root', 'prefix', 'bin']),
  pnpm: new Set(['view', 'ls', 'list', 'outdated', 'why', 'root', 'bin', 'licenses']),
  yarn: new Set(['info', 'list', 'outdated', 'why']),
  brew: new Set(['list', 'info', 'search', 'outdated', 'deps', 'config', 'doctor', '--version']),
  docker: new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'port', 'history']),
  kubectl: new Set(['get', 'describe', 'logs', 'top', 'explain', 'version', 'config', 'api-resources']),
  systemctl: new Set(['status', 'list-units', 'is-active', 'is-enabled', 'show']),
  cargo: new Set(['tree', 'search', 'metadata', 'version']),
  go: new Set(['version', 'env', 'list']),
  python3: new Set(['--version', '-V']),
  node: new Set(['--version', '-v']),
  pip: new Set(['list', 'show', 'freeze', 'search']),
};

/** Anything here can change state even when the head looks harmless. */
const MUTATING_PATTERN =
  /(^|\s)(>{1,2}(?!\s*\/dev\/null))|(^|\s)(rm|mv|cp|mkdir|rmdir|chmod|chown|ln|touch|tee|dd|kill|killall|pkill|shutdown|reboot|sudo|installer|defaults\s+write|launchctl\s+(load|unload|bootout))(\s|$)|(\s)-i(\s|$)|--in-place|-delete|-exec/;

export type CommandKind = 'read-only' | 'mutating';

/**
 * Deterministic read/write classification for a shell command. Every segment
 * of a pipeline must be a known read-only command, and nothing may redirect
 * output anywhere but /dev/null.
 */
export function classifyCommand(command: string): CommandKind {
  if (MUTATING_PATTERN.test(command)) return 'mutating';

  const segments = command
    .split(/\||;|&&|\|\||\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return 'mutating';

  for (const segment of segments) {
    // Skip leading VAR=value assignments, as the shell does.
    const tokens = segment.split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < tokens.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index++;
    const bare = (tokens[index] ?? '').replace(/^.*\//, '');
    if (READ_ONLY_COMMANDS.has(bare)) continue;

    const subcommands = READ_ONLY_SUBCOMMANDS[bare];
    if (subcommands) {
      // The first token that is not a flag is the subcommand.
      const sub = tokens.slice(index + 1).find((tok) => !tok.startsWith('-')) ?? tokens[index + 1] ?? '';
      if (subcommands.has(sub)) continue;
      return 'mutating';
    }
    return 'mutating';
  }
  return 'read-only';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Expands a leading ~ before resolution; realpath will not do it for us. */
function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

/**
 * Pulls candidate paths out of a shell command. This is a heuristic and is
 * treated as one: anything it finds widens the set of paths shown to the user,
 * and a command it cannot parse is reported as unresolved rather than as safe.
 */
function pathsFromCommand(command: string): string[] {
  const found: string[] = [];
  // Absolute paths, ~-relative paths, and ./ or ../ relative paths.
  const re = /(?:^|[\s'"=<>|&;()])((?:~\/|\.\.?\/|\/)[^\s'"<>|&;()]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const candidate = match[1];
    if (candidate) found.push(candidate);
  }
  return found;
}

function collectRaw(toolName: string, input: unknown): { raw: string[]; command?: string } {
  if (!isRecord(input)) return { raw: [] };

  const raw: string[] = [];
  const keys = PATH_KEYS[toolName] ?? GENERIC_KEYS;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) raw.push(value);
  }

  // Bash is the wide one: the command string can name anything.
  const command = typeof input['command'] === 'string' ? input['command'] : undefined;
  if (command) raw.push(...pathsFromCommand(command));

  return command === undefined ? { raw } : { raw, command };
}

/**
 * Resolves a path to its real location. A path that does not exist yet (a file
 * about to be written) has no realpath, so the nearest existing ancestor is
 * resolved instead and the remainder appended — otherwise a write to a new file
 * inside a symlinked directory would escape the containment check.
 */
async function realpathOrNearest(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    const resolvedParent = await realpathOrNearest(parent);
    return resolve(resolvedParent, absolute.slice(parent.length + 1));
  }
}

/**
 * Resolves the absolute paths a tool call would touch and flags anything
 * outside the configured roots. Runs before the permission prompt renders so
 * the approval UI can show scope violations rather than a raw JSON blob.
 *
 * Symlinks are resolved before the containment check. Skipping that is how
 * scope guards get walked out of.
 */
export async function resolveAffectedPaths(
  toolName: string,
  input: unknown,
  cwd: string,
): Promise<string[]> {
  const { raw } = collectRaw(toolName, input);
  const out: string[] = [];
  for (const value of raw) {
    const expanded = expandHome(value);
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    out.push(await realpathOrNearest(absolute));
  }
  return [...new Set(out)];
}

/** True when `path` is inside one of `roots`, comparing real locations. */
export async function isWithinRoots(path: string, roots: readonly string[]): Promise<boolean> {
  if (roots.length === 0) return false;
  const target = await realpathOrNearest(isAbsolute(path) ? path : resolve(path));
  for (const root of roots) {
    const realRoot = await realpathOrNearest(resolve(expandHome(root)));
    if (target === realRoot) return true;
    // The separator matters: /home/willfoti-evil must not match /home/willfoti.
    if (target.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return true;
  }
  return false;
}

/**
 * The full deterministic verdict, with the reasoning attached. No model is
 * consulted at any point — this is the control path.
 */
export async function evaluateScope(
  toolName: string,
  input: unknown,
  cwd: string,
  roots: readonly string[],
): Promise<ScopeVerdict> {
  const factors: Factor[] = [];
  const { raw, command } = collectRaw(toolName, input);

  if (roots.length === 0) {
    factors.push({
      rule: 'no-roots-configured',
      detail: 'No roots are configured, so nothing can be judged in scope.',
      effect: 'out-of-scope',
    });
  }

  if (raw.length === 0) {
    factors.push({
      rule: command ? 'command-paths-unparsed' : 'no-path-arguments',
      detail: command
        ? `No filesystem paths could be parsed out of: ${command.slice(0, 120)}`
        : `${toolName} declared no path arguments.`,
      effect: 'info',
    });
    if (command && classifyCommand(command) === 'read-only') {
      return {
        paths: [],
        outOfScope: false,
        factors: [
          ...factors,
          {
            rule: 'read-only-command',
            detail: 'Every part of this pipeline only reports state; nothing here can change it.',
            effect: 'in-scope',
          },
        ],
      };
    }

    // A command whose paths cannot be read is not evidence of safety. It is
    // reported as unresolved so the prompt can say so plainly.
    return {
      paths: [],
      outOfScope: command !== undefined,
      factors: command
        ? [
            ...factors,
            {
              rule: 'unresolved-command',
              detail: 'A shell command with no parsable paths can still reach anywhere.',
              effect: 'out-of-scope',
            },
          ]
        : factors,
    };
  }

  const paths: string[] = [];
  let outOfScope = false;

  for (const value of raw) {
    const expanded = expandHome(value);
    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    const real = await realpathOrNearest(absolute);
    if (!paths.includes(real)) paths.push(real);

    if (real !== absolute) {
      factors.push({
        rule: 'symlink-resolved',
        detail: `${absolute} resolves to ${real}`,
        effect: 'info',
      });
    }

    const inside = await isWithinRoots(real, roots);
    if (inside) {
      factors.push({ rule: 'within-root', detail: `${real} is inside a configured root.`, effect: 'in-scope' });
    } else {
      outOfScope = true;
      factors.push({
        rule: 'outside-roots',
        detail: `${real} is outside every configured root.`,
        effect: 'out-of-scope',
      });
    }
  }

  if (outOfScope && command && classifyCommand(command) === 'read-only') {
    factors.push({
      rule: 'read-only-command',
      detail: 'Reads outside your roots, but nothing in this pipeline can change anything.',
      effect: 'in-scope',
    });
    return { paths, outOfScope: false, factors };
  }

  return { paths, outOfScope, factors };
}
