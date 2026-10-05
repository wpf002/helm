// Read/write classification for shell commands — the test auto mode applies
// before it lets a command run without asking.
//
// It reads a command the way the shell does: quotes, operators, loops,
// substitutions and redirections. The regex this replaced split
// `grep -E "a|b"` into commands named `b"`, took `for x in …; do` for programs
// called `for` and `do`, and read the word in `echo "no sudo access"` as sudo.
// Each of those asked the user to approve a command that could not change
// anything, and a prompt that is usually wrong teaches people to click Allow
// without reading it.
//
// The default is unchanged: a command this file does not know is one that can
// change things. Only commands listed in RULES can run without a prompt, and
// each rule checks the flags that make its command write.

export type CommandKind = 'read-only' | 'mutating';

interface Redirect {
  op: string;
  target: string;
}

interface SimpleCommand {
  words: string[];
  redirects: Redirect[];
}

interface Parsed {
  commands: SimpleCommand[];
  /** Text of $(…), `…`, <(…) and >(…) — commands the shell will also run. */
  substitutions: string[];
  /** False when quotes or brackets never close; such text is not judged. */
  ok: boolean;
}

/** Index just past the `)` that closes the group opened at `start`. */
function closeParen(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (i >= text.length) return -1;
      i++;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')' && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

/** Index just past the backtick that closes the one at `start`. */
function closeBacktick(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '`') return i + 1;
    i++;
  }
  return -1;
}

/** Finds command substitutions in text the shell expands (heredoc bodies). */
function substitutionsIn(text: string, into: string[]): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const end = closeParen(text, i + 2);
      if (end < 0) return false;
      into.push(text.slice(i + 2, end - 1));
      i = end - 1;
    } else if (text[i] === '`') {
      const end = closeBacktick(text, i + 1);
      if (end < 0) return false;
      into.push(text.slice(i + 1, end - 1));
      i = end - 1;
    }
  }
  return true;
}

