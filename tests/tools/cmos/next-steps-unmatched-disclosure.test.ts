// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s87-m06 — a transition that skipped an id must NAME it, without calling it a failure.
// ABOUTME: And a carried row must be transitionable, or it can only ever age.

/**
 * Sprint 87 m06 (#536) — TWO CHANNELS THAT REPORT A WRITE WHILE HIDING WHICH ROW IT MISSED.
 *
 * 1. `affected: N` over M requested ids told an operator that M−N did nothing and gave them no
 *    way to learn WHICH. Ask for 12, get 10, and the two that missed are unrecoverable from the
 *    answer.
 * 2. All three write predicates were gated on `status = 'pending'`, so a row CARRIED to a later
 *    sprint could never afterwards be completed, dropped or re-carried by id. Live, in this
 *    store: next-steps #486, #492 and #493 are stamped `carried_to_sprint='sprint-86'`, were
 *    still open at sprint-87, and could only age.
 *
 * WHY THE UNMATCHED LINE IS NEUTRAL, and why that is the hard part rather than the cosmetic one.
 * An id that matched nothing is NOT a write failure: the statement ran and its WHERE matched no
 * row, which is the ordinary outcome for an id already completed, already dropped, or absent.
 * Reporting it under the WRITE-FAILURE heading would tell an operator the database rejected
 * something it did not — the "say only what you know" violation this sprint exists to close,
 * committed inside the fix for it. `write-disclosure-next-steps.test.ts` CRITERION 8 names that
 * exact temptation in its docblock and PASSES UNMODIFIED against this change; if it had needed
 * editing, the design here would have been wrong, not that test.
 *
 * THESE ROWS ARE NOT TOUCHED. #486, #492 and #493 keep whatever status they carry. Decision
 * #1007 adjudicated them deliberately OUTSIDE the status column — "Resolution is recorded here
 * and in the master plan rather than in a status column the tool cannot write" — and a build
 * agent may not quietly overwrite an operator-visible decision's chosen bookkeeping. This mission
 * makes such rows transitionable IN FUTURE; it transitions none of them.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cmosContext } from '../../../src/tools/cmos/cmos-context';
import { formatNextStepsForLLM } from '../../../src/tools/cmos/cmos-next-steps';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

let tempDir: string;
let dbPath: string;

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seed(): void {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s87m06-'));
  const dbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  dbPath = path.join(dbDir, 'cmos.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE next_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, sprint_id TEXT,
      session_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
      resolved_at TEXT, carried_to_sprint TEXT
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata (key, value) VALUES ('project_name', 'm06 fixture');
  `);
  db.close();
  CmosDetector.resetInstance();
}

/** Every status is ESTABLISHED here, never inherited (#547). */
function insert(content: string, status: string, carriedTo: string | null = null): number {
  return withDb((db) =>
    Number(
      db
        .prepare(
          `INSERT INTO next_steps (content, status, created_at, carried_to_sprint)
           VALUES (?, ?, '2026-08-01T00:00:00Z', ?)`
        )
        .run(content, status, carriedTo).lastInsertRowid
    )
  );
}

function statusOf(id: number): { status: string; carried: string | null } {
  return withDb(
    (db) =>
      db
        .prepare('SELECT status, carried_to_sprint AS carried FROM next_steps WHERE id = ?')
        .get(id) as {
        status: string;
        carried: string | null;
      }
  );
}

