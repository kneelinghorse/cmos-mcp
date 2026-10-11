// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Carries only Codex's caller folder and conversation identity through one MCP request.
// ABOUTME: Invalid metadata stays explicit so resolution cannot silently borrow the server's cwd.

import { AsyncLocalStorage } from 'async_hooks';
import { fileURLToPath } from 'url';

export interface CodexRequestContext {
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly error?: string;
}

const requests = new AsyncLocalStorage<CodexRequestContext | undefined>();
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Codex calls sandbox state opaque. Interpret only the probed folder; retain no other fields. */
function parse(meta: unknown): CodexRequestContext | undefined {
  const value = object(meta);
  if (!value || !Object.prototype.hasOwnProperty.call(value, 'x-codex-turn-metadata')) {
    return undefined;
  }
  if (!object(value['x-codex-turn-metadata'])) {
    return { error: 'Codex turn metadata is malformed.' };
  }
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  if (!sessionId) return { error: 'Codex did not provide a non-empty sessionId.' };
  const folder = object(value['codex/sandbox-state-meta'])?.sandboxCwd;
  if (typeof folder !== 'string' || !folder.startsWith('file://')) {
    return { error: 'Codex did not provide sandboxCwd as a file:// URI.' };
  }
  try {
    const cwd = fileURLToPath(folder);
    if (cwd.includes('\0')) throw new Error('NUL in path');
    return { cwd, sessionId };
  } catch {
    return { error: 'Codex provided a malformed sandboxCwd file:// URI.' };
  }
}

export function withCodexRequest<T>(meta: unknown, operation: () => T): T {
  return requests.run(parse(meta), operation);
}

export function currentCodexRequest(): CodexRequestContext | undefined {
  return requests.getStore();
}

/** Timers inherit AsyncLocalStorage; background work must not retain the initiating caller. */
export function withoutCodexRequest<T>(operation: () => T): T {
  return requests.run(undefined, operation);
}
