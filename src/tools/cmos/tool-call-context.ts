// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Request-local action mode and project-identity disclosures for one MCP tool call.
// ABOUTME: AsyncLocalStorage keeps concurrent read/write calls from leaking policy or warnings.

import { AsyncLocalStorage } from 'async_hooks';

import type { ActionMode } from './action-taxonomy';

interface ToolCallContext {
  readonly actionMode: ActionMode;
  readonly projectIdentityDisclosures: Set<string>;
}

export interface ToolCallCapture<T> {
  readonly value: T;
  readonly projectIdentityDisclosures: readonly string[];
}

const toolCallStorage = new AsyncLocalStorage<ToolCallContext>();

/** Unique carrier for one failed capture; the original thrown value is unwrapped at the boundary. */
class CapturedToolCallError extends Error {
  readonly originalError: unknown;
  readonly projectIdentityDisclosures: readonly string[];

  constructor(originalError: unknown, projectIdentityDisclosures: readonly string[]) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = 'CapturedToolCallError';
    this.originalError = originalError;
    this.projectIdentityDisclosures = projectIdentityDisclosures;
    if (originalError instanceof Error && originalError.stack) this.stack = originalError.stack;
  }
}

/** The current dispatch call's read/write classification, or undefined outside dispatch. */
export function currentToolCallActionMode(): ActionMode | undefined {
  return toolCallStorage.getStore()?.actionMode;
}

/**
 * Record one fallback-identity disclosure on the current MCP answer.
 *
 * The Set de-duplicates repeated `getProjectId` reads inside one call. There is deliberately no
 * process-wide suppression here: stderr is noisy and may warn once per store, but every agent
 * answer that relies on a fallback must carry the fact itself.
 */
export function recordProjectIdentityDisclosure(message: string): void {
  toolCallStorage.getStore()?.projectIdentityDisclosures.add(message);
}

/** Run one MCP dispatch inside a concurrency-safe request context and return its disclosures. */
export async function captureToolCall<T>(
  actionMode: ActionMode,
  operation: () => Promise<T>
): Promise<ToolCallCapture<T>> {
  const context: ToolCallContext = {
    actionMode,
    projectIdentityDisclosures: new Set<string>(),
  };
  try {
    const value = await toolCallStorage.run(context, operation);
    return {
      value,
      projectIdentityDisclosures: [...context.projectIdentityDisclosures],
    };
  } catch (error) {
    // A unique carrier belongs to this capture, even when concurrent handlers throw the same
    // Error instance. The MCP boundary unwraps the original for reporting, so its message/stack
    // remain authoritative without using the thrown object itself as request-local storage.
    const inherited =
      error instanceof CapturedToolCallError ? error.projectIdentityDisclosures : [];
    const originalError = error instanceof CapturedToolCallError ? error.originalError : error;
    throw new CapturedToolCallError(originalError, [
      ...new Set([...inherited, ...context.projectIdentityDisclosures]),
    ]);
  }
}

/** Return disclosures captured by this specific failed MCP request. */
export function projectIdentityDisclosuresForError(error: unknown): readonly string[] {
  return error instanceof CapturedToolCallError ? error.projectIdentityDisclosures : [];
}

/** Recover the handler's original thrown value from a failed capture carrier. */
export function unwrapCapturedToolCallError(error: unknown): unknown {
  return error instanceof CapturedToolCallError ? error.originalError : error;
}
