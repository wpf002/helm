import { describe, expect, it, beforeAll } from 'vitest';
import { routeInputWithFactors, scanPathBinaries } from '../src/route.js';

/**
 * The corpus that drove the misroute rate from 8.8% to 1.9%. It exists so a
 * future change to the heuristics cannot quietly undo that: every entry here
 * was a real decision the router got wrong at some point, or a case whose
 * behaviour someone would reasonably assume.
 */
const SHELL = [
  'ls', 'ls -la', 'pwd', 'cd ~/Documents', 'cd ..', 'mkdir -p build',
  'rm -rf node_modules', 'cp a.txt b.txt', 'mv old.ts new.ts', 'touch .gitkeep',
  'cat package.json', 'head -20 log.txt', 'tail -f server.log', 'du -sh *',
  'chmod +x script.sh', 'ln -s a b', 'stat file.txt',
  'git status', 'git add .', 'git commit -m "fix the parser"', 'git push origin main',
  'git log --oneline -10', 'git diff HEAD~1', 'git checkout -b feature/routing',
  'git stash pop', 'git remote -v',
  'npm install', 'npm run dev', 'npm test', 'pnpm add -D vitest', 'npx tsc --noEmit',
  'node -v', 'python3 -m venv .venv', 'make', 'make clean', 'make build',
  'grep -rn TODO src', 'find . -name "*.ts"', 'ps aux', 'kill -9 1234', 'lsof -i :3000',
  'curl -s https://api.example.com', 'ssh user@host',
  'export FOO=bar', 'source ~/.zshrc', 'echo $PATH', 'which node', 'whoami', 'date',
  'cat x.json | jq .', 'ps aux | grep node', 'ls | wc -l', 'sort file.txt | uniq -c',
  'for f in *.ts; do echo $f; done', 'if [ -f x ]; then echo y; fi',
  'open .', 'vim config.ts', 'less README.md', 'tar -czf out.tgz src',
  'seq 1 10', 'printf "%s\\n" hi', 'echo hello world', 'true', 'history',
  'print -P "%F{red}x%f"', 'setopt', 'autoload -Uz compinit', 'bindkey',
  './script.sh', 'FOO=bar ./run.sh', 'time npm test',
  // regressions: operators bound to the command name
  'false; echo "code=$?"', 'ls;echo hi',
  // regression: quoted prose is an argument, not grammar
  "git commit -m 'update the readme for me'",
  // regression: multi-word echo is still a command
  'echo one two three four five six',
];

const AGENT = [
  'what does this repo do', 'explain the routing logic', 'why is the build failing',
  'fix the failing test', 'add a dark mode toggle', 'refactor this to use hooks',
  'how do I revert the last commit', 'summarise the git log',
  'write a test for routeInput', 'can you check if the api key is set',
  'show me the largest files', 'delete the old logs', 'clean up the imports',
  'make the tests pass', 'update the readme', 'rename this variable',
  'what is six times seven', 'find the config file', 'test the login flow',
  'make it faster', 'why did that fail?', 'walk me through the permission flow',
  'remove all the console logs', 'which file handles routing',
  'where is the scope check implemented', 'should I use a hook here',
  'convert this to typescript', 'document the ipc contract',
  // English words that are also real binaries — the class that used to execute
  'install dependencies', 'write tests', 'read the config', 'look at the logs',
  'say hello', 'sort the results by date', 'check for security issues',
  'open settings', 'clear the cache', 'test coverage report',
];

describe('routeInput', () => {
  let binaries: Set<string>;

  beforeAll(async () => {
    binaries = await scanPathBinaries();
  });

  it('finds a plausible number of executables on PATH', () => {
    expect(binaries.size).toBeGreaterThan(100);
  });

  it.each(SHELL)('routes %j to the shell', (line) => {
    expect(routeInputWithFactors(line, binaries).route.target).toBe('shell');
  });

  it.each(AGENT)('routes %j to the agent', (line) => {
    expect(routeInputWithFactors(line, binaries).route.target).toBe('agent');
  });

  it('keeps the corpus misroute rate under the 5% kill gate', () => {
    const all = [
      ...SHELL.map((line) => [line, 'shell'] as const),
      ...AGENT.map((line) => [line, 'agent'] as const),
    ];
    const wrong = all.filter(([line, want]) => routeInputWithFactors(line, binaries).route.target !== want);
    expect(wrong.length / all.length).toBeLessThan(0.05);
  });

  describe('explicit prefixes override inference', () => {
    it('$ forces the shell and strips the marker', () => {
      const { route } = routeInputWithFactors('$what is this', new Set());
      expect(route).toEqual({ target: 'shell', command: 'what is this' });
    });

    it('? forces the agent and strips the marker', () => {
      const { route } = routeInputWithFactors('?ls -la', new Set());
      expect(route).toEqual({ target: 'agent', prompt: 'ls -la' });
    });
  });

  describe('shell vocabulary', () => {
    it('treats a reported word as a command even when it is not on PATH', () => {
      const bare = new Set<string>();
      expect(routeInputWithFactors('rg pattern', bare).route.target).toBe('agent');
      // The zsh hook reports builtins, aliases, functions and history.
      expect(routeInputWithFactors('rg pattern', new Set(['rg'])).route.target).toBe('shell');
    });

    it('does not let vocabulary override prose', () => {
      expect(routeInputWithFactors('rg the config file', new Set(['rg'])).route.target).toBe('agent');
    });
  });

  it('attaches a Factor for every decision', () => {
    for (const line of ['ls', 'what is this', '$ls', '?hi', 'install dependencies']) {
      const { factors } = routeInputWithFactors(line, new Set(['ls']));
      expect(factors.length).toBeGreaterThan(0);
      for (const factor of factors) {
        expect(factor.rule).toBeTruthy();
        expect(factor.detail).toBeTruthy();
      }
    }
  });

  it('routes an empty line to the agent without throwing', () => {
    expect(routeInputWithFactors('   ', new Set()).route.target).toBe('agent');
  });
});