describe('s87-m06 (#536) — the ledger names the row it did not touch', () => {
  beforeEach(seed);
  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('RED: a complete over [pending, already-completed] NAMES the unmatched id in the rendered answer', async () => {
    const pending = insert('still open', 'pending');
    const done = insert('already finished', 'completed');

    const result = await cmosContext({
      action: 'next_steps',
      nextStepAction: 'complete',
      nextStepIds: [pending, done],
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as unknown as {
      affected: number;
      writeFailures: unknown[];
      unmatchedIds: number[];
    };

    // The counts are unchanged — this is a DISCLOSURE fix, not a behaviour change.
    expect(data.affected).toBe(1);
    expect(data.writeFailures).toEqual([]);
    expect(result.warnings ?? []).toEqual([]);
    // …and the id that did nothing is now recoverable from the answer.
    expect(data.unmatchedIds).toEqual([done]);

    // ON THE RENDERED STRING. The class is "the answer is the defect", so a fix proven only on
    // the data object would have moved it rather than closed it.
    const rendered = formatNextStepsForLLM(
      result as unknown as Parameters<typeof formatNextStepsForLLM>[0]
    );
    expect(rendered).toContain(`#${done}`);
    expect(rendered).toContain('1 next-step(s) marked as completed');
  }, 60_000);

  it('the unmatched line is NEUTRAL — not a write failure, not a warning', async () => {
    const pending = insert('still open', 'pending');
    const done = insert('already finished', 'completed');
    const result = await cmosContext({
      action: 'next_steps',
      nextStepAction: 'complete',
      nextStepIds: [pending, done],
      projectRoot: tempDir,
    });
    const rendered = formatNextStepsForLLM(
      result as unknown as Parameters<typeof formatNextStepsForLLM>[0]
    );

    // Asserted DIRECTLY, because naming a benign zero as a rejected write is this sprint's
    // violation committed inside its own fix.
    expect(rendered).not.toMatch(/write failure/i);
    expect(rendered).not.toMatch(/⚠/);
    expect(rendered).not.toContain(`next_steps.complete #${done}`);
    expect(rendered).toContain('Not matched');
  }, 60_000);

  it('every requested id matching leaves the unmatched list EMPTY — the line does not always print', async () => {
    // Negative control. Without it, a renderer that printed the line unconditionally would pass
    // the test above.
    const a = insert('one', 'pending');
    const b = insert('two', 'pending');
    const result = await cmosContext({
      action: 'next_steps',
      nextStepAction: 'complete',
      nextStepIds: [a, b],
      projectRoot: tempDir,
    });
    expect((result.data as unknown as { unmatchedIds: number[] }).unmatchedIds).toEqual([]);
    const rendered = formatNextStepsForLLM(
      result as unknown as Parameters<typeof formatNextStepsForLLM>[0]
    );
    expect(rendered).not.toContain('Not matched');
  }, 60_000);

  /**
   * CRITERION 6 — the four semantic arms, each individually falsifiable. The field semantics are
   * ASSERTED here rather than documented: `complete`/`drop` set `status`, rewrite `resolved_at`
   * and LEAVE `carried_to_sprint` alone (the row records which sprint carried it, and a later
   * completion does not un-carry that history); `carry` OVERWRITES `carried_to_sprint`, which is
   * the point of re-carrying.
   */
  describe('the widened predicate, arm by arm', () => {
    it('a CARRIED row can now be completed — the frozen-row defect', async () => {
      const carried = insert('carried forward', 'carried', 'sprint-86');
      const result = await cmosContext({
        action: 'next_steps',
        nextStepAction: 'complete',
        nextStepIds: [carried],
        projectRoot: tempDir,
      });
      expect((result.data as unknown as { affected: number }).affected).toBe(1);
      expect(statusOf(carried).status).toBe('completed');
    }, 60_000);

    it('a COMPLETED row still cannot — the predicate admits exactly two statuses', async () => {
      // Admitting 'completed' would break all five of CRITERION 8's assertions in
      // write-disclosure-next-steps.test.ts. This arm is what keeps the widening narrow.
      const done = insert('finished', 'completed');
      const result = await cmosContext({
        action: 'next_steps',
        nextStepAction: 'drop',
        nextStepIds: [done],
        projectRoot: tempDir,
      });
      expect((result.data as unknown as { affected: number }).affected).toBe(0);
      expect((result.data as unknown as { unmatchedIds: number[] }).unmatchedIds).toEqual([done]);
      expect(statusOf(done).status).toBe('completed');
    }, 60_000);

    it('re-carrying a carried row OVERWRITES carried_to_sprint', async () => {
      const carried = insert('carried once', 'carried', 'sprint-86');
      await cmosContext({
        action: 'next_steps',
        nextStepAction: 'carry',
        nextStepIds: [carried],
        carryToSprint: 'sprint-87',
        projectRoot: tempDir,
      });
      expect(statusOf(carried)).toEqual({ status: 'carried', carried: 'sprint-87' });
    }, 60_000);

    it('completing a carried row PRESERVES carried_to_sprint — the history is not erased', async () => {
      const carried = insert('carried then done', 'carried', 'sprint-86');
      await cmosContext({
        action: 'next_steps',
        nextStepAction: 'complete',
        nextStepIds: [carried],
        projectRoot: tempDir,
      });
      expect(statusOf(carried)).toEqual({ status: 'completed', carried: 'sprint-86' });
    }, 60_000);

    it('the BULK carry-all arm picks up carried rows too — the third site, which the fork omitted', async () => {
      // The draft's fork named `:190` and `:236` and missed `:219`, the carry-all-pending arm.
      // Widening it is what makes an aged carried row stop aging invisibly at the next close.
      const pending = insert('pending one', 'pending');
      const carried = insert('carried one', 'carried', 'sprint-86');
      const done = insert('done one', 'completed');

      const result = await cmosContext({
        action: 'next_steps',
        nextStepAction: 'carry',
        carryToSprint: 'sprint-88',
        projectRoot: tempDir,
      });

      expect((result.data as unknown as { affected: number }).affected).toBe(2);
      expect(statusOf(pending)).toEqual({ status: 'carried', carried: 'sprint-88' });
      expect(statusOf(carried)).toEqual({ status: 'carried', carried: 'sprint-88' });
      // …and a completed row is still untouched by the bulk arm.
      expect(statusOf(done).status).toBe('completed');
    }, 60_000);
  });
});
