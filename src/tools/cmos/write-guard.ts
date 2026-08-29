// SPDX-License-Identifier: Apache-2.0
// ABOUTME: checkWrite/countWrite carry failed client write envelopes into the answer, so CMOS
// ABOUTME: never reports a count or state derived only from what code meant to write.

import type { CmosToolResult } from './types';

/**
 * Sprint 86 m02b — the write half of "say only what you know".
 *
 * `client.execute` and `client.raw` return envelopes; their `success` flags are the only evidence
 * the statement ran. Code that discards one, or folds it into a counter/object list with no
 * negative arm, makes the answer assert something not so: `nextStepsReconciled: 4` for an UPDATE
 * that errored, or `alreadyCurrent: true` for a raw CREATE that failed. These two helpers are the
 * supported way to carry the failure into the answer instead.
 *
 * WARN, DO NOT THROW. Both helpers RECORD and return; neither aborts. A `session_events` insert
 * failing must not abort a session start — the defect class here is "assert something not so",
 * not "keep going after a failure", so the cure is DISCLOSURE, not abortion.
 *
 * The message shape is modelled on context-freshness.ts, which already names the DB error
 * verbatim rather than substituting a generic phrase.
 */

/** One recorded write failure, for the structured Tier-1 `writeFailures` channel. */
export interface WriteFailure {
  /** What was being written, in caller vocabulary — e.g. `next_steps.complete`. */
  readonly op: string;
  /** The DB error code, or `DB_ERROR` when the envelope carried none. */
  readonly code: string;
  /** The DB error message, verbatim. */
  readonly message: string;
}

/**
 * Where a failure goes. TWO CHANNELS, DELIBERATELY NOT ONE (fork f09):
 *
 * - `string[]` — the ENVELOPE warnings array, rendered by `appendWarnings`. For writes whose
 *   failure costs durable PROVENANCE (a `session_events` row) but changes no reported number.
 * - `{ failures }` — the structured `writeFailures` array on the answer's own data, rendered by
 *   `appendWriteFailures` under a DISTINCT marker. For writes whose failure makes a reported
 *   count or state untrue.
 *
 * Routing everything through the envelope was rejected because it buries a lost decision beside
 * "you forgot missionId". Both keep `success: true` — the session DID start, the sprint DID close.
 */
export type WriteSink = string[] | { readonly failures: WriteFailure[] };

function record(sink: WriteSink, what: string, result: CmosToolResult<unknown>): void {
  const code = result.error?.code ?? 'DB_ERROR';
  const message = result.error?.message ?? 'unknown';
  if (Array.isArray(sink)) {
    sink.push(`${what} failed: ${code} — ${message}`);
    return;
  }
  sink.failures.push({ op: what, code, message });
}

/**
 * Did the write happen? Records the DB error into `sink` when it did not.
 *
 * Use for writes whose only question is happened-or-not: event rows, single-row inserts whose
 * id is not reported, migration steps.
 */
export function checkWrite(
  result: CmosToolResult<unknown>,
  sink: WriteSink,
  what: string
): boolean {
  if (result.success) return true;
  record(sink, what, result);
  return false;
}

/**
 * How many rows did the write ACTUALLY change? Records the DB error into `sink` on failure.
 *
 * THIS IS THE ONE THAT CLOSES THE CLASS, because it separates the two things a zero can mean:
 *
 *   - `success: true, changes: 0`  — the statement ran and its WHERE matched nothing. LEGITIMATE.
 *     Nothing is recorded. A caller-supplied id that was already `completed` is exactly this, and
 *     telling an operator it was a silent failure would be this sprint's own defect class inside
 *     its fix.
 *   - `success: false`             — the statement errored. Zero rows changed AND the answer must
 *     say so.
 *
 * Whether a legitimate zero is itself worth reporting is a CALL-SITE judgement this helper
 * deliberately does not make: at cmos-sprint-complete.ts the id set is re-SELECTed under the
 * identical predicate inside the same exclusive transaction, so a short count there implies an
 * error; at cmos-next-steps.ts the ids come from the tool call and were never re-selected, so a
 * short count there is ordinary.
 */
export function countWrite(
  result: CmosToolResult<{ changes: number; lastInsertRowid: number | bigint }>,
  sink: WriteSink,
  what: string
): number {
  if (!result.success) {
    record(sink, what, result);
    return 0;
  }
  return result.data?.changes ?? 0;
}
