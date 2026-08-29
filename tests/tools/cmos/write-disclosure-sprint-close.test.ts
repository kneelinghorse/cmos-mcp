// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m02b criterion 4 — cmos_sprint(complete).nextStepsReconciled must equal the rows the
// ABOUTME: UPDATE ACTUALLY changed, and a failed read must warn instead of looking like "nothing to do".

/**
 * Sprint 86 m02b — the highest-value single fix in the sprint: the number the closeout report
 * prints.
 *
 * WHY THIS MATTERS, not just what is asserted. `nextStepsReconciled` is the receipt an operator
 * reads at sprint close to decide whether the next_steps table still owes them anything. Before
 * this mission `reconcileSprintNextStepsTable` bare-executed its bulk UPDATE and then returned
 * `toComplete.length` — the count of rows it INTENDED to close. If the statement errored, the
 * rows stayed `pending` in the database and the closeout still reported them reconciled. The
 * operator's next sprint opens against a table that disagrees with the receipt they trusted, and
 * nothing anywhere says so. That is the defect class this sprint exists to close: an answer
 * derived from intent, presented as fact.
 *
 * THE READ HALF IS THE SAME DEFECT WEARING A DIFFERENT HAT. The id set is built by
 * `SELECT id, content, mission_id FROM next_steps WHERE sprint_id = ? AND status = 'pending'`
 * immediately above the UPDATE. A failed SELECT used to hit a bare `return empty` — reconciled 0,
 * carried 0, nothing flagged. "The read failed" and "there was nothing to reconcile" produced a
 * byte-identical answer.
 *
 * WHY A SHORT COUNT HERE IS A FAILURE AND NOT A BENIGN WHERE-MISS (mission CORRECTION 6). At this
 * site — and NOT at the caller-supplied-id sites in cmos-next-steps.ts — the id set is re-SELECTed
 * under the IDENTICAL `sprint_id = ? AND status = 'pending'` predicate, on the SAME connection,
 * inside the SAME `BEGIN IMMEDIATE` transaction. No row in `toComplete` can leave 'pending'
 * between the SELECT and the UPDATE, so a successful statement always changes exactly
 * `toComplete.length` rows and anything less means the statement errored. That asymmetry is why
 * `countWrite` refuses to judge a zero itself and leaves it to the call site.
 *
 * FAILURES ARE FORCED AT THE DATABASE, NEVER WITH A MOCK CLIENT (agents.md Process Hardening #4).
 * A mock cannot catch a wrong-column or wrong-table SQL bug — the s80-m07 `deleted_at` regression
 * shipped dead-on-arrival precisely because a mock said it worked. Two forcings, chosen so each
 * hits ONE half of the reconcile and leaves the other provably intact:
 *
 *   (a) UPDATE fails, SELECT works — a `BEFORE UPDATE ... RAISE(ABORT)` trigger on `next_steps`.
 *       Surgical: it matches one statement verb on one table, so the SELECT still returns the full
 *       id set and `carried` / `pendingFlagged` stay correct. Only the reconciled count may move.
 *   (b) SELECT fails, UPDATE works — `ALTER TABLE next_steps RENAME COLUMN mission_id TO
 *       mission_id_hidden`. Chosen over renaming the whole TABLE (which kills reads AND writes, so
 *       it could not distinguish the two halves) and over a view-over-a-missing-table (which would
 *       have to replace the real table and take its rows with it). The rename kills exactly the
 *       three-column projection the reconcile SELECT asks for while leaving the table, its rows,
 *       and the UPDATE's own column set untouched — proven by a probe UPDATE at the end of that
 *       test, which is this file's sharpest negative control: the write half still works, so the
 *       reported 0 can only have come from the read.
 *
 * ORDERING HAZARD, LOAD-BEARING. `cmosSprintComplete` runs `ensureFirehoseEventColumns` before its
 * BEGIN, and on a fresh fixture that migration BACKFILLS `next_steps` with an UPDATE and then
 * REBUILDS the table (12-step DROP+RENAME). A trigger installed before the migration would abort
 * the backfill, and would in any case be dropped with the old table. So both migrations are run to
 * completion FIRST, and every test asserts the trigger/rename survived the call — otherwise a
 * green "reconciled 0" could mean the forcing silently evaporated.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withClient } from '../../../src/tools/cmos/client';
import {
  cmosSprintComplete,
  formatSprintCompleteForLLM,
} from '../../../src/tools/cmos/cmos-sprint-complete';
import type { CmosSprintCompleteResult } from '../../../src/tools/cmos/cmos-sprint-complete';
import {
  ensureAuthorNamespaceColumns,
  ensureFirehoseEventColumns,
} from '../../../src/tools/cmos/schema-migrations';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

const CLOSING_SPRINT = 'sprint-86';
const OTHER_SPRINT = 'sprint-87';

/** The exact writeFailures op the reconcile records — see cmos-sprint-complete.ts. */
const RECONCILE_OP = 'next_steps reconciliation';
/** The RAISE(ABORT) payload; better-sqlite3 surfaces it verbatim as the error message. */
const TRIGGER_MESSAGE = 'forced next_steps UPDATE failure';

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface SeededStore {
  readonly projectRoot: string;
  readonly dbPath: string;
}

