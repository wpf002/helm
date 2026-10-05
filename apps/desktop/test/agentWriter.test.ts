import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import type { StreamEvent } from '@helm/shared';
import { AgentWriter } from '../src/renderer/src/agentWriter';

const ANSI = /\x1b\[[0-9;]*m/g;

/** Enough of xterm for the writer: it writes, and it asks where the cursor is. */
class FakeTerminal {
  cols = 80;
  out = '';
  buffer = { active: { cursorX: 0 } };
  write(text: string): void {
    this.out += text;
    const line = this.out.slice(Math.max(this.out.lastIndexOf('\n'), this.out.lastIndexOf('\r')) + 1);
    this.buffer.active.cursorX = line.replace(ANSI, '').length;
  }
  get plain(): string[] {
    return this.out.replace(ANSI, '').split('\r\n');
  }
}

const S = 'session';
const turn: StreamEvent[] = [
  { kind: 'text', sessionId: S, text: 'Let me check how your Mac is doing.\n' },
  { kind: 'tool_start', sessionId: S, toolId: 't1', toolName: 'Bash', input: { command: 'uptime; df -h /', description: 'Check uptime and free disk space' } },
  { kind: 'tool_result', sessionId: S, toolId: 't1', ok: true, output: '17:55  up 5 days, 16:35, 1 user\nFilesystem  Size  Used Avail\n/dev/disk3s1  460Gi  13Gi  339Gi\nmap auto_home 0Bi 0Bi 0Bi\n' },
  { kind: 'tool_start', sessionId: S, toolId: 't2', toolName: 'mcp__helm__run_in_terminal', input: { command: 'sudo pmset -g therm', description: "Check the Mac's temperature" } },
  { kind: 'tool_result', sessionId: S, toolId: 't2', ok: false, output: 'sudo: a password is required\n' },
  { kind: 'text', sessionId: S, text: '## Summary\n**All good.** Your Mac has been on for 5 days and has `339 GB` free.\n- Disk: plenty of space\n- Memory: fine\n' },
  { kind: 'turn_end', sessionId: S, usage: { input: 6, output: 1539, cacheRead: 48104, cacheWrite: 26569, costUsd: 0.0213 } },
];

function render(events: StreamEvent[], cols = 80): FakeTerminal {
  const term = new FakeTerminal();
  term.cols = cols;
  const writer = new AgentWriter(term as unknown as Terminal);
  writer.home = '/Users/willfoti';
  writer.echoPrompt('How is my Mac Studio doing today?');
  for (const event of events) writer.handle(event);
  return term;
}

describe('AgentWriter', () => {
  it('reads like a conversation, with every command shown', () => {
    const term = render(turn);
    if (process.env['HELM_DUMP']) writeFileSync(process.env['HELM_DUMP'], term.out);
    const text = term.plain.join('\n');
    expect(text).toContain('│ › How is my Mac Studio doing today?');
    expect(text).toContain('│ ✦ Let me check how your Mac is doing.');
    expect(text).toContain('╭ ⊷ Check uptime and free disk space');
    expect(text).toContain('│   $ uptime; df -h /');
    expect(text).toContain('│   17:55  up 5 days, 16:35, 1 user');
    expect(text).toContain('│   … and 1 more lines');
    expect(text).toContain('╰ ✓ Done');
    expect(text).toContain("╭ ⊷ Check the Mac's temperature");
    expect(text).toContain('╰ ✕ Failed · sudo: a password is required');
    expect(text).toContain('│ ✦ Summary');
    expect(text).toContain('│   All good. Your Mac has been on for 5 days and has 339 GB free.');
    expect(text).toContain('│   • Disk: plenty of space');
    expect(text).toMatch(/│ Done in \d+s · about 2¢/);
    // Token counts are bookkeeping, not news.
    expect(text).not.toMatch(/\bin \/ \d+ out\b/);
  });

  it('never writes past the edge of the terminal', () => {
    const long: StreamEvent[] = [
      { kind: 'text', sessionId: S, text: 'word '.repeat(60) + '\n' },
      { kind: 'tool_start', sessionId: S, toolId: 't', toolName: 'Bash', input: { command: 'find / -name "*.log" ' + '-o -name x '.repeat(30), description: 'Look for log files everywhere on the disk, which takes a while' } },
      { kind: 'tool_result', sessionId: S, toolId: 't', ok: true, output: 'x'.repeat(300) },
    ];
    for (const cols of [40, 80, 120]) {
      const term = render(long, cols);
      for (const line of term.plain) expect(line.length).toBeLessThanOrEqual(cols);
    }
  });

  it('names the tool on its closing line when tools finish out of order', () => {
    const text = render([
      { kind: 'tool_start', sessionId: S, toolId: 'a', toolName: 'Read', input: { file_path: '/Users/willfoti/notes.md' } },
      { kind: 'tool_start', sessionId: S, toolId: 'b', toolName: 'Grep', input: { pattern: 'TODO' } },
      { kind: 'tool_result', sessionId: S, toolId: 'a', ok: true, output: 'hello' },
      { kind: 'tool_result', sessionId: S, toolId: 'b', ok: true, output: 'notes.md:1:TODO' },
    ]).plain.join('\n');
    expect(text).toContain('╭ ⊷ Read ~/notes.md');
    expect(text).toContain('╰ ✓ Done: Read ~/notes.md');
    expect(text).toContain('╭ ⊷ Search files for “TODO”');
  });
});