function parse(source: string): Parsed {
  const commands: SimpleCommand[] = [];
  const substitutions: string[] = [];
  const heredocs: { delim: string; strip: boolean; expand: boolean }[] = [];
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let word = '';
  let inWord = false;
  let quotedWord = false;
  let pendingRedirect: string | null = null;
  let pendingHeredoc: { strip: boolean } | null = null;
  let brackets = 0; // inside [[ … ]], where && || < > ( ) are not operators
  let ok = true;

  const endWord = () => {
    if (!inWord) return;
    if (pendingHeredoc) {
      heredocs.push({ delim: word, strip: pendingHeredoc.strip, expand: !quotedWord });
      pendingHeredoc = null;
    } else if (pendingRedirect !== null) {
      redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else {
      if (!quotedWord && word === '[[' && words.every((w) => KEYWORDS.has(w) || ASSIGNMENT.test(w))) brackets++;
      if (!quotedWord && word === ']]' && brackets > 0) brackets--;
      words.push(word);
    }
    word = '';
    inWord = false;
    quotedWord = false;
  };
  const endCommand = () => {
    endWord();
    if (pendingRedirect !== null || pendingHeredoc) ok = false;
    pendingRedirect = null;
    pendingHeredoc = null;
    if (words.length > 0 || redirects.length > 0) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (ch === '\\') {
      if (next === '\n') {
        i += 2; // line continuation
        continue;
      }
      word += next ?? '';
      inWord = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) return { commands, substitutions, ok: false };
      word += source.slice(i + 1, end);
      inWord = true;
      quotedWord = true;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      i++;
      inWord = true;
      quotedWord = true;
      while (i < source.length && source[i] !== '"') {
        const c = source[i] as string;
        if (c === '\\' && '$`"\\\n'.includes(source[i + 1] ?? '')) {
          word += source[i + 1];
          i += 2;
        } else if (c === '$' && source[i + 1] === '(' && source[i + 2] !== '(') {
          const end = closeParen(source, i + 2);
          if (end < 0) return { commands, substitutions, ok: false };
          substitutions.push(source.slice(i + 2, end - 1));
          word += '$(…)';
          i = end;
        } else if (c === '`') {
          const end = closeBacktick(source, i + 1);
          if (end < 0) return { commands, substitutions, ok: false };
          substitutions.push(source.slice(i + 1, end - 1));
          word += '`…`';
          i = end;
        } else {
          word += c;
          i++;
        }
      }
      if (i >= source.length) return { commands, substitutions, ok: false };
      i++; // closing quote
      continue;
    }

    if (ch === '$' && next === '(') {
      if (source[i + 2] === '(') {
        // $(( arithmetic )) — expands to a number, runs nothing
        const end = closeParen(source, i + 2);
        if (end < 0) return { commands, substitutions, ok: false };
        word += source.slice(i, end + 1);
        inWord = true;
        i = end + 1;
        continue;
      }
      const end = closeParen(source, i + 2);
      if (end < 0) return { commands, substitutions, ok: false };
      substitutions.push(source.slice(i + 2, end - 1));
      word += '$(…)';
      inWord = true;
      i = end;
      continue;
    }

    if (ch === '$' && next === '{') {
      const end = source.indexOf('}', i + 2);
      if (end < 0) return { commands, substitutions, ok: false };
      if (!substitutionsIn(source.slice(i + 2, end), substitutions)) ok = false;
      word += source.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }

    if (ch === '`') {
      const end = closeBacktick(source, i + 1);
      if (end < 0) return { commands, substitutions, ok: false };
      substitutions.push(source.slice(i + 1, end - 1));
      word += '`…`';
      inWord = true;
      i = end;
      continue;
    }

    if (ch === '#' && !inWord) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      endWord();
      i++;
      continue;
    }

    if (ch === '\n') {
      endCommand();
      i++;
      // Heredoc bodies start on the line after their `<<WORD`.
      while (heredocs.length > 0) {
        const doc = heredocs.shift() as { delim: string; strip: boolean; expand: boolean };
        const body: string[] = [];
        let closed = false;
        while (i < source.length) {
          const eol = source.indexOf('\n', i);
          const line = source.slice(i, eol < 0 ? source.length : eol);
          i = eol < 0 ? source.length : eol + 1;
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) {
            closed = true;
            break;
          }
          body.push(line);
        }
        if (!closed) ok = false;
        if (doc.expand && !substitutionsIn(body.join('\n'), substitutions)) ok = false;
      }
      continue;
    }

    if (brackets > 0 && '&|<>()'.includes(ch)) {
      word += ch;
      inWord = true;
      i++;
      continue;
    }

    if (ch === '<' || ch === '>') {
      // Process substitution: <(cmd) and >(cmd) run cmd.
      if (next === '(') {
        const end = closeParen(source, i + 2);
        if (end < 0) return { commands, substitutions, ok: false };
        substitutions.push(source.slice(i + 2, end - 1));
        word += '<(…)';
        inWord = true;
        i = end;
        continue;
      }
      // A bare number right before the operator is a file descriptor: 2>…
      if (inWord && !quotedWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      let op: string;
      if (ch === '>') {
        op = next === '>' ? '>>' : next === '|' ? '>|' : next === '&' ? '>&' : '>';
      } else if (next === '<') {
        op = source[i + 2] === '<' ? '<<<' : source[i + 2] === '-' ? '<<-' : '<<';
      } else {
        op = next === '&' ? '<&' : next === '>' ? '<>' : '<';
      }
      i += op.length;
      if (op === '<<' || op === '<<-') pendingHeredoc = { strip: op === '<<-' };
      else pendingRedirect = op;
      continue;
    }

    if (ch === '&' && next === '>') {
      endWord();
      const op = source[i + 2] === '>' ? '&>>' : '&>';
      pendingRedirect = op;
      i += op.length;
      continue;
    }

    if (ch === '|' || ch === '&' || ch === ';' || ch === '(' || ch === ')') {
      endCommand();
      i += (ch === '|' && (next === '|' || next === '&')) || (ch === '&' && next === '&') || (ch === ';' && next === ';') ? 2 : 1;
      continue;
    }

    word += ch;
    inWord = true;
    i++;
  }
  endCommand();
  if (heredocs.length > 0) ok = false;
  return { commands, substitutions, ok };
}

