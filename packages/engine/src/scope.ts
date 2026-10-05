import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Factor, ScopeVerdict } from '@helm/shared';
import { classifyCommand, explainCommand } from './classify.js';

export { classifyCommand, type CommandKind } from './classify.js';

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
 * Paths that are not anybody's files. Writing to /dev/null is how a shell
 * discards output, and counting it as "outside your roots" made a plain search
 * ask for permission three times over — for the bit bucket.
 */
const NULL_DEVICES = new Set([
  '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom',
  '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/console',
]);

function isNullDevice(path: string): boolean {
  return NULL_DEVICES.has(path) || /^\/dev\/fd\/\d+$/.test(path);
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
    // The same path twice in one command is one fact, not two. `2>/dev/null`
    // repeated across a pipeline used to state the same reason three times.
    if (paths.includes(real)) continue;
    paths.push(real);

    if (real !== absolute) {
      factors.push({
        rule: 'symlink-resolved',
        detail: `${absolute} resolves to ${real}`,
        effect: 'info',
      });
    }

    if (isNullDevice(real)) {
      factors.push({
        rule: 'null-device',
        detail: `${real} discards or supplies a stream; it is not a file in anyone's roots.`,
        effect: 'in-scope',
      });
      continue;
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

/**
 * What 'auto' mode may approve on its own. Containment alone is not enough:
 * the default root is the home directory, so `rm -rf ~/Documents/GitHub/flint`
 * resolves entirely inside it and used to run without a word. A shell command
 * that can change state stops for a decision wherever it points; reads, and
 * in-scope file tools whose single target is shown in the call, do not.
 */
export function autoApproves(
  toolName: string,
  input: unknown,
  verdict: ScopeVerdict,
): { allow: boolean; factor?: Factor } {
  if (verdict.outOfScope) return { allow: false };
  const command = isRecord(input) && typeof input['command'] === 'string' ? input['command'] : undefined;
  const reason = command === undefined ? null : explainCommand(command);
  if (reason !== null) {
    return {
      allow: false,
      factor: { rule: 'auto-mutating-command', detail: reason, effect: 'out-of-scope' },
    };
  }
  return { allow: true };
}

/** What each tool does, finishing the sentence "Helm wants to …". */
const WANTS: Record<string, string> = {
  Bash: 'run a command',
  mcp__helm__run_in_terminal: 'run a command in your terminal',
  Write: 'create or replace a file',
  Edit: 'edit a file',
  MultiEdit: 'edit a file',
  NotebookEdit: 'edit a notebook',
  Read: 'read a file',
  Glob: 'look for files',
  Grep: 'search inside files',
  LS: 'list a folder',
  WebFetch: 'open a web page',
  WebSearch: 'search the web',
  mcp__helm__remember: 'save a note to its memory',
  mcp__helm__forget: 'remove a note from its memory',
  mcp__helm__terminal_output: 'read your terminal',
};

function tidy(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(home + sep) ? '~' + path.slice(home.length) : path;
}

/**
 * The words the permission prompt shows, and the key "allow for this session"
 * remembers. A command is remembered exactly, never by its first word: allowing
 * `rm build/old.log` must not allow `rm -rf ~` later. A file tool is remembered
 * for the folders it touched.
 */
export function describeRequest(
  toolName: string,
  input: unknown,
  verdict: ScopeVerdict,
  mode: 'off' | 'prompt' | 'auto',
): { summary: string; reason: string; sessionKey: string; sessionScope: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const wants = WANTS[toolName] ?? (mcp ? `use ${mcp[2]} from ${mcp[1]}` : `use ${toolName}`);
  const command = isRecord(input) && typeof input['command'] === 'string' ? input['command'] : undefined;

  let reason: string;
  const explained = command === undefined ? null : explainCommand(command);
  if (explained) reason = explained;
  else if (verdict.factors.some((f) => f.rule === 'outside-roots')) {
    const outside = verdict.paths.find((p) => verdict.factors.some((f) => f.rule === 'outside-roots' && f.detail.startsWith(p)));
    reason = `It reaches outside the folders Helm may use${outside ? `: ${tidy(outside)}` : ''}.`;
  } else if (verdict.outOfScope) reason = "Helm can't tell which files this would touch.";
  else if (mode === 'prompt') reason = 'Helm is set to ask before everything it does.';
  else reason = 'Helm needs your OK for this.';

  if (command !== undefined) {
    return {
      summary: `Helm wants to ${wants}`,
      reason,
      sessionKey: `${toolName}\u0000${command.trim().replace(/\s+/g, ' ')}`,
      sessionScope: 'this exact command',
    };
  }
  const folders = [...new Set(verdict.paths.map((p) => dirname(p)))].sort();
  return {
    summary: `Helm wants to ${wants}`,
    reason,
    sessionKey: [toolName, ...folders].join('\u0000'),
    sessionScope:
      folders.length === 0 ? 'this kind of request' : folders.length === 1 ? `this, in ${tidy(folders[0] as string)}` : 'this, in these folders',
  };
}
