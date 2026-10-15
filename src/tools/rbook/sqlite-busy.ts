// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — a process-wide default for how long a SQLite statement waits on another writer. Hook verbs
// ABOUTME: lower it: the wait is synchronous, so it would block the event loop and the deadline with it.

import type { Database } from 'better-sqlite3';

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

/**
 * s96-m10 — switch a connection to WAL, waiting up to budgetMs for another connection's write.
 *
 * SQLite takes the lock for a switch into WAL without calling the busy handler, so while another
 * connection holds a write reservation the switch answers SQLITE_BUSY at once, whatever the busy
 * timeout. Two processes opening one new or delete-mode file together met that refusal: sprint-99's
 * Node 22 CI run failed lifecycle-decoupling.test.ts:437 on it. The mode is re-read on every try,
 * because the other connection may have switched the file already. Any other error, or a lock still
 * held when the budget runs out, is thrown.
 */
export function enableWal(db: Database, budgetMs: number): void {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'wal')
        db.pragma('journal_mode = WAL');
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline)
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