/**
 * A fixture whose reconcile set is genuinely NON-EMPTY.
 *
 * Two rows FK'd to Completed missions (so `toComplete.length` is 2, and a reported 0 cannot be
 * mistaken for a correct answer), one FK'd to a Blocked mission (carried), one sprint-linked
 * free-text row (flagged), and one row belonging to a different sprint (untouched). The carried
 * and flagged rows are what let case (a) prove the READ still worked while the WRITE failed.
 */
async function buildStore(prefix: string): Promise<SeededStore> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(projectRoot);
  const dbPath = seedCmosDb(projectRoot, { projectName: 's86-m02b sprint close' });
  reidentifyCmosTestStore(projectRoot);

  // No hardcoded dates — everything is relative to now (agents.md: hardcoded timestamps are
  // time-bombs).
  const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const startDate = createdAt.slice(0, 10);

  const db = new Database(dbPath);
  try {
    const insertSprint = db.prepare(
      `INSERT INTO sprints (id, title, focus, status, start_date) VALUES (?, ?, ?, 'Active', ?)`
    );
    insertSprint.run(CLOSING_SPRINT, 'Sprint 86', 'Say only what you know', startDate);
    insertSprint.run(OTHER_SPRINT, 'Sprint 87', 'Not closing', startDate);

    const insertMission = db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertMission.run('s86-m01', CLOSING_SPRINT, 'Mission m01', 'Completed', null, createdAt);
    insertMission.run('s86-m02', CLOSING_SPRINT, 'Mission m02', 'Completed', null, createdAt);
    insertMission.run(
      's86-m03',
      CLOSING_SPRINT,
      'Mission m03',
      'Blocked',
      '[Blocked] waiting on upstream',
      createdAt
    );

    const insertStep = db.prepare(
      `INSERT INTO next_steps (id, content, status, sprint_id, mission_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertStep.run(1, 'wrap up s86-m01', 'pending', CLOSING_SPRINT, 's86-m01', createdAt);
    insertStep.run(2, 'wrap up s86-m02', 'pending', CLOSING_SPRINT, 's86-m02', createdAt);
    insertStep.run(3, 'blocked follow-up', 'pending', CLOSING_SPRINT, 's86-m03', createdAt);
    insertStep.run(4, 'free-text idea, did it ship?', 'pending', CLOSING_SPRINT, null, createdAt);
    insertStep.run(5, 'work for the next sprint', 'pending', OTHER_SPRINT, null, createdAt);
  } finally {
    db.close();
  }

  // Run the lazy migrations to completion BEFORE any forcing is installed. See the ORDERING
  // HAZARD note in the file header — the firehose migration UPDATEs and then REBUILDS next_steps.
  await withClient(
    (client) => {
      ensureFirehoseEventColumns(client);
      ensureAuthorNamespaceColumns(client);
      return { success: true as const, data: null };
    },
    { projectRoot }
  );

  return { projectRoot, dbPath };
}

function readStep(dbPath: string, id: number): { status: string; resolved_at: string | null } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT status, resolved_at FROM next_steps WHERE id = ?').get(id) as {
      status: string;
      resolved_at: string | null;
    };
  } finally {
    db.close();
  }
}

function readSprintStatus(dbPath: string, sprintId: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT status FROM sprints WHERE id = ?').get(sprintId) as
      | { status: string | null }
      | undefined;
    return row?.status ?? null;
  } finally {
    db.close();
  }
}

function objectExists(dbPath: string, type: 'trigger', name: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name = ?`)
      .get(type, name);
    return row !== undefined;
  } finally {
    db.close();
  }
}

function nextStepsColumns(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('PRAGMA table_info(next_steps)').all() as Array<{ name: string }>).map(
      (c) => c.name
    );
  } finally {
    db.close();
  }
}

