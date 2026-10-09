// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — a process-wide default for how long a SQLite statement waits on another writer. Hook verbs
// ABOUTME: lower it: the wait is synchronous, so it would block the event loop and the deadline with it.

let processBusyTimeoutMs: number | null = null;

/**
 * Set (or with null, clear) the busy timeout clients use when their caller names none. A hook verb
 * sets a short one: better-sqlite3 waits for a lock inside the statement, holding the thread, so a
 * deadline timer cannot fire until the statement gives up.
 */
export function setProcessBusyTimeout(ms: number | null): void {
  processBusyTimeoutMs = ms;
}

/** The process-wide busy timeout, or null for the client's own default. */
export function processBusyTimeout(): number | null {
  return processBusyTimeoutMs;
}
