// Per-session transcript persistence.
//
// Records the events themselves rather than rendered text, so resuming replays
// them through exactly the same code path that drew them the first time. A
// screenshot of the buffer would drift from the renderer the moment either
// changes; a log of events cannot.

import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StreamEvent, TranscriptEntry } from '@helm/shared';

const SESSION_DIR = join(homedir(), '.helm', 'sessions');

/** Past this size a transcript stops growing rather than filling the disk. */
const MAX_BYTES = 8 * 1024 * 1024;
/** How many past sessions to keep before pruning the oldest. */
const KEEP_SESSIONS = 20;

interface Sink {
  stream: WriteStream;
  bytes: number;
  capped: boolean;
}

const sinks = new Map<string, Sink>();

export function transcriptPath(sessionId: string): string {
  return join(SESSION_DIR, `${sessionId}.jsonl`);
}

export async function openTranscript(sessionId: string): Promise<void> {
  if (sinks.has(sessionId)) return;
  await mkdir(SESSION_DIR, { recursive: true });
  const stream = createWriteStream(transcriptPath(sessionId), { flags: 'a' });
  // A write error must never take the terminal down with it.
  stream.on('error', () => sinks.delete(sessionId));
  sinks.set(sessionId, { stream, bytes: 0, capped: false });
}

function append(sessionId: string, entry: TranscriptEntry): void {
  const sink = sinks.get(sessionId);
  if (!sink || sink.capped) return;

  const line = JSON.stringify(entry) + '\n';
  sink.bytes += Buffer.byteLength(line);
  if (sink.bytes > MAX_BYTES) {
    sink.capped = true;
    sink.stream.write(
      JSON.stringify({ t: 'pty', d: '\r\n[transcript truncated: size limit reached]\r\n' }) + '\n',
    );
    return;
  }
  sink.stream.write(line);
}

export function recordPty(sessionId: string, data: string): void {
  append(sessionId, { t: 'pty', d: data });
}

export function recordAgent(sessionId: string, event: StreamEvent): void {
  append(sessionId, { t: 'agent', e: event });
}

export function closeTranscript(sessionId: string): void {
  const sink = sinks.get(sessionId);
  if (!sink) return;
  sinks.delete(sessionId);
  sink.stream.end();
}

export function closeAllTranscripts(): void {
  for (const id of [...sinks.keys()]) closeTranscript(id);
}

export interface TranscriptSummary {
  id: string;
  mtime: number;
  bytes: number;
}

/** Most recently written first. */
export async function listTranscripts(): Promise<TranscriptSummary[]> {
  if (!existsSync(SESSION_DIR)) return [];
  const files = (await readdir(SESSION_DIR)).filter((f) => f.endsWith('.jsonl'));
  const out: TranscriptSummary[] = [];
  for (const file of files) {
    try {
      const info = await stat(join(SESSION_DIR, file));
      out.push({ id: file.replace(/\.jsonl$/, ''), mtime: info.mtimeMs, bytes: info.size });
    } catch {
      // Raced with a delete; skip it.
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export async function readTranscript(sessionId: string): Promise<TranscriptEntry[]> {
  const path = transcriptPath(sessionId);
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      // A partial final line from a hard kill is expected; skip it.
    }
  }
  return entries;
}

/** Keeps the newest KEEP_SESSIONS transcripts and removes the rest. */
export async function pruneTranscripts(): Promise<void> {
  const all = await listTranscripts();
  for (const old of all.slice(KEEP_SESSIONS)) {
    try {
      await unlink(transcriptPath(old.id));
    } catch {
      // Already gone.
    }
  }
}
