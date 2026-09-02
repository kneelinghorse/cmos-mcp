// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m02b criteria 7+8 — a rejected next_steps/constraints UPDATE is NAMED in the answer
// ABOUTME: text with its DB code+message, while a benign zero from a caller-supplied id stays silent.

/**
 * Sprint 86 m02b — the caller-supplied-id sites, where the benign-zero discipline lives.
 *
 * WHY THIS MATTERS, not just what it asserts.
 *
 * `cmos_context(next_steps, complete|drop|carry)` and `cmos_context(constraints, archive)` each
 * report a count — "3 next-step(s) marked as completed". Before s86-m02b that number was built
 * from `result.data?.changes ?? 0` with NO negative arm, so an UPDATE the database REJECTED
 * contributed a silent 0 and the answer read as an ordinary, uneventful outcome. An operator
 * closing a sprint would be told the reconciliation happened. It had not. That is the whole
 * defect class this sprint exists to close: no CMOS answer may report a count, a boolean, or a
 * state description derived from what the code MEANT to write.
 *
 * TWO THINGS ARE BEING PROVEN HERE, AND THEY PULL IN OPPOSITE DIRECTIONS.
 *
 *   1. A statement the DB REJECTED must reach the formatted text — code AND message, verbatim —
 *      in BOTH shapes these handlers write in: the BULK branch (one statement, `WHERE
 *      status = 'pending'` / `WHERE ... expires_at <= ?`) and the PER-ID loop (one statement per
 *      caller-supplied id). Both branches, both tools, or the disclosure has a hole.
 *
 *   2. A statement that RAN and matched nothing must NOT. `changes === 0` on a successful
 *      statement here means "no pending row with that id" — the ids came from the TOOL CALL and
 *      were never re-selected under the same predicate, so a short count is ordinary, not
 *      evidence of an error. Reporting it as a silent write failure would be this sprint's own
 *      defect class committed inside its fix.
 *
 * THE BOUNDARY WORTH REMEMBERING: `countWrite` refuses to decide whether a successful zero is
 * meaningful because only its caller knows the id provenance. Sprint close stopped writing
 * next_steps status in s90-m05; these explicit operator transitions retain caller-supplied ids,
 * where an ordinary miss must stay distinct from a rejected write.
 *
 * NO MOCK CLIENTS. Every failure below is forced at the DATABASE, on a real seeded store in a
 * tmpdir, with a `BEFORE UPDATE ... RAISE(ABORT, …)` trigger scoped to exactly the table (and,
 * where it matters, exactly the row) under test. A mock client cannot catch a wrong-column or
 * wrong-table SQL bug (agents.md Process Hardening #4), and it cannot tell a rejected statement
 * apart from a statement that matched no rows — which is the exact distinction under test.
 * The live store at cmos/db/cmos.sqlite is never opened.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cmosContext, formatContextForLLM } from '../../../src/tools/cmos/cmos-context';
import type { CmosContextParams } from '../../../src/tools/cmos/cmos-context';
import type { NextStepsResult } from '../../../src/tools/cmos/cmos-next-steps';
import type { ConstraintsResult } from '../../../src/tools/cmos/cmos-constraints';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

/** The heading `appendWriteFailures` renders. Its absence is as load-bearing as its presence. */
const WRITE_FAILURE_HEADING = 'Write failures (the database rejected these';
/** The heading `appendWarnings` renders — checked for ABSENCE on the benign-zero path. */
const WARNINGS_HEADING = 'Warnings:';

const FORCED_NEXT_STEPS = 's86-m02b forced next_steps UPDATE failure';
const FORCED_CONSTRAINTS = 's86-m02b forced constraints UPDATE failure';

const DAY_MS = 24 * 60 * 60 * 1000;

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkStore(): { projectRoot: string; dbPath: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m02b-nextsteps-'));
  tmpDirs.push(projectRoot);
  const dbPath = seedCmosDb(projectRoot, { projectName: 'm02b next-steps fixture' });
  reidentifyCmosTestStore(projectRoot);
  withDb(dbPath, (db) =>
    db
      .prepare(`INSERT INTO sprints (id, title, status) VALUES ('sprint-99', 'Target', 'Active')`)
      .run()
  );
  return { projectRoot, dbPath };
}

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Insert a next-step directly. `created_at` is Date.now()-relative — never a literal date, so the
 * fixture cannot rot into a time-bomb (agents.md: no hardcoded dates in tests).
 * `sprint_id`/`mission_id` are left NULL so no FK parents need seeding.
 */