// ---------------------------------------------------------------- the rules

const always = (): boolean => true;

/** Arguments that are not flags, skipping the values of flags that take one. */
function positionals(args: string[], valueFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (valueFlags.includes(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

const subcommand =
  (allowed: string[], valueFlags: string[] = []) =>
  (args: string[]): boolean =>
    allowed.includes(positionals(args, valueFlags)[0] ?? '');

const BRANCH_LIST_FLAGS = new Set([
  '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '-l',
  '--show-current', '--merged', '--no-merged', '--color', '--no-color',
  '--column', '--no-column', '-i', '--ignore-case', '--abbrev', '--no-abbrev',
]);

function git(args: string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    // -c can set core.fsmonitor, core.pager or an alias — each runs a program.
    if (arg === '-c' || arg.startsWith('--config-env') || arg === '--exec-path' || arg.startsWith('--exec-path=')) return false;
    if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
      i += 2;
      continue;
    }
    if (/^--(git-dir|work-tree|namespace)=/.test(arg) || ['--no-pager', '-P', '--bare', '--no-replace-objects', '--literal-pathspecs', '--no-optional-locks'].includes(arg)) {
      i++;
      continue;
    }
    break;
  }
  const [cmd = '', ...rest] = args.slice(i);
  switch (cmd) {
    case 'status': case 'log': case 'show': case 'blame': case 'annotate': case 'describe':
    case 'shortlog': case 'ls-files': case 'ls-remote': case 'ls-tree': case 'rev-parse':
    case 'rev-list': case 'cat-file': case 'whatchanged': case 'grep': case 'count-objects':
    case 'merge-base': case 'name-rev': case 'for-each-ref': case 'show-ref': case 'show-branch':
    case 'cherry': case 'var': case 'check-ignore': case 'check-attr': case 'range-diff':
    case 'version': case '--version': case 'help':
      return true;
    case 'diff':
      return !rest.some((a) => a.startsWith('--output'));
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show' || (rest[0] as string).startsWith('-');
    case 'branch':
      return rest.every((a) => BRANCH_LIST_FLAGS.has(a)) || rest.includes('--list');
    case 'tag':
      return rest.includes('-l') || rest.includes('--list') || rest.every((a) => ['-n', '--sort', '--color'].includes(a.split('=')[0] as string));
    case 'remote':
      return rest.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(rest[0] as string);
    case 'stash':
      return ['list', 'show'].includes(rest[0] ?? ''); // a bare `git stash` takes your changes away
    case 'config': {
      const reads = ['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch'];
      return rest.some((a) => reads.includes(a));
    }
    case 'worktree':
      return rest[0] === 'list';
    case 'submodule':
      return rest.length === 0 || rest[0] === 'status';
    default:
      return false;
  }
}

function find(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (['-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(arg)) return false;
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) {
      const end = args.findIndex((a, j) => j > i && (a === ';' || a === '+'));
      const inner = args.slice(i + 1, end < 0 ? args.length : end).filter((a) => a !== '{}');
      if (judge({ words: inner, redirects: [] }, 1) !== null) return false;
      if (end < 0) return false;
      i = end;
    }
  }
  return true;
}

function sed(args: string[]): boolean {
  const scripts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith('--in-place') || arg === '-f' || arg.startsWith('--file')) return false;
    if (/^-[a-zA-Z]*[iI]/.test(arg) && !arg.startsWith('--')) return false;
    if (arg === '-e' || arg === '--expression') scripts.push(args[++i] ?? '');
  }
  if (scripts.length === 0) scripts.push(positionals(args)[0] ?? '');
  return !scripts.some((script) => /(^|[;{}\n/\d])\s*w\s*\S/.test(script));
}

