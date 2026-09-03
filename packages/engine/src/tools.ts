// Tools Helm gives the agent that no general-purpose agent has: the terminal
// it is living inside, and a memory that survives the process.
//
// These run in-process through the SDK's own MCP transport, so there is no
// subprocess, no port and no serialisation of anything larger than the result.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** Everything the host has to supply; the engine owns no terminal and no disk
 *  layout of its own. Anything omitted simply removes that tool. */
export interface ToolHost {
  /** The shell's recent output as plain text, newest last. */
  readScrollback?: (lines: number) => string;
  /** Where notes are kept across sessions. */
  memoryPath?: string;
}

const text = (body: string): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: body }],
});

/**
 * Reads the memory file. Returned to the caller rather than injected into the
 * system prompt on a timer, so a file that has not changed cannot quietly
 * invalidate the prompt cache mid-session.
 */
export function readMemory(path: string | undefined): string {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * The SDK is ESM-only and the desktop main process is bundled as CommonJS, so
 * every path into it has to be a dynamic import. A static one here crashed the
 * app at launch — before any window existed, with nothing on stderr.
 */
export async function buildHelmServer(
  host: ToolHost,
): Promise<McpSdkServerConfigWithInstance | null> {
  if (!host.readScrollback && !host.memoryPath) return null;
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const tools = [];

  if (host.readScrollback) {
    const read = host.readScrollback;
    tools.push(
      tool(
        'terminal_output',
        'Read what the terminal has shown recently — the commands the user ran ' +
          'and everything they printed. Use this before asking the user what ' +
          'happened, whenever a question refers to something already on screen ' +
          '("that error", "why did that fail", "the last command").',
        { lines: z.number().int().min(1).max(300).optional() },
        async (args) => {
          const body = read(args.lines ?? 80);
          return text(body || 'The terminal has produced no output yet in this session.');
        },
      ),
    );
  }

  if (host.memoryPath) {
    const path = host.memoryPath;
    tools.push(
      tool(
        'remember',
        'Save a durable fact about this machine or this user — where a project ' +
          'lives, how they prefer something done, a name for a thing they use. ' +
          'Notes are read back at the start of every future session. Save only ' +
          'what will still be true tomorrow.',
        { note: z.string().min(1).max(500) },
        async (args) => {
          try {
            mkdirSync(dirname(path), { recursive: true });
            appendFileSync(path, `- ${args.note.replace(/\s+/g, ' ').trim()}\n`, 'utf8');
            return text('Saved.');
          } catch (error) {
            return text(`Could not save: ${(error as Error).message}`);
          }
        },
      ),
      tool(
        'forget',
        'Remove saved notes matching a phrase, when something recorded has ' +
          'become wrong. Say what was removed.',
        { matching: z.string().min(1) },
        async (args) => {
          try {
            const needle = args.matching.toLowerCase();
            const before = readMemory(path).split('\n');
            const after = before.filter((line) => !line.toLowerCase().includes(needle));
            writeFileSync(path, after.join('\n') + (after.length ? '\n' : ''), 'utf8');
            const removed = before.length - after.length;
            return text(removed ? `Removed ${removed} note(s).` : 'Nothing matched.');
          } catch (error) {
            return text(`Could not update memory: ${(error as Error).message}`);
          }
        },
      ),
    );
  }

  if (tools.length === 0) return null;
  return createSdkMcpServer({
    name: 'helm',
    version: '1.0.0',
    tools,
    // These are the two things that make Helm different from a chat window.
    // Deferring them behind tool search would mean the agent asks the user
    // what happened rather than looking.
    alwaysLoad: true,
  });
}