function seedNextStep(dbPath: string, content: string, status: string, ageDays = 3): number {
  return withDb(dbPath, (db) => {
    const info = db
      .prepare(`INSERT INTO next_steps (content, status, created_at) VALUES (?, ?, ?)`)
      .run(content, status, new Date(Date.now() - ageDays * DAY_MS).toISOString());
    return Number(info.lastInsertRowid);
  });
}

/** Insert a constraint. `expiresInDays` < 0 makes it already-expired, which is what bulk archive matches. */
function seedConstraint(
  dbPath: string,
  content: string,
  status: string,
  expiresInDays: number | null
): number {
  return withDb(dbPath, (db) => {
    const info = db
      .prepare(
        `INSERT INTO constraints (content, status, created_at, expires_at) VALUES (?, ?, ?, ?)`
      )
      .run(
        content,
        status,
        new Date(Date.now() - 10 * DAY_MS).toISOString(),
        expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY_MS).toISOString()
      );
    return Number(info.lastInsertRowid);
  });
}

function statusOf(dbPath: string, table: 'next_steps' | 'constraints', id: number): string {
  return withDb(
    dbPath,
    (db) => db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }
  ).status;
}

/**
 * Force the DATABASE to reject the UPDATE. Surgical on purpose: BEFORE UPDATE on ONE table, so
 * reads, migrations (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`) and every other
 * table keep working. A blunter technique (renaming the table) would also break the reads, and a
 * green test could then be green for the wrong reason.
 *
 * `whenClause` narrows the trigger to a single row — SQLite fires a BEFORE UPDATE trigger per
 * matched row, so `WHEN OLD.id = 7` rejects exactly one statement out of a per-id loop.
 */
function forceUpdateFailure(
  dbPath: string,
  table: 'next_steps' | 'constraints',
  message: string,
  whenClause?: string
): void {
  withDb(dbPath, (db) => {
    db.exec(
      `CREATE TRIGGER force_fail_${table} BEFORE UPDATE ON ${table}
       ${whenClause ? `WHEN ${whenClause}` : ''}
       BEGIN SELECT RAISE(ABORT, '${message}'); END;`
    );
  });
}

/**
 * Run the tool the way an agent does: through the `cmos_context` dispatcher, and render with the
 * dispatcher's own `formatContextForLLM`. Asserting on the handler's object alone would miss the
 * defect this mission is about — a warning that lives only in structuredContent is invisible.
 */
async function runContext(
  projectRoot: string,
  params: Omit<CmosContextParams, 'projectRoot'>
): Promise<{ result: Awaited<ReturnType<typeof cmosContext>>; text: string }> {
  const result = await cmosContext({ ...params, projectRoot } as CmosContextParams);
  return { result, text: formatContextForLLM(params.action, result, params.contextType) };
}

function nextStepsData(result: { data?: unknown }): NextStepsResult {
  return result.data as NextStepsResult;
}

function constraintsData(result: { data?: unknown }): ConstraintsResult {
  return result.data as ConstraintsResult;
}