function awk(args: string[]): boolean {
  if (args.includes('-f') || args.some((a) => a.startsWith('--file'))) return false;
  return !positionals(args, ['-F', '-v']).some((program) =>
    /\bsystem\s*\(|\b(print|printf)\b[^;{}\n]*(>|\|)|\|\s*getline|\|&/.test(program),
  );
}

const LOCAL_HOST = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/\S*)?$/i;

/** A GET to this machine only: no data sent, no file written, nothing remote. */
function curl(args: string[]): boolean {
  const sends = /^(-d|--data.*|-F|--form.*|-T|--upload-file|-O|--remote-name.*|-K|--config|-X|--request|-c|--cookie-jar|-D|--dump-header|--create-dirs|-J|--remote-header-name|-x|--proxy|-L|--location)$/;
  let local = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '-o' || arg === '--output') {
      if (!NULL_TARGET.test(args[i + 1] ?? '')) return false; // -o /dev/null writes nothing
      i++;
      continue;
    }
    if (sends.test(arg)) return false;
    if (/^-[a-zA-Z]+$/.test(arg) && /[dFTOoKXcDJxL]/.test(arg.slice(1))) return false;
    if (LOCAL_HOST.test(arg)) local = true;
    else if (/:\/\//.test(arg) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(arg)) return false;
  }
  return local;
}

function plutil(args: string[]): boolean {
  if (args.some((a) => ['-convert', '-replace', '-insert', '-remove', '-create'].includes(a))) return false;
  if (args.some((a) => ['-p', '-lint', '-help', '-type'].includes(a))) return true;
  const at = args.indexOf('-extract');
  if (at < 0) return false;
  // Without `-o -`, -extract overwrites the file with the extracted value.
  const out = args.indexOf('-o');
  return (out >= 0 && args[out + 1] === '-') || args[at + 2] === 'raw';
}

function codesign(args: string[]): boolean {
  if (args.some((a) => a === '-s' || a === '--sign' || a === '--remove-signature' || /^-[a-zA-Z]*s/.test(a))) return false;
  return args.some((a) => a.startsWith('-d') || a === '--display' || a.startsWith('-v') || a === '--verify');
}

function brew(args: string[]): boolean {
  const [cmd = '', next = 'list'] = positionals(args);
  if (cmd === 'services') return ['list', 'info'].includes(next);
  return [
    'list', 'ls', 'info', 'search', 'outdated', 'deps', 'uses', 'leaves', 'desc', 'config',
    'doctor', 'commands', 'missing', 'tap-info', '--version', '--prefix', '--cellar', '--repository',
  ].includes(cmd) || (args[0] ?? '').startsWith('--prefix') || args[0] === '--version';
}

function railway(args: string[]): boolean {
  const [a = '', b = '', c = ''] = positionals(args);
  if (['status', 'whoami', 'list', 'logs', 'version', 'help'].includes(a)) return true;
  if (args[0] === '--version') return true;
  if (a === 'config') return b === 'plan' || (b === 'partials' && c === 'list');
  if (a === 'deployment') return ['list', 'ls'].includes(b);
  return false;
}

function tailscale(args: string[]): boolean {
  const [cmd = '', next = ''] = positionals(args, ['--socket']);
  if (['status', 'ip', 'netcheck', 'version', 'whois'].includes(cmd)) return true;
  return ['serve', 'funnel'].includes(cmd) && next === 'status';
}

/**
 * Commands that run without a prompt, each with the test that keeps it
 * read-only. A command missing from here always asks.
 */