async function closeSprint(
  projectRoot: string,
  summary: string
): Promise<{ result: CmosToolResult<CmosSprintCompleteResult>; text: string }> {
  const result = await cmosSprintComplete({
    sprintId: CLOSING_SPRINT,
    summary,
    projectRoot,
  });
  return { result, text: formatSprintCompleteForLLM(result) };
}

describe('s86-m02b criterion 4: nextStepsReconciled reports the UPDATE, not the intent', () => {
  it('BASELINE — a healthy close reconciles N > 0 and the rows really are completed', async () => {
    // THE NON-EMPTY BASELINE. Without this, "reports 0 on a forced failure" proves nothing:
    // 0 === 0 passes on any fixture where the reconcile set was empty to begin with.
    const { projectRoot, dbPath } = await buildStore('cmos-m02b-close-baseline-');

    const { result, text } = await closeSprint(projectRoot, 'baseline close');

    expect(result.success).toBe(true);
    const data = result.data as CmosSprintCompleteResult;

    // Two rows FK'd to Completed missions were closed — so the forced-failure cases below are
    // distinguishing 0 from 2, not 0 from 0.
    expect(data.nextStepsReconciled).toBe(2);
    expect(data.nextStepsCarried).toBe(1);
    expect(data.pendingFlagged).toEqual([
      { id: 4, content: 'free-text idea, did it ship?', missionId: null },
    ]);

    // READ-BACK, never a response-shape check: the database agrees with the receipt.
    expect(readStep(dbPath, 1).status).toBe('completed');
    expect(readStep(dbPath, 1).resolved_at).not.toBeNull();
    expect(readStep(dbPath, 2).status).toBe('completed');
    expect(readStep(dbPath, 3).status).toBe('pending'); // carried (blocked-linked)
    expect(readStep(dbPath, 4).status).toBe('pending'); // flagged, never guessed closed
    expect(readStep(dbPath, 5).status).toBe('pending'); // other sprint, untouched

    // A clean close must not invent a failure. `changes: 0` from a WHERE that matched nothing is
    // legitimate elsewhere; here there is nothing to report at all, and the renderer stays silent.
    expect(data.writeFailures).toEqual([]);
    expect(text).not.toContain('Write failures');
    expect(text).not.toContain(RECONCILE_OP);
  });

  it('(a) the reconciliation UPDATE fails: reports 0, not toComplete.length, and names the DB error in the TEXT', async () => {
    const { projectRoot, dbPath } = await buildStore('cmos-m02b-close-update-fail-');

    // FORCED AT THE DATABASE. BEFORE UPDATE only — the SELECT that builds the id set still runs,
    // which is exactly the surgical split this case needs.
    const db = new Database(dbPath);
    try {
      db.exec(
        `CREATE TRIGGER force_next_steps_update_fail BEFORE UPDATE ON next_steps
         BEGIN SELECT RAISE(ABORT, '${TRIGGER_MESSAGE}'); END;`
      );
    } finally {
      db.close();
    }

    const { result, text } = await closeSprint(projectRoot, 'close with a rejected reconcile');

    // The forcing survived the closeout's pre-BEGIN migrations. If it had been dropped by a table
    // rebuild, everything below would pass or fail for the wrong reason.
    expect(objectExists(dbPath, 'trigger', 'force_next_steps_update_fail')).toBe(true);

    // success stays TRUE — the sprint DID close. The cure is disclosure, not abortion (fork f09).
    expect(result.success).toBe(true);
    expect(readSprintStatus(dbPath, CLOSING_SPRINT)).toBe('Completed');

    const data = result.data as CmosSprintCompleteResult;

    // THE CRITERION. Before s86-m02b this was 2 — the rows the code MEANT to close.
    expect(data.nextStepsReconciled).toBe(0);
    expect(data.nextStepsReconciled).not.toBe(2);

    // NEGATIVE CONTROL, and the reason a BEFORE UPDATE trigger was chosen over a table rename:
    // the SELECT still worked, so the read-derived halves of the answer are untouched. A forcing
    // that broke the read too would make the 0 above ambiguous.
    expect(data.nextStepsCarried).toBe(1);
    expect(data.pendingFlagged).toEqual([
      { id: 4, content: 'free-text idea, did it ship?', missionId: null },
    ]);

    // READ-BACK: the reported 0 is the truth on disk, not a shape.
    expect(readStep(dbPath, 1).status).toBe('pending');
    expect(readStep(dbPath, 1).resolved_at).toBeNull();
    expect(readStep(dbPath, 2).status).toBe('pending');

    // The structured Tier-1 channel carries op / code / message separately.
    const failure = data.writeFailures.find((f) => f.op === RECONCILE_OP);
    expect(failure).toBeDefined();
    expect(failure?.code).toBe('DB_QUERY_FAILED');
    expect(failure?.message).toContain(TRIGGER_MESSAGE);

    // THE POINT OF THE MISSION: a failure that lives only in structuredContent is invisible to an
    // agent, which reads content[0].text. Assert the rendered string, with its distinct heading.
    expect(text).toContain(
      'Write failures (the database rejected these; the counts above exclude them):'
    );
    expect(text).toContain(`- ${RECONCILE_OP}: DB_QUERY_FAILED — Query failed: ${TRIGGER_MESSAGE}`);
    // Exactly once — the writeFailures channel and the advisory warnings channel are separate, and
    // neither may double-render the other.
    expect(text.split(TRIGGER_MESSAGE).length - 1).toBe(1);
  });

  it('(b) the SELECT that builds the id set fails: reports 0 AND WARNS, instead of a silent "nothing to reconcile"', async () => {
    const { projectRoot, dbPath } = await buildStore('cmos-m02b-close-select-fail-');

    // FORCED AT THE DATABASE. Renaming the COLUMN (not the table) kills exactly the reconcile
    // SELECT's projection while leaving the table, its rows, and every column the UPDATE names
    // (`status`, `resolved_at`, `id`) in place — so the write half stays demonstrably healthy.
    const db = new Database(dbPath);
    try {
      db.exec('ALTER TABLE next_steps RENAME COLUMN mission_id TO mission_id_hidden');
    } finally {
      db.close();
    }

    const { result, text } = await closeSprint(projectRoot, 'close with an unreadable next_steps');

    // The forcing survived the closeout.
    expect(nextStepsColumns(dbPath)).toContain('mission_id_hidden');
    expect(nextStepsColumns(dbPath)).not.toContain('mission_id');

    expect(result.success).toBe(true);
    expect(readSprintStatus(dbPath, CLOSING_SPRINT)).toBe('Completed');

    const data = result.data as CmosSprintCompleteResult;
    expect(data.nextStepsReconciled).toBe(0);

    // The read failed, so nothing downstream of it can be claimed either.
    expect(data.nextStepsCarried).toBe(0);
    expect(data.pendingFlagged).toEqual([]);

    // READ-BACK: every sprint-linked row is still pending. The close touched none of them.
    for (const id of [1, 2, 3, 4, 5]) {
      expect(readStep(dbPath, id).status).toBe('pending');
    }

    // AND WARNS. This is the whole delta from the pre-mission `return empty`: a 0 that is
    // indistinguishable from "there was nothing to do" is the same lie in a quieter register.
    const warnings = result.warnings ?? [];
    const readWarning = warnings.find((w) => w.includes('next_steps reconciliation skipped'));
    expect(readWarning).toBeDefined();
    expect(readWarning).toContain(CLOSING_SPRINT);
    expect(readWarning).toContain('DB_SCHEMA_MISMATCH');
    expect(readWarning).toContain("Column 'mission_id' does not exist");
    expect(readWarning).toContain('remain pending');

    // Rendered, not merely present.
    expect(text).toContain('Warnings:');
    expect(text).toContain(`- ${readWarning}`);
    expect(text.split("Column 'mission_id' does not exist").length - 1).toBe(1);

    // The UPDATE was never attempted, so claiming a rejected write would itself be this sprint's
    // defect class. The read failure belongs in warnings, NOT in writeFailures.
    expect(data.writeFailures.some((f) => f.op === RECONCILE_OP)).toBe(false);
    expect(text).not.toContain(`- ${RECONCILE_OP}:`);

    // NEGATIVE CONTROL — the sharpest one in this file. Run the reconcile's own UPDATE shape by
    // hand: it still changes rows. So the store is not merely "broken", and the 0 reported above
    // can only have come from the failed READ.
    const probe = new Database(dbPath);
    try {
      const changed = probe
        .prepare(
          `UPDATE next_steps SET status = 'completed', resolved_at = ?
           WHERE id IN (?, ?) AND status = 'pending'`
        )
        .run(new Date().toISOString(), 1, 2);
      expect(changed.changes).toBe(2);
    } finally {
      probe.close();
    }
  });
});
