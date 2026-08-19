// Bridges the engine's canUseTool callback to the renderer's approval UI.
// Holds the pending-decision map keyed by request id, and the session-scoped
// persist cache. Cleared on every new session — a remembered "allow" must
// never outlive the window it was granted in.

import type { BrowserWindow } from 'electron';
import { IPC, type PermissionDecision, type PermissionRequest } from '@helm/shared';

interface Pending {
  resolve: (decision: PermissionDecision) => void;
}

const pending = new Map<string, Pending>();

/** Tool names the user chose to remember for this session only. */
const sessionGrants = new Set<string>();

export function clearPermissionState(): void {
  for (const [, entry] of pending) {
    // Fail closed: a request still in flight when the session dies is denied,
    // never silently allowed.
    entry.resolve({ id: '', behavior: 'deny', persist: false, reason: 'Session ended.' });
  }
  pending.clear();
  sessionGrants.clear();
}

/** Called from the engine. Resolves when the renderer answers, or on teardown. */
export function requestPermission(
  win: BrowserWindow,
  request: PermissionRequest,
): Promise<PermissionDecision> {
  if (sessionGrants.has(request.toolName)) {
    return Promise.resolve({ id: request.id, behavior: 'allow', persist: true });
  }

  if (win.isDestroyed()) {
    return Promise.resolve({
      id: request.id,
      behavior: 'deny',
      persist: false,
      reason: 'No window to ask.',
    });
  }

  return new Promise<PermissionDecision>((resolve) => {
    pending.set(request.id, { resolve });
    win.webContents.send(IPC.PermissionRequest, request);
  });
}

/** Called from the renderer's IPC handler with the user's answer. */
export function resolvePermission(decision: PermissionDecision, toolName?: string): void {
  const entry = pending.get(decision.id);
  if (!entry) return;
  pending.delete(decision.id);

  if (decision.persist && decision.behavior === 'allow' && toolName) {
    sessionGrants.add(toolName);
  }
  entry.resolve(decision);
}