const RULES: Record<string, (args: string[]) => boolean> = {
  // what the machine is doing
  uptime: always, date: always, whoami: always, id: always, hostname: always, uname: always,
  sw_vers: always, w: always, who: always, ps: always, top: always, vm_stat: always,
  df: always, du: always, iostat: always, nettop: always, system_profiler: always,
  ioreg: always, netstat: always, ifconfig: always, arp: always, route: always,
  networkQuality: always, lsof: always, stat: always, file: always, which: always,
  whence: always, type: always, printenv: always, locale: always, groups: always,
  hostinfo: always, nproc: always, pgrep: always, getconf: always,
  sysctl: (args) => !args.some((a) => a === '-w' || a.includes('=')),
  pmset: (args) => args[0] === '-g',
  scutil: (args) => ['--get', '--dns', '--proxy', '--nwi', '-r', '-w'].includes(args[0] ?? ''),
  memory_pressure: (args) => args.length === 0 || (args.length === 1 && args[0] === '-Q'),
  launchctl: subcommand([
    'list', 'print', 'print-cache', 'print-disabled', 'blame', 'dumpstate', 'procinfo',
    'hostinfo', 'resolveport', 'error', 'version', 'help', 'managerpid', 'manageruid', 'managername',
  ]),
  defaults: subcommand(['read', 'read-type', 'domains', 'find', 'help']),
  log: subcommand(['show', 'stream', 'stats', 'help']),
  lsappinfo: subcommand(['list', 'info', 'find', 'front', 'visibleProcessList']),
  security: (args) => {
    const cmd = positionals(args)[0] ?? '';
    if (cmd === 'list-keychains') return !args.includes('-s');
    return ['find-certificate', 'find-identity', 'show-keychain-info', 'verify-cert'].includes(cmd);
  },
  csrutil: subcommand(['status']),
  'xcode-select': (args) => ['-p', '--print-path', '-v', '--version'].includes(args[0] ?? ''),
  diskutil: subcommand(['list', 'info', 'activity']),
  plutil,
  codesign,
  // reading and shaping text
  cat: always, head: always, tail: always, less: always, more: always, wc: always,
  cut: always, tr: always, column: always, fold: always, nl: always, rev: always,
  jq: always, echo: always, printf: always, basename: always, dirname: always,
  realpath: always, seq: always, grep: always, egrep: always, fgrep: always, rg: always,
  ag: always, diff: always, cmp: always, md5: always, shasum: always, md5sum: always,
  sha1sum: always, sha256sum: always, cksum: always, base64: always, xxd: always, od: always,
  ls: always, tree: always, pwd: always, readlink: always, paste: always, join: always,
  comm: always, fmt: always, expand: always, unexpand: always, zcat: always, gzcat: always,
  bzcat: always, xzcat: always, zipinfo: always, strings: always, otool: always, nm: always,
  mdfind: always, mdls: always, locate: always,
  sort: (args) => !args.some((a) => a === '-o' || a.startsWith('--output') || /^-[a-zA-Z]*o/.test(a)),
  uniq: (args) => positionals(args, ['-f', '-s']).length <= 1,
  yq: (args) => !args.some((a) => a === '-i' || a === '--inplace' || /^-[a-zA-Z]*i/.test(a)),
  tar: (args) => {
    const mode = (args[0] ?? '').replace(/^-/, '');
    return (mode.includes('t') && !/[xcru]/.test(mode)) || args.includes('--list');
  },
  unzip: (args) => args.some((a) => ['-l', '-v', '-t', '-Z', '-z', '-p'].includes(a)),
  find,
  sed,
  gsed: sed,
  awk, gawk: awk, nawk: awk, mawk: awk,
  curl,
  // shell bookkeeping: changes the shell's own state, never a file
  cd: always, pushd: always, popd: always, test: always, '[': always, '[[': always,
  ':': always, true: always, false: always, sleep: always, wait: always, read: always,
  exit: always, return: always, break: always, continue: always, local: always,
  declare: always, typeset: always, readonly: always, export: always, set: always,
  unset: always, shopt: always, setopt: always,
  // tools where the subcommand decides
  git,
  brew,
  railway,
  tailscale,
  npm: subcommand(['view', 'ls', 'list', 'outdated', 'search', 'info', 'why', 'ping', 'root', 'prefix', 'bin', '--version', '-v']),
  pnpm: subcommand(['view', 'ls', 'list', 'outdated', 'why', 'root', 'bin', 'licenses', '--version', '-v']),
  yarn: subcommand(['info', 'list', 'outdated', 'why', '--version']),
  docker: subcommand(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'port', 'history']),
  kubectl: subcommand(['get', 'describe', 'logs', 'top', 'explain', 'version', 'config', 'api-resources']),
  systemctl: subcommand(['status', 'list-units', 'is-active', 'is-enabled', 'show']),
  cargo: subcommand(['tree', 'search', 'metadata', 'version']),
  go: subcommand(['version', 'env', 'list']),
  ollama: subcommand(['list', 'ls', 'ps', 'show', '--version', '-v']),
  python3: (args) => ['--version', '-V'].includes(args[0] ?? ''),
  python: (args) => ['--version', '-V'].includes(args[0] ?? ''),
  node: (args) => ['--version', '-v'].includes(args[0] ?? ''),
  pip: subcommand(['list', 'show', 'freeze', 'search']),
  pip3: subcommand(['list', 'show', 'freeze', 'search']),
};

