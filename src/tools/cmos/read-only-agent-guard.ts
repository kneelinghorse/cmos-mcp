// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read-only review-agent guard (Sprint 78 m04, FORK-5). Env-gated (CMOS_AGENT_ROLE=review)
// ABOUTME: dispatch-layer block: a write action throws ReadOnlyAgentGuardError; strict no-op when unset.

import { classifyAction } from './action-taxonomy';

export const READ_ONLY_AGENT_ENV = 'CMOS_AGENT_ROLE';
export const READ_ONLY_AGENT_ROLE = 'review';

/**
 * Thrown by {@link assertReadOnlyAgentAllowed} when a WRITE action is attempted
 * while the session is pinned to the read-only review role. A dedicated class so
 * the dispatch wiring can catch exactly this and convert it to a structured
 * isError result — distinct from a genuine handler exception. FAIL LOUD.
 */
export class ReadOnlyAgentGuardError extends Error {
  readonly toolName: string;
  readonly action: string | undefined;

  constructor(toolName: string, action: string | undefined) {
    super(
      `[read-only-agent-guard] BLOCKED: ${toolName}${action ? `(action=${action})` : ''} is a WRITE ` +
        `and ${READ_ONLY_AGENT_ENV}=${READ_ONLY_AGENT_ROLE} permits only read-classified calls. ` +
        `This blocked call stopped before project resolution or DB open; it mutated no row or ` +
        `credential. Use a read action, or unset ` +
        `${READ_ONLY_AGENT_ENV} to run with write access.`
    );
    this.name = 'ReadOnlyAgentGuardError';
    this.toolName = toolName;
    this.action = action;
  }
}

/**
 * True iff the current process is pinned to the read-only review role. Read at
 * CALL TIME (not module load) so tests and long-lived servers observe env
 * changes deterministically — mirrors real-store-guard's JEST_WORKER_ID check.
 */
export function isReadOnlyAgentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[READ_ONLY_AGENT_ENV] === READ_ONLY_AGENT_ROLE;
}

/**
 * Guard invoked at the TOP of tool dispatch — before the switch and before any
 * projectRoot / sender-context resolution or DB open, so a blocked write opens no
 * DB and mutates no row.
 *
 * STRICT NO-OP when CMOS_AGENT_ROLE is unset or any non-'review' value — zero
 * production behavior or perf change. When the role is 'review', it THROWS
 * {@link ReadOnlyAgentGuardError} for any action the fail-closed taxonomy
 * classifies as 'write' (which includes every unknown tool / unknown action).
 */
export function assertReadOnlyAgentAllowed(
  toolName: string,
  action: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isReadOnlyAgentSession(env)) {
    return;
  }
  if (classifyAction(toolName, action) === 'write') {
    throw new ReadOnlyAgentGuardError(toolName, action);
  }
}
