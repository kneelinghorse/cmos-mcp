// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m02b — three sites that reported INTENT as FACT after the write guard already
// ABOUTME: ran: a borrowed empty-case sentence, an attempted count, and a failed lookup called "not found".

/**
 * Sprint 86 m02b — the findings the BUILD-TIME adversarial critic returned, pinned.
 *
 * All three sites had already been routed through `checkWrite`/`countWrite`, so the AST gate
 * (tests/tools/cmos/no-silent-write.test.ts) was GREEN at every one of them. That is precisely why
 * these tests exist: the gate proves a result is INSPECTED, never that the ANSWER built from it is
 * true. Its own false-negative profile says so. These are the semantic half, by hand.
 *
 *   1. cmos-constraints.ts  — a rejected bulk archive borrowed the EMPTY case's sentence
 *                             ("No expired constraints to archive"), which is a positive claim
 *                             about the corpus the code cannot make: the statement never ran.
 *                             Structurally identical to the mission's flagship exemplar,
 *                             "Decision Extraction: Extraction skipped".
 *   2. cmos-mission-complete.ts — reported `decisionCount: decisions.length`, the number of rows
 *                             it INTENDED to insert, rendered verbatim as "Decisions captured: N".
 *   3. cmos-decisions-batch-update.ts — a FAILED existence SELECT was reported as "Not found",
 *                             which is the worse of the two possible errors: an operator acting on
 *                             "not found" stops trying to update a decision that does exist.
 *
 * Every failure below is forced at the DATABASE on a real store in a tmpdir — a RAISE trigger or a
 * renamed table — never by stubbing a client. A mock cannot catch a wrong-column SQL bug.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cmosContext } from '../../../src/tools/cmos/cmos-context';
import { formatContextForLLM } from '../../../src/tools/cmos/cmos-context';
import { cmosMissionComplete } from '../../../src/tools/cmos/cmos-mission-complete';
import { formatMissionCompleteForLLM } from '../../../src/tools/cmos/cmos-mission-complete';
import { cmosDecisions, formatDecisionsForLLM } from '../../../src/tools/cmos/cmos-decisions';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

const tmpDirs: string[] = [];
function mkStore(): { projectRoot: string; dbPath: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m02b-intent-'));
  tmpDirs.push(projectRoot);
  const dbPath = seedCmosDb(projectRoot, { projectName: 'intent-vs-fact' });
  reidentifyCmosTestStore(projectRoot);
  return { projectRoot, dbPath };
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Reject one statement shape on one table, leaving reads and every other table working. */
function forceFailure(
  dbPath: string,
  table: string,
  verb: 'UPDATE' | 'INSERT',
  message: string
): void {
  withDb(dbPath, (db) => {
    db.exec(
      `CREATE TRIGGER force_${verb.toLowerCase()}_${table} BEFORE ${verb} ON ${table}
       BEGIN SELECT RAISE(ABORT, '${message}'); END;`
    );
  });
}

// ── 1. the borrowed sentence ───────────────────────────────────────────────────────────────