/** Words that open or close shell syntax rather than name a program. */
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'esac']);

/** Setting any of these before a command can make a harmless one run something else. */
const RISKY_VARIABLES = /^(PATH|IFS|ENV|BASH_ENV|PROMPT_COMMAND|EDITOR|VISUAL|PAGER|MANPAGER|LESSOPEN|LESSCLOSE|PERL5OPT|PYTHONSTARTUP|NODE_OPTIONS|LD_\w+|DYLD_\w+|GIT_\w+)$/;

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/;

const NULL_TARGET = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

const SYSTEM_BIN = /^\/(usr\/)?s?bin\/[^/]+$|^\/(opt\/homebrew|usr\/local)\/s?bin\/[^/]+$|^\/Library\/Developer\/CommandLineTools\/usr\/bin\/[^/]+$/;

/** Commands whose job is to run another command given as their arguments. */
function unwrap(head: string, args: string[]): string[] | 'read-only' | null {
  switch (head) {
    case 'env': {
      let i = 0;
      while (i < args.length) {
        const arg = args[i] as string;
        if (arg === '-u' || arg === '-P' || arg === '-C') i += 2;
        else if (arg === '-S' || arg.startsWith('--split-string')) return null;
        else if (arg.startsWith('-') || ASSIGNMENT.test(arg)) {
          const name = ASSIGNMENT.exec(arg)?.[1];
          if (name && RISKY_VARIABLES.test(name)) return null;
          i++;
        } else break;
      }
      return i >= args.length ? 'read-only' : args.slice(i);
    }
    case 'command':
      if (args[0] === '-v' || args[0] === '-V') return 'read-only';
      return args[0] === '-p' ? args.slice(1) : args;
    case 'builtin':
    case 'nohup':
    case 'exec':
      return args.length === 0 ? 'read-only' : args;
    case 'time':
      return args[0] === '-p' ? args.slice(1) : args;
    case 'nice':
      if (args[0] === '-n') return args.slice(2);
      return /^-\d+$/.test(args[0] ?? '') ? args.slice(1) : args;
    case 'timeout': {
      let i = 0;
      while (i < args.length && (args[i] as string).startsWith('-')) i += ['-s', '-k', '--signal', '--kill-after'].includes(args[i] as string) ? 2 : 1;
      return args.slice(i + 1); // past the duration
    }
    case 'xargs': {
      let i = 0;
      while (i < args.length && (args[i] as string).startsWith('-')) {
        i += ['-n', '-P', '-I', '-L', '-s', '-E', '-d', '-a', '-J', '-R', '-S'].includes(args[i] as string) ? 2 : 1;
      }
      return i >= args.length ? 'read-only' : args.slice(i); // bare xargs runs echo
    }
    default:
      return null;
  }
}

