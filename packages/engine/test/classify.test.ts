import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../src/scope.js';

/**
 * The classifier is what lets auto mode run a command without asking, so both
 * directions matter: a read-only command that asks teaches people to click
 * through prompts, and a writing command that does not ask is the thing the
 * prompt exists to stop.
 */
describe('classifyCommand', () => {
  describe('commands that asked for no reason', () => {
    // Taken from Helm's own sessions: each of these prompted in auto mode.
    it.each([
      'echo "=== agents ==="; launchctl list | grep -E "flint|nexus|helm"\necho "=== log ==="; tail -5 ~/.flint/deploy.out.log 2>/dev/null',
      'for a in com.flint.runtime com.flint.evolve; do\n  echo "--- $a ---"; find ~/Library/LaunchAgents -iname "*${a#com.}*" 2>/dev/null\ndone',
      'pmset -g therm 2>/dev/null || echo "no sudo access"',
    ])('runs %j without asking', (command) => {
      expect(classifyCommand(command)).toBe('read-only');
    });
  });

  describe('reads the shell the way the shell does', () => {
    it.each([
      'grep -E "a|b|c" file',
      "grep -c 'rm -rf' notes.txt",
      'echo "no sudo access"',
      'echo error >&2',
      'ls 2>&1 | head',
      'cmd_output=$(uptime); echo "$cmd_output"',
      'echo "load: $(uptime)"',
      'if [ -f ~/.zshrc ]; then wc -l ~/.zshrc; else echo none; fi',
      'if [[ -f a && -d b ]]; then echo both; fi',
      'while read line; do echo "$line"; done < list.txt',
      'cd ~/Documents/GitHub/helm && git status',
      'git -C ~/helm log --oneline -3',
      'git --no-pager diff --stat',
      'cat <<EOF\nrm -rf is just text here\nEOF',
      "cat <<'EOF'\n$(rm -rf ~) is quoted, so it is not run\nEOF",
      'echo $((3 + 4))',
      'ls # rm -rf ~ in a comment',
      'echo one \\\n  two',
      'bash -c "uptime; df -h /"',
      'zsh -lc \'echo $PATH\'',
      'find . -name "*.ts" -exec grep -l TODO {} +',
      'find . -name "*.log" -exec wc -l {} \\;',
      'ls | xargs grep -l needle',
      'env | sort',
      'command -v git',
      'timeout 5 curl -s http://127.0.0.1:3333/health',
      'curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/health',
      'sed -n 1,20p ~/.helm/update.log',
      "sed -n '/error/p' wiki.md",
      "awk 'NR>1 {print $1}' data.txt",
      'sort -rn counts.txt | uniq -c',
      'plutil -p ~/Library/LaunchAgents/com.helm.update.plist',
      'plutil -extract Label raw ~/Library/LaunchAgents/com.helm.update.plist',
      'plutil -extract ProgramArguments json -o - x.plist',
      'codesign -dv /Applications/Helm.app',
      'launchctl print gui/501/com.helm.update',
      'defaults read com.apple.dock autohide',
      'brew services list',
      'ollama list',
      'pgrep -lf Helm',
      'tailscale --socket=/tmp/ts.sock status',
      'railway config plan --detailed-exit-code',
      'git branch -a',
      "git tag -l 'v*'",
      'git remote -v',
      'git stash list',
      'git config --get user.name',
      'tar -tzf release.tgz',
      'export FOO=1; echo $FOO',
      'FOO=1 printenv FOO',
      '/usr/bin/git status',
    ])('runs %j without asking', (command) => {
      expect(classifyCommand(command)).toBe('read-only');
    });
  });

  describe('still asks before anything that can change something', () => {
    it.each([
      // writing files
      'echo hi > out.txt',
      'echo hi >> ~/.zshrc',
      'make 2>&1 > build.log',
      'ls &> listing.txt',
      'sort -o sorted.txt data.txt',
      'cat <<EOF > notes.txt\nhello\nEOF',
      'tar -xzf release.tgz',
      'unzip release.zip',
      'yq -i ".a = 1" config.yml',
      // privilege
      'sudo pmset -g therm',
      'pmset -g therm 2>/dev/null; sudo powermetrics -n 1',
      // commands hidden inside other commands
      'echo $(rm -rf build)',
      'echo "$(rm -rf build)"',
      'echo `rm -rf build`',
      'cat <(rm -rf build)',
      'cat <<EOF\n$(rm -rf build)\nEOF',
      'bash -c "rm -rf build"',
      'sh install.sh',
      'eval "ls"',
      'env rm -rf build',
      'command rm -rf build',
      'nice -n 5 rm -rf build',
      'timeout 5 rm -rf build',
      'ls | xargs rm',
      'find . -name "*.log" -delete',
      'find . -name x -exec rm {} +',
      'find . -fprint out.txt',
      "awk '{print > \"out.txt\"}' data.txt",
      "awk '{system(\"rm \" $1)}' list.txt",
      "sed -i '' 's/a/b/' file",
      "sed -Ei 's/a/b/' file",
      "sed -I '' 's/a/b/' file",
      "sed 's/a/b/w changed.txt' file",
      // state the old check let through without asking
      'git stash',
      'git branch -D feature',
      'git branch new-branch',
      'git tag v1.0',
      'git remote add origin https://example.com/x.git',
      'git config user.name someone',
      'git -c core.fsmonitor="rm -rf ~" status',
      'git reflog expire --all',
      'launchctl kickstart -k gui/501/com.helm.update',
      'launchctl disable gui/501/com.helm.update',
      'launchctl bootstrap gui/501 ~/Library/LaunchAgents/x.plist',
      'defaults delete com.apple.dock',
      'defaults write com.apple.dock autohide -bool true',
      'plutil -extract ProgramArguments json x.plist',
      'plutil -convert json x.plist',
      'codesign -s - --force Helm.app',
      'security find-generic-password -w -s github',
      // a harmless name that is not the harmless program
      './ls',
      '/tmp/x/git status',
      'PATH=/tmp/evil:$PATH ls',
      'GIT_PAGER="rm -rf ~" git log',
      'export PATH=/tmp/evil:$PATH',
      // the network
      'curl https://example.com',
      'curl example.com/x',
      'curl -d @secrets.txt http://localhost:9000',
      'curl -X POST http://127.0.0.1:3333/admin',
      'curl -o page.html http://localhost:8080',
      'curl -L http://localhost:8080',
      'wget http://localhost:8080',
      // tools that were never read-only
      'git push origin main',
      'npm install',
      'rm notes.txt',
      'python3 -c "print(1)"',
      // text the parser cannot finish reading
      'echo "unterminated',
      'echo $(uptime',
      'cat <<EOF\nno end marker',
      '',
    ])('asks before %j', (command) => {
      expect(classifyCommand(command)).toBe('mutating');
    });
  });
});