describe('s86-m02b — cmos_context(next_steps) / cmos_context(constraints) write disclosure', () => {
  describe('the forcing mechanism itself', () => {
    it('a RAISE(ABORT) trigger really does reject the UPDATE (and only the UPDATE)', () => {
      // NEGATIVE CONTROL FOR THE WHOLE FILE. Every "the failure was disclosed" assertion below is
      // worthless if the store is broken for some unrelated reason, or if the trigger silently
      // never fires. Prove here that the statement shape under test throws, that a SELECT on the
      // same table still works, and that a non-matching UPDATE (a row the WHEN clause excludes)
      // still succeeds.
      const { dbPath } = mkStore();
      const targeted = seedNextStep(dbPath, 'trigger probe — targeted', 'pending');
      const spared = seedNextStep(dbPath, 'trigger probe — spared', 'pending');
      forceUpdateFailure(dbPath, 'next_steps', FORCED_NEXT_STEPS, `OLD.id = ${targeted}`);

      withDb(dbPath, (db) => {
        expect(() =>
          db.prepare(`UPDATE next_steps SET status = 'completed' WHERE id = ?`).run(targeted)
        ).toThrow(new RegExp(FORCED_NEXT_STEPS));

        // Reads unaffected — the trigger is BEFORE UPDATE, not a table-level outage.
        expect((db.prepare('SELECT COUNT(*) AS c FROM next_steps').get() as { c: number }).c).toBe(
          2
        );

        // The spared row updates normally, so a green disclosure test cannot be a store-wide break.
        expect(
          db.prepare(`UPDATE next_steps SET status = 'completed' WHERE id = ?`).run(spared).changes
        ).toBe(1);
      });
    });
  });

  describe('CRITERION 7 — the DB error code AND message reach the formatted text', () => {
    it('per-id branch: complete', async () => {
      const { projectRoot, dbPath } = mkStore();
      const id = seedNextStep(dbPath, 'complete me', 'pending');
      forceUpdateFailure(dbPath, 'next_steps', FORCED_NEXT_STEPS);

      const { result, text } = await runContext(projectRoot, {
        action: 'next_steps',
        nextStepAction: 'complete',
        nextStepIds: [id],
      } as Omit<CmosContextParams, 'projectRoot'>);

      // success STAYS TRUE. The cure for this defect class is disclosure, not abortion — the
      // tool call did happen, and what failed must be named rather than swallowed OR thrown.
      expect(result.success).toBe(true);

      const d = nextStepsData(result);
      // The count reports the rows the UPDATE ACTUALLY changed, not the ids the caller passed.
      expect(d.affected).toBe(0);
      expect(d.writeFailures).toHaveLength(1);
      expect(d.writeFailures?.[0]).toMatchObject({
        op: `next_steps.complete #${id}`,
        code: 'DB_QUERY_FAILED',
      });
      expect(d.writeFailures?.[0]?.message).toContain(FORCED_NEXT_STEPS);

      // *** THE POINT OF THE MISSION: it must be in the TEXT an agent reads. ***
      expect(text).toContain(WRITE_FAILURE_HEADING);
      expect(text).toContain(`next_steps.complete #${id}`);
      expect(text).toContain('DB_QUERY_FAILED');
      expect(text).toContain(FORCED_NEXT_STEPS);
      // …alongside the honest count, not instead of it.
      expect(text).toContain('0 next-step(s) marked as completed');

      // And the write genuinely did not happen — so the answer above is true, not merely cautious.
      expect(statusOf(dbPath, 'next_steps', id)).toBe('pending');
    });

    it('per-id branch: drop', async () => {
      const { projectRoot, dbPath } = mkStore();
      const id = seedNextStep(dbPath, 'drop me', 'pending');
      forceUpdateFailure(dbPath, 'next_steps', FORCED_NEXT_STEPS);

      const { result, text } = await runContext(projectRoot, {
        action: 'next_steps',
        nextStepAction: 'drop',
        nextStepIds: [id],
      } as Omit<CmosContextParams, 'projectRoot'>);

      expect(result.success).toBe(true);
      const d = nextStepsData(result);
      expect(d.affected).toBe(0);
      // `drop` and `complete` share transitionNextSteps but must not share an op label — an
      // operator has to be able to tell WHICH verb the database rejected.
      expect(d.writeFailures?.[0]?.op).toBe(`next_steps.drop #${id}`);

      expect(text).toContain(WRITE_FAILURE_HEADING);
      expect(text).toContain(`next_steps.drop #${id}`);
      expect(text).toContain('DB_QUERY_FAILED');
      expect(text).toContain(FORCED_NEXT_STEPS);
      expect(statusOf(dbPath, 'next_steps', id)).toBe('pending');
    });

    it('bulk branch: carry-all-pending (no nextStepIds)', async () => {
      const { projectRoot, dbPath } = mkStore();
      const id = seedNextStep(dbPath, 'carry me in bulk', 'pending');
      forceUpdateFailure(dbPath, 'next_steps', FORCED_NEXT_STEPS);

      const { result, text } = await runContext(projectRoot, {
        action: 'next_steps',
        nextStepAction: 'carry',
        carryToSprint: 'sprint-99',
      } as Omit<CmosContextParams, 'projectRoot'>);

      expect(result.success).toBe(true);
      const d = nextStepsData(result);
      expect(d.affected).toBe(0);
      expect(d.writeFailures?.[0]?.op).toBe('next_steps.carry (all pending)');

      expect(text).toContain(WRITE_FAILURE_HEADING);
      expect(text).toContain('next_steps.carry (all pending)');
      expect(text).toContain('DB_QUERY_FAILED');
      expect(text).toContain(FORCED_NEXT_STEPS);
      expect(statusOf(dbPath, 'next_steps', id)).toBe('pending');
    });

    it('per-id branch: carry by id', async () => {
      const { projectRoot, dbPath } = mkStore();
      const id = seedNextStep(dbPath, 'carry me by id', 'pending');
      forceUpdateFailure(dbPath, 'next_steps', FORCED_NEXT_STEPS);

      const { result, text } = await runContext(projectRoot, {
        action: 'next_steps',
        nextStepAction: 'carry',
        nextStepIds: [id],
        carryToSprint: 'sprint-99',
      } as Omit<CmosContextParams, 'projectRoot'>);

      expect(result.success).toBe(true);
      const d = nextStepsData(result);
      expect(d.affected).toBe(0);
      expect(d.writeFailures?.[0]?.op).toBe(`next_steps.carry #${id}`);

      expect(text).toContain(WRITE_FAILURE_HEADING);
      expect(text).toContain(`next_steps.carry #${id}`);
      expect(text).toContain('DB_QUERY_FAILED');
      expect(text).toContain(FORCED_NEXT_STEPS);
      expect(statusOf(dbPath, 'next_steps', id)).toBe('pending');
    });

    it('bulk branch: constraints archive-all-expired (no constraintIds)', async () => {
      const { projectRoot, dbPath } = mkStore();
      // expires_at one day in the PAST → matched by `WHERE status='active' AND expires_at <= now`.
      // A BEFORE UPDATE trigger only fires on rows the WHERE actually matched, so without this
      // row the statement would succeed with changes=0 and prove nothing.
      const id = seedConstraint(dbPath, 'expired rule', 'active', -1);
      forceUpdateFailure(dbPath, 'constraints', FORCED_CONSTRAINTS);

      const { result, text } = await runContext(projectRoot, {
        action: 'constraints',
        constraintAction: 'archive',
      } as Omit<CmosContextParams, 'projectRoot'>);

      expect(result.success).toBe(true);
      const d = constraintsData(result);
      expect(d.affected).toBe(0);
      expect(d.writeFailures?.[0]?.op).toBe('constraints.archive (all expired)');

      expect(text).toContain(WRITE_FAILURE_HEADING);
      expect(text).toContain('constraints.archive (all expired)');
      expect(text).toContain('DB_QUERY_FAILED');
      expect(text).toContain(FORCED_CONSTRAINTS);
      expect(statusOf(dbPath, 'constraints', id)).toBe('active');

      // THE PROSE, NOT JUST THE WRITE-FAILURES BLOCK. `archiveConstraints` used to pick its
      // message off `affected > 0`, so a REJECTED bulk archive rendered "No expired constraints
      // to archive" as the FIRST line an agent reads — untrue here: there was one, and the
      // database refused to archive it. The build-time adversarial critic called that this
      // sprint's own defect class surviving in prose, which it was: structurally the same shape
      // as "Decision Extraction: Extraction skipped". The failure arm no longer borrows the
      // empty case's words, and this asserts it, so a revert cannot pass quietly.
      expect(text).not.toContain('No expired constraints to archive');
      expect(text).toMatch(/Archive FAILED|rejected/i);
    });

    it('per-id branch: constraints archive by id', async () => {
      const { projectRoot, dbPath } = mkStore();
      const id = seedConstraint(dbPath, 'archive me by id', 'active', 30);
      forceUpdateFailure(dbPath, 'constraints', FORCED_CONSTRAINTS);

      const { result, text } = await runContext(projectRoot, {
        action: 'constraints',
        constraintAction: 'archive',
        constraintIds: [id],
      } as Omit<CmosContextParams, 'projectRoot'>);

      expect(result.success).toBe(true);
      const d = constraintsData(result);
      expect(d.affected).toBe(0);
      expect(d.writeFailures?.[0]?.op).toBe(`constraints.archive #${id}`);

      expect(text).toContain(WRITE_FAILURE_HEADING);
      expect(text).toContain(`constraints.archive #${id}`);
      expect(text).toContain('DB_QUERY_FAILED');
      expect(text).toContain(FORCED_CONSTRAINTS);
      expect(statusOf(dbPath, 'constraints', id)).toBe('active');
    });
  });

  describe('s88-m01 — a rejected per-id write is not also an unmatched id', () => {
    it('RED: classifies rejections only as failures in both per-id next-step loops', async () => {
      /**
       * `countWrite` returns zero for TWO mutually exclusive reasons: the statement ran but its
       * WHERE matched nothing, or the database rejected the statement. `unmatchedIds` describes
       * only the first. A rejection must therefore stay solely in `writeFailures`; otherwise the
       * same id is reported both as "the database said no" and "already resolved / absent".
       *
       * One table-driven assertion covers the two independent call sites: `complete` reaches
       * `transitionNextSteps`, while carry-by-id reaches the separate `carryNextSteps` loop.
       * Both operations run before the assertion so the RED diff exposes either misclassification.
       */
      const { projectRoot, dbPath } = mkStore();
      const completeId = seedNextStep(dbPath, 'complete rejection', 'pending');
      const carryId = seedNextStep(dbPath, 'carry rejection', 'pending');
      forceUpdateFailure(dbPath, 'next_steps', FORCED_NEXT_STEPS);

      const complete = await runContext(projectRoot, {
        action: 'next_steps',
        nextStepAction: 'complete',
        nextStepIds: [completeId],
      } as Omit<CmosContextParams, 'projectRoot'>);
      const carry = await runContext(projectRoot, {
        action: 'next_steps',
        nextStepAction: 'carry',
        nextStepIds: [carryId],
        carryToSprint: 'sprint-99',
      } as Omit<CmosContextParams, 'projectRoot'>);

      const classifications = [
        {
          path: 'transitionNextSteps (complete)',
          affected: nextStepsData(complete.result).affected,
          failureOps: nextStepsData(complete.result).writeFailures?.map((failure) => failure.op),
          unmatchedIds: nextStepsData(complete.result).unmatchedIds,
          renderedAsFailure: complete.text.includes(WRITE_FAILURE_HEADING),
          renderedAsUnmatched: complete.text.includes('Not matched'),
          persistedStatus: statusOf(dbPath, 'next_steps', completeId),
        },
        {
          path: 'carryNextSteps (by id)',
          affected: nextStepsData(carry.result).affected,
          failureOps: nextStepsData(carry.result).writeFailures?.map((failure) => failure.op),
          unmatchedIds: nextStepsData(carry.result).unmatchedIds,
          renderedAsFailure: carry.text.includes(WRITE_FAILURE_HEADING),
          renderedAsUnmatched: carry.text.includes('Not matched'),
          persistedStatus: statusOf(dbPath, 'next_steps', carryId),
        },
      ];

      expect(classifications).toEqual([
        {
          path: 'transitionNextSteps (complete)',
          affected: 0,
          failureOps: [`next_steps.complete #${completeId}`],
          unmatchedIds: [],
          renderedAsFailure: true,
          renderedAsUnmatched: false,
          persistedStatus: 'pending',
        },
        {
          path: 'carryNextSteps (by id)',
          affected: 0,
          failureOps: [`next_steps.carry #${carryId}`],
          unmatchedIds: [],
          renderedAsFailure: true,
          renderedAsUnmatched: false,
          persistedStatus: 'pending',
        },
      ]);
    });
  });

  describe('negative control — an UNforced store discloses nothing', () => {
    it('a successful complete and a successful archive render no failure section at all', async () => {
      // Without this, every assertion above could be satisfied by a formatter that ALWAYS prints
      // "Write failures", which would be its own species of saying something not so.
      const { projectRoot, dbPath } = mkStore();
      const stepId = seedNextStep(dbPath, 'this one really completes', 'pending');
      const constraintId = seedConstraint(dbPath, 'this one really archives', 'active', 30);

      const steps = await runContext(projectRoot, {
        action: 'next_steps',
        nextStepAction: 'complete',
        nextStepIds: [stepId],
      } as Omit<CmosContextParams, 'projectRoot'>);

      expect(nextStepsData(steps.result).affected).toBe(1);
      expect(nextStepsData(steps.result).writeFailures).toEqual([]);
      expect(steps.text).not.toContain(WRITE_FAILURE_HEADING);
      expect(steps.text).not.toContain('DB_QUERY_FAILED');
      expect(steps.text).not.toContain(WARNINGS_HEADING);
      expect(statusOf(dbPath, 'next_steps', stepId)).toBe('completed');

      const constraints = await runContext(projectRoot, {
        action: 'constraints',
        constraintAction: 'archive',
        constraintIds: [constraintId],
      } as Omit<CmosContextParams, 'projectRoot'>);

      expect(constraintsData(constraints.result).affected).toBe(1);
      expect(constraintsData(constraints.result).writeFailures).toEqual([]);
      expect(constraints.text).not.toContain(WRITE_FAILURE_HEADING);
      expect(constraints.text).not.toContain('DB_QUERY_FAILED');
      expect(statusOf(dbPath, 'constraints', constraintId)).toBe('archived');
    });
  });

  describe('CRITERION 8 — the benign zero', () => {
    it('completing an ALREADY-completed id reports affected 0 with NO failure and NO warning', async () => {
      /**
       * DO NOT "TIDY" THIS AWAY, AND DO NOT MAKE IT WARN.
       *
       * The ids here come from the TOOL CALL. Nothing re-selected them under the statement's own
       * `AND status = 'pending'` predicate, so `changes === 0` on a statement that RAN
       * SUCCESSFULLY carries exactly one meaning: there is no pending row with that id. It was
       * already completed, or already dropped, or already carried. That is an ordinary outcome of
       * an idempotent call — not evidence that anything failed.
       *
       * Announcing it as a write failure would tell an operator the database rejected something
       * it did not — which is precisely the "say only what you know" violation this whole sprint
       * is closing, committed inside the fix for it. `countWrite` therefore records ONLY on
       * `success: false`, and this test is what stops that from being quietly widened to
       * `success && changes === 0`.
       *
       * THE BOUNDARY: sprint close no longer reuses this predicate or calls `countWrite` for
       * next_steps at all. Its whole-ledger survey performs no status write because provenance is
       * not delivery. This benign-zero contract therefore belongs only to explicit operator
       * transitions, and the five assertions below remain the guard against widening it.
       */
      const { projectRoot, dbPath } = mkStore();
      const id = seedNextStep(dbPath, 'already done before the call', 'completed');
      // No trigger. The statement must RUN and SUCCEED; it simply matches no pending row.

      const { result, text } = await runContext(projectRoot, {
        action: 'next_steps',
        nextStepAction: 'complete',
        nextStepIds: [id],
      } as Omit<CmosContextParams, 'projectRoot'>);

      expect(result.success).toBe(true);

      const d = nextStepsData(result);
      expect(d.affected).toBe(0);
      // EMPTY, not undefined: the channel is present and says "nothing was rejected".
      expect(d.writeFailures).toEqual([]);
      expect(result.warnings ?? []).toEqual([]);

      // Nothing in the text may suggest the database refused anything.
      expect(text).not.toContain(WRITE_FAILURE_HEADING);
      expect(text).not.toContain(WARNINGS_HEADING);
      expect(text).not.toContain('DB_QUERY_FAILED');
      expect(text).toContain('0 next-step(s) marked as completed');

      // The row is untouched — no resolved_at rewrite, no status churn.
      expect(statusOf(dbPath, 'next_steps', id)).toBe('completed');
    });

    it('a benign zero and a real rejection in the SAME call stay separable', async () => {
      // The sharpest form of criterion 8: one call, two ids, two different kinds of zero. The
      // rejected id must be named; the already-completed id must not appear anywhere, and must
      // not inflate `writeFailures` to 2. If the two ever fold together, an operator can no
      // longer tell "you asked twice" from "the database said no".
      const { projectRoot, dbPath } = mkStore();
      const benign = seedNextStep(dbPath, 'already completed', 'completed');
      const rejected = seedNextStep(dbPath, 'pending but the DB will refuse', 'pending');
      const alsoFine = seedNextStep(dbPath, 'pending and will succeed', 'pending');
      forceUpdateFailure(dbPath, 'next_steps', FORCED_NEXT_STEPS, `OLD.id = ${rejected}`);

      const { result, text } = await runContext(projectRoot, {
        action: 'next_steps',
        nextStepAction: 'complete',
        nextStepIds: [benign, rejected, alsoFine],
      } as Omit<CmosContextParams, 'projectRoot'>);

      expect(result.success).toBe(true);
      const d = nextStepsData(result);

      // One row actually changed — the count is the truth about rows, not about ids passed in.
      expect(d.affected).toBe(1);
      expect(d.writeFailures).toHaveLength(1);
      expect(d.writeFailures?.[0]?.op).toBe(`next_steps.complete #${rejected}`);

      expect(text).toContain(`next_steps.complete #${rejected}`);
      expect(text).not.toContain(`next_steps.complete #${benign}`);
      expect(text).not.toContain(`next_steps.complete #${alsoFine}`);
      expect(text).toContain('1 next-step(s) marked as completed');

      expect(statusOf(dbPath, 'next_steps', benign)).toBe('completed');
      expect(statusOf(dbPath, 'next_steps', rejected)).toBe('pending');
      expect(statusOf(dbPath, 'next_steps', alsoFine)).toBe('completed');
    });
  });
});