/** What common commands do, for the sentence the permission prompt shows. */
const DOES: Record<string, string> = {
  rm: 'deletes files', rmdir: 'deletes folders', mv: 'moves or renames files', cp: 'copies files',
  mkdir: 'creates folders', touch: 'creates or updates files', ln: 'creates links between files',
  chmod: 'changes who can use a file', chown: 'changes who owns a file', tee: 'saves output to a file',
  dd: 'writes raw data to a file or disk', kill: 'stops a running program', killall: 'stops running programs',
  pkill: 'stops running programs', shutdown: 'shuts down the Mac', reboot: 'restarts the Mac',
  open: 'opens an app, file or web page', osascript: 'runs an AppleScript, which can control other apps',
  wget: 'downloads files from the internet', curl: 'talks to a website or server over the network',
  ssh: 'runs commands on another computer', scp: 'copies files to or from another computer',
  rsync: 'copies or syncs files', python: 'runs Python code', python3: 'runs Python code',
  node: 'runs JavaScript code', make: 'runs build steps', eval: 'runs text as a command',
  installer: 'installs software', brew: 'installs or changes software', npm: 'installs or runs packages',
  pnpm: 'installs or runs packages', yarn: 'installs or runs packages', pip: 'installs Python packages',
  pip3: 'installs Python packages', launchctl: 'starts, stops or changes a background job',
  defaults: 'changes a Mac setting', plutil: 'rewrites a settings file', codesign: 'signs an app',
  security: 'reads or changes your keychain', sed: 'edits files', find: 'acts on the files it finds',
  awk: 'can write files or run other commands', tar: 'unpacks or packs up files', unzip: 'unpacks files',
  sort: 'saves its output to a file', yq: 'edits a file in place', docker: 'starts or changes containers',
  railway: 'changes your Railway project', tailscale: 'changes Tailscale', ollama: 'downloads or changes AI models',
  sysctl: 'changes a system setting', pmset: 'changes power settings', scutil: 'changes a system setting',
};

const GIT_DOES: Record<string, string> = {
  push: 'sends your commits to GitHub', commit: 'saves a commit', checkout: 'switches branches or restores files',
  switch: 'switches branches', reset: 'moves your branch and can throw away changes',
  restore: 'restores files and can throw away changes', merge: 'merges branches', rebase: 'rewrites commits',
  pull: 'downloads and merges changes', fetch: 'downloads new commits', clone: 'downloads a repository',
  stash: 'sets your unsaved changes aside', branch: 'creates or deletes a branch', tag: 'creates or deletes a tag',
  clean: 'deletes files git is not tracking', rm: 'deletes files from the repository', add: 'stages changes',
  config: 'changes git settings', remote: 'changes where the repository syncs to', init: 'creates a repository',
};

/**
 * Why a single command needs approval, as a sentence for the prompt — or null
 * when it only reads.
 */