describe("a rejected bulk archive does not borrow the empty case's words", () => {
  const FORCED = 'forced constraints UPDATE failure';

  async function archiveAll(projectRoot: string) {
    const result = await cmosContext({
      action: 'constraints',
      constraintAction: 'archive',
      projectRoot,
    });
    return { result, text: formatContextForLLM('constraints', result) };
  }

  it('NEGATIVE CONTROL: with nothing expired, the empty sentence is the TRUE answer', async () => {
    const { projectRoot } = mkStore();
    const { result, text } = await archiveAll(projectRoot);
    expect(result.success).toBe(true);
    expect(text).toContain('No expired constraints to archive');
    expect(text).not.toContain('Write failures');
  });

  it('says the database rejected it, not that there was nothing to archive', async () => {
    const { projectRoot, dbPath } = mkStore();
    // An expired, still-active constraint MUST exist, or the statement would legitimately match
    // nothing and the empty sentence would be true — the test would prove nothing.
    const expiredAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    withDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO constraints (content, status, created_at, expires_at)
         VALUES (?, 'active', ?, ?)`
      ).run('an expired rule', new Date(Date.now() - 30 * 86400000).toISOString(), expiredAt);
    });
    forceFailure(dbPath, 'constraints', 'UPDATE', FORCED);

    const { result, text } = await archiveAll(projectRoot);

    expect(result.success).toBe(true);
    // THE POINT: the first line an agent reads must not assert a fact about the corpus that the
    // statement never established.
    expect(text).not.toContain('No expired constraints to archive');
    expect(text).toMatch(/Archive FAILED|rejected/i);
    // ...and the DB's own words are still there, in the structured channel and the text.
    expect(text).toContain(FORCED);

    // READ-BACK: the row really is still active, so "archived" would have been false too.
    const status = withDb(
      dbPath,
      (db) =>
        (
          db.prepare(`SELECT status FROM constraints WHERE content = ?`).get('an expired rule') as {
            status: string;
          }
        ).status
    );
    expect(status).toBe('active');
  });
});

// ── 2. the attempted count ─────────────────────────────────────────────────────────────────

describe('mission complete counts decisions that LANDED, not decisions supplied', () => {
  const FORCED = 'forced strategic_decisions INSERT failure';

  function seedMission(dbPath: string, missionId: string): void {
    withDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO missions (id, name, objective, status, created_at)
         VALUES (?, 'A mission', 'do a thing', 'In Progress', ?)`
      ).run(missionId, new Date().toISOString());
    });
  }

  it('NEGATIVE CONTROL: with the INSERT working, all three decisions are counted', async () => {
    const { projectRoot, dbPath } = mkStore();
    seedMission(dbPath, 'm-ok');
    const result = await cmosMissionComplete({
      missionId: 'm-ok',
      notes: 'done',
      decisions: ['one', 'two', 'three'],
      projectRoot,
    });
    expect(result.success).toBe(true);
    expect(result.data?.decisionCount).toBe(3);
    expect(formatMissionCompleteForLLM(result)).toContain('Decisions captured: 3');
    expect(
      withDb(
        dbPath,
        (db) =>
          (db.prepare('SELECT COUNT(*) AS c FROM strategic_decisions').get() as { c: number }).c
      )
    ).toBe(3);
  });

  it('reports 0 — not 3 — when every INSERT is rejected, and says why', async () => {
    const { projectRoot, dbPath } = mkStore();
    seedMission(dbPath, 'm-fail');
    forceFailure(dbPath, 'strategic_decisions', 'INSERT', FORCED);

    const result = await cmosMissionComplete({
      missionId: 'm-fail',
      notes: 'done',
      decisions: ['one', 'two', 'three'],
      projectRoot,
    });
    const text = formatMissionCompleteForLLM(result);

    // The mission still completed — disclosure, not abortion.
    expect(result.success).toBe(true);
    // THE POINT: `decisions.length` was 3. Zero rows landed. The answer must say 0.
    expect(result.data?.decisionCount).toBe(0);
    expect(text).not.toContain('Decisions captured: 3');
    // READ-BACK proves the count is about the database, not about the parameter.
    expect(
      withDb(
        dbPath,
        (db) =>
          (db.prepare('SELECT COUNT(*) AS c FROM strategic_decisions').get() as { c: number }).c
      )
    ).toBe(0);
    // ...and the failure reaches the text an agent reads.
    expect(text).toContain('Warnings:');
    expect(text).toContain(FORCED);
  });
});

// ── 3. "not found" vs "we could not check" ─────────────────────────────────────────────────

describe('a failed decision lookup is not reported as "not found"', () => {
  function seedDecision(dbPath: string, text: string): number {
    return withDb(dbPath, (db) => {
      const info = db
        .prepare(
          `INSERT INTO strategic_decisions (decision_text, created_at, status)
           VALUES (?, ?, 'active')`
        )
        .run(text, new Date().toISOString());
      return Number(info.lastInsertRowid);
    });
  }

  it('NEGATIVE CONTROL: a genuinely absent id IS reported as not found', async () => {
    const { projectRoot } = mkStore();
    const result = await cmosDecisions({
      action: 'batch_update',
      decisionIds: [99999],
      status: 'archived',
      projectRoot,
    });
    const text = formatDecisionsForLLM('batch_update', result);
    expect(result.success).toBe(true);
    expect(text).toMatch(/[Nn]ot found/);
    // The negative control is what makes the positive test meaningful: the fix must not be
    // "never report anything as missing", which would be a different lie.
  });

  it('classifies an errored lookup as UNKNOWN, distinctly from not-found', async () => {
    const { projectRoot, dbPath } = mkStore();
    const id = seedDecision(dbPath, 'a decision that really exists');
    // Rename the table so the existence SELECT errors while the row still exists underneath.
    withDb(dbPath, (db) => db.exec('ALTER TABLE strategic_decisions RENAME TO sd_hidden'));

    const result = await cmosDecisions({
      action: 'batch_update',
      decisionIds: [id],
      status: 'archived',
      projectRoot,
    });
    const text = formatDecisionsForLLM('batch_update', result);

    expect(result.success).toBe(true);
    // THE POINT: this id EXISTS. Calling it "not found" is the worse of the two errors, because
    // the operator's natural next step is to stop trying to update a decision that is really there.
    const data = result.data as { notFound?: number[]; lookupFailed?: number[] };
    expect(data.notFound ?? []).not.toContain(id);
    expect(data.lookupFailed ?? []).toContain(id);
    expect(text).toMatch(/lookup failed|State unknown/i);

    // READ-BACK: the row survived the rename and is still active — "not found" would have been
    // false about the corpus, not merely unhelpful.
    expect(
      withDb(
        dbPath,
        (db) =>
          (db.prepare('SELECT status FROM sd_hidden WHERE id = ?').get(id) as { status: string })
            .status
      )
    ).toBe('active');
  });
});