function judge(simple: SimpleCommand, depth: number): string | null {
  for (const { op, target } of simple.redirects) {
    if (op === '<' || op === '<&' || op === '<<<') continue;
    if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(target)) continue; // 2>&1, >&2
    if (!NULL_TARGET.test(target)) return `It saves output to ${target}.`;
  }

  let words = simple.words;
  let i = 0;
  for (; i < words.length; i++) {
    const word = words[i] as string;
    const assignment = ASSIGNMENT.exec(word);
    if (assignment) {
      if (RISKY_VARIABLES.test(assignment[1] as string)) {
        return `It changes ${assignment[1]} for the command, which can make it run something else.`;
      }
      continue;
    }
    if (KEYWORDS.has(word)) continue;
    break;
  }
  words = words.slice(i);
  if (words.length === 0) return null; // only assignments, keywords or redirects
  const first = words[0] as string;
  if (['for', 'select', 'case', 'in'].includes(first)) return null; // loop and case headers list data, not commands

  // `./ls` or /tmp/x/git is whatever that file is, not the system's ls or git.
  if (first.includes('/') && !SYSTEM_BIN.test(first)) return `It runs the program at ${first}, which Helm can't vouch for.`;
  const head = first.replace(/^.*\//, '');
  const args = words.slice(1);

  if (['sudo', 'doas', 'su', 'pkexec'].includes(head)) return `It uses ${head}, which runs the command as an administrator.`;

  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(head)) {
    const flag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    const script = flag >= 0 ? args[flag + 1] : undefined;
    if (script === undefined) return `It runs the script ${positionals(args)[0] ?? 'it is given'}.`;
    return depth < 8 ? explain(script, depth + 1) : 'It nests too many commands for Helm to follow.';
  }

  const wrapped = unwrap(head, args);
  if (wrapped === 'read-only') return null;
  if (wrapped !== null) {
    if (wrapped.length === 0) return null;
    return depth < 8 ? judge({ words: wrapped, redirects: [] }, depth + 1) : 'It nests too many commands for Helm to follow.';
  }

  if (head === 'export') {
    const risky = args.map((a) => ASSIGNMENT.exec(a)?.[1] ?? '').find((name) => RISKY_VARIABLES.test(name));
    return risky ? `It changes ${risky}, which can make later commands run something else.` : null;
  }

  const rule = RULES[head];
  if (rule !== undefined && rule(args)) return null;

  if (head === 'git') {
    if (args.some((a) => a === '-c' || a.startsWith('--config-env') || a.startsWith('--exec-path'))) {
      return 'It sets a git option that can run another program.';
    }
    const sub = gitSubcommand(args);
    return `It runs \`git ${sub}\`, which ${GIT_DOES[sub] ?? 'can change your repository'}.`;
  }
  const does = DOES[head];
  return does
    ? `It runs \`${head}\`, which ${does}.`
    : `It runs \`${head}\`, and Helm can't tell whether that changes anything.`;
}

/** The git subcommand, past options like -C <dir> that come before it. */
function gitSubcommand(args: string[]): string {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (['-C', '--git-dir', '--work-tree', '--namespace', '-c'].includes(arg)) i += 2;
    else if (arg.startsWith('-')) i++;
    else break;
  }
  return args[i] ?? '';
}

function explain(command: string, depth: number): string | null {
  const parsed = parse(command);
  if (!parsed.ok) return "Helm couldn't read this command all the way through, so it can't tell what it does.";
  if (parsed.commands.length === 0) return 'The command is empty.';
  for (const inner of parsed.substitutions) {
    if (depth >= 8) return 'It nests too many commands for Helm to follow.';
    const reason = explain(inner, depth + 1);
    if (reason) return reason;
  }
  for (const simple of parsed.commands) {
    const reason = judge(simple, depth);
    if (reason) return reason;
  }
  return null;
}

/**
 * Why a shell command needs approval, in one plain sentence, or null when
 * every command it would run only reads. This is the test auto mode applies.
 */
export function explainCommand(command: string): string | null {
  return explain(command, 0);
}

/**
 * Deterministic read/write classification for a shell command. Read-only means
 * every command the text would run — including inside $(…), backticks and
 * `bash -c` — is one that reports state, and nothing redirects output to a
 * file. Text the parser cannot read to the end is mutating.
 */
export function classifyCommand(command: string): CommandKind {
  return explain(command, 0) === null ? 'read-only' : 'mutating';
}
