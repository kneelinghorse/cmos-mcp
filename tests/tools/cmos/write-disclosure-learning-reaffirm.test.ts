// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m02b criterion 6 — a failed learning-reaffirm query must not be reported as
// ABOUTME: "your citations do not exist". Forced at the DB, asserted through cmos_session(capture).

/**
 * Sprint 86 m02b — learning-reaffirm: a false claim about the CORPUS.
 *
 * WHY THIS MATTERS, not just what it asserts (agents.md Rule 9).
 *
 * `reaffirmLearningsByIds` (learning-reaffirm.ts) answers one question — "which of the learning
 * ids this capture cited actually exist?" — with ONE existence SELECT, and folds the answer into
 * a Set. Before s86-m02b the failure arm was `if (!existsResult.success || !existsResult.data)`
 * treated as "no rows came back", so a SELECT that ERRORED produced an EMPTY set, and the loop
 * below it then classified EVERY cited id as absent. The caller
 * (cmos-session-capture.ts, the `applyLearningReaffirm` block) copies that list onto
 * `missingCitedLearningIds`.
 *
 * The result an agent read was: "learning 41 does not exist." That is not an omission and it is
 * not a degraded answer — it is a POSITIVE, FALSE claim about the institutional corpus, produced
 * by a query that never ran. An agent that believes it will re-capture a learning that already
 * exists, or stop citing a rule that is still true. The database never said the learning was
 * gone; the code said it, on the database's behalf, without evidence.
 *
 * The cure is DISCLOSURE, NOT SILENCE, and this file asserts both halves:
 *   1. NOTHING is classified — no cited id may appear in `missingCitedLearningIds` merely
 *      because the query errored; and
 *   2. the DB error REACHES THE ANSWER TEXT. "Say only what you know" is not satisfied by
 *      knowing nothing and saying nothing: an agent reading `content[0].text` must be able to
 *      tell "your citations are fine" from "we could not check". src/index.ts hands the agent
 *      `formatSessionCaptureForLLM(result)` as the text channel, so a disclosure that lives only
 *      in `structuredContent` is invisible in practice — that is the entire defect this sprint
 *      exists to close.
 *
 * NEGATIVE CONTROL, and it is what makes this file mean anything. With the SELECT WORKING, a
 * genuinely absent id MUST still be reported. Otherwise "never report anything missing" would
 * pass every assertion here — a different lie, told in the opposite direction.
 *
 * FAULT INJECTION IS AT THE DATABASE, NEVER A MOCK CLIENT (agents.md Process Hardening #4). A
 * mock cannot catch a wrong-column or wrong-table SQL bug. Each store is a real `seedCmosDb`
 * SQLite file in an `fs.mkdtempSync` dir; the live `cmos/db/cmos.sqlite` is never opened.
 *   - the existence SELECT is broken by renaming `learnings` out from under it;
 *   - the reaffirm UPDATE is broken by a `BEFORE UPDATE` RAISE(ABORT) trigger, which leaves
 *     every read working so the two failure modes stay distinguishable.
 * Each injection is PROBED (the failure message is asserted to name the intended cause) so a
 * store broken for some unrelated reason cannot masquerade as a successful reproduction.
 *
 * WHERE THE CONTRACT BINDS. `reaffirmLearningsByIds` records its DB errors onto the
 * `writeFailures` its `LearningReaffirmOutcome` returns; that is the producer. This file asserts
 * the CONSUMER end — the `applyLearningReaffirm` block in cmos-session-capture.ts must route
 * those failures onto the answer's own `writeFailures`, the field `appendWriteFailures` renders,
 * exactly as it already routes `missingIds` onto `missingCitedLearningIds`. A producer that
 * records a failure nobody forwards is the same silence the caller had before, one layer down.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  cmosSessionCapture,
  formatSessionCaptureForLLM,
} from '../../../src/tools/cmos/cmos-session-capture';
import { seedCmosDb } from '../../helpers/seedCmosDb';

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m02b-reaffirm-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Content deliberately kept to a handful of words.
 *
 * `detectImplicitLearningCites` bails before touching `learnings` when the capture yields fewer
 * than IMPLICIT_REAFFIRM_KEYWORD_FLOOR (15) keywords. Staying under that floor keeps the ONLY
 * `learnings` traffic in these tests the explicit existence SELECT and its UPDATE — so a broken
 * `learnings` table proves something about the explicit path and nothing else.
 */
const SHORT_CONTENT = 'reaffirm probe';

interface CaptureShape {
  explicitlyReaffirmedLearningIds?: number[];
  implicitlyReaffirmedLearningIds?: number[];
  missingCitedLearningIds?: number[];
  writeFailures?: Array<{ op: string; code: string; message: string }>;
}

/** No hardcoded dates — session ids and timestamps are derived from the clock at run time. */
function today(): string {
  return new Date(Date.now()).toISOString().slice(0, 10);
}

interface Fixture {
  projectRoot: string;
  dbPath: string;
  sessionId: string;
  /** Ids of learning rows that genuinely exist in this store. */
  existingLearningIds: number[];
  /** The stale `last_reviewed_at` every seeded learning starts at, for read-back comparisons. */
  staleStamp: string;
}

/** An id no seeded row can carry, so "missing" means missing and not "id collided with a seed". */
const DEFINITELY_ABSENT_LEARNING_ID = 987654;

/**
 * A `last_reviewed_at` value old enough that any real bump is unmistakable.
 *
 * Date.now()-relative, never a literal (agents.md: hardcoded timestamps become time-bombs).
 */
function staleReviewStamp(): string {
  return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Build a real store, seed learnings + an active session, and WARM IT UP with one clean capture
 * that CITES those learnings.
 *
 * Both halves of the warm-up are load-bearing:
 *   - `cmos_session(capture)` runs several marker-gated lazy migrations
 *     (`ensureFirehoseEventColumns`, `ensureAuthorNamespaceColumns`), so applying them BEFORE the
 *     fault is injected keeps the observed failure the reaffirm query itself rather than a
 *     migration tripping over the sabotage;
 *   - the citation matters because `reaffirmLearningsByIds` returns early on an empty id list,
 *     BEFORE `ensureReviewTimestamps` — so a warm-up that cited nothing would leave
 *     `learnings.last_reviewed_at` non-existent and the read-back below impossible.
 *
 * Every row is then stamped with a stale review time, so "the timestamp did not move" is a real
 * observation about the row and not an artifact of the column having started out NULL.
 */
async function makeFixture(suffix: string): Promise<Fixture> {
  const projectRoot = mkTmp();
  const dbPath = seedCmosDb(projectRoot, { projectName: `m02b reaffirm ${suffix}` });
  const sessionId = `PS-${today()}-${suffix}`;
  const nowIso = new Date(Date.now()).toISOString();

  const db = new Database(dbPath);
  let existingLearningIds: number[];
  try {
    db.prepare(
      `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures)
       VALUES (?, 'build', 'm02b reaffirm fixture', NULL, ?, 'jest', 'active', '[]')`
    ).run(sessionId, nowIso);
    db.prepare(
      `INSERT INTO learnings (content, category, status, created_at) VALUES (?, 'process', 'active', ?)`
    ).run('An institutional rule that is still true.', nowIso);
    db.prepare(
      `INSERT INTO learnings (content, category, status, created_at) VALUES (?, 'process', 'active', ?)`
    ).run('A second institutional rule, also still true.', nowIso);
    existingLearningIds = (
      db.prepare('SELECT id FROM learnings ORDER BY id').all() as Array<{ id: number }>
    ).map((r) => r.id);
  } finally {
    db.close();
  }
  expect(existingLearningIds.length).toBe(2);
  expect(existingLearningIds).not.toContain(DEFINITELY_ABSENT_LEARNING_ID);

  // Warm-up capture: applies every lazy migration on the real handler path, including the
  // `last_reviewed_at` column that only the citing branch reaches.
  await cmosSessionCapture({
    sessionId,
    category: 'decision',
    content: `warm up ${suffix}`,
    citesLearningIds: existingLearningIds,
    projectRoot,
  });

  const staleStamp = staleReviewStamp();
  const stamp = new Database(dbPath);
  try {
    const columns = (
      stamp.prepare('PRAGMA table_info(learnings)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    // PROBE: if the warm-up did not land the column, the read-back below would silently test
    // nothing. Fail here instead.
    expect(columns).toContain('last_reviewed_at');
    stamp.prepare('UPDATE learnings SET last_reviewed_at = ?').run(staleStamp);
  } finally {
    stamp.close();
  }

  return { projectRoot, dbPath, sessionId, existingLearningIds, staleStamp };
}

async function captureCiting(fixture: Fixture, citesLearningIds: number[]) {
  const result = await cmosSessionCapture({
    sessionId: fixture.sessionId,
    category: 'decision',
    content: SHORT_CONTENT,
    citesLearningIds,
    projectRoot: fixture.projectRoot,
  });
  return { result, data: result.data as CaptureShape, text: formatSessionCaptureForLLM(result) };
}

function lastReviewedAt(dbPath: string, id: number): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT last_reviewed_at FROM learnings WHERE id = ?').get(id) as
      | { last_reviewed_at: string | null }
      | undefined;
    return row?.last_reviewed_at ?? null;
  } finally {
    db.close();
  }
}

describe('s86-m02b — a failed learning-reaffirm query is disclosed, not reported as "missing"', () => {
  describe('NEGATIVE CONTROL: with the queries working, the tool still tells the truth', () => {
    it('reports a genuinely absent cited id as missing, and reaffirms the ones that exist', async () => {
      // Without this, "never report anything missing" would satisfy every other test in the file.
      const fixture = await makeFixture('101');
      const [existing] = fixture.existingLearningIds;

      const { result, data, text } = await captureCiting(fixture, [
        existing,
        DEFINITELY_ABSENT_LEARNING_ID,
      ]);

      expect(result.success).toBe(true);
      expect(data.missingCitedLearningIds).toEqual([DEFINITELY_ABSENT_LEARNING_ID]);
      expect(data.explicitlyReaffirmedLearningIds).toEqual([existing]);

      // Read-back, never a response-shape check: the row's clock really moved off the stale
      // stamp, and the row that was NOT cited did not move. Reporting a reaffirm the DB never
      // performed is the same defect class as reporting a citation the DB never denied.
      expect(lastReviewedAt(fixture.dbPath, existing)).not.toBe(fixture.staleStamp);
      const uncited = fixture.existingLearningIds[1];
      expect(lastReviewedAt(fixture.dbPath, uncited)).toBe(fixture.staleStamp);

      // A clean run must NOT print a write-failure section — an empty channel renders nothing.
      expect(data.writeFailures).toEqual([]);
      expect(text).not.toContain('Write failures');
    });
  });

  describe('the existence SELECT errors (learning-reaffirm.ts — the fold into an empty Set)', () => {
    /**
     * Rename `learnings` out from under `SELECT id FROM learnings WHERE id IN (…)`. Blunt on
     * purpose: this arm is about the READ failing, and the rename makes it fail at SQLite with a
     * message we can positively identify rather than at a stub we wrote.
     */
    function breakTheExistenceSelect(dbPath: string): void {
      const db = new Database(dbPath);
      try {
        db.exec('ALTER TABLE learnings RENAME TO learnings_hidden');
        // PROBE the injection at the raw DB, independent of the channel under test: the exact
        // statement `reaffirmLearningsByIds` issues must now error, and the rows must still be
        // there under the new name. A test that passed because the fixture was empty, or because
        // the rename silently did nothing, would prove nothing at all.
        expect(() => db.prepare('SELECT id FROM learnings WHERE id IN (?)').all(1)).toThrow(
          /no such table: learnings/
        );
        expect(
          (db.prepare('SELECT COUNT(*) AS c FROM learnings_hidden').get() as { c: number }).c
        ).toBe(2);
      } finally {
        db.close();
      }
    }

    it('classifies NO cited id as missing, and says why in the text an agent reads', async () => {
      const fixture = await makeFixture('102');
      const [existing] = fixture.existingLearningIds;
      breakTheExistenceSelect(fixture.dbPath);

      const { result, data, text } = await captureCiting(fixture, [
        existing,
        DEFINITELY_ABSENT_LEARNING_ID,
      ]);

      // success stays TRUE: the capture happened. The class is "assert something not so", not
      // "keep going after a failure" (fork f09) — so the answer is kept and corrected, not aborted.
      expect(result.success).toBe(true);

      // (1) NOTHING IS CLASSIFIED. Neither the id that exists nor the id that genuinely does not
      // may be called missing on the strength of a query that errored. The genuinely-absent id is
      // in this list precisely so the assertion cannot be satisfied by luck: the ONLY correct
      // answer here is "we did not check", and the negative control above proves that the same
      // id IS reported when the check actually runs.
      expect(data.missingCitedLearningIds ?? []).toEqual([]);
      expect(data.explicitlyReaffirmedLearningIds ?? []).toEqual([]);

      // (2) THE FAILURE REACHES THE ANSWER. Structured channel first...
      const failures = data.writeFailures ?? [];
      const reaffirmFailure = failures.find((f) => /learning/i.test(f.op));
      expect(reaffirmFailure).toBeDefined();
      // ...and the probe: this failed for the reason we injected, not for some unrelated breakage.
      // Matched on the SUBSTANCE (it names the missing table) rather than on one layer's exact
      // wording: CmosDatabaseClient translates SQLite's "no such table: learnings" into
      // "Table 'learnings' does not exist", and pinning either phrasing would make this test
      // fail on a message improvement rather than on a behaviour regression.
      expect(reaffirmFailure?.message).toMatch(/learnings/);
      expect(reaffirmFailure?.message).toMatch(/no such table|does not exist/i);

      // (3) ...AND THE TEXT. A disclosure only present in structuredContent is invisible to the
      // agent, which is the defect s86-m02/m02b exist to close.
      expect(text).toContain('Write failures');
      expect(text).toMatch(/learnings existence lookup/);
      expect(text).toMatch(/no such table|does not exist/i);
    });
  });

  describe('the reaffirm UPDATE errors (learning-reaffirm.ts — the bare UPDATE)', () => {
    /**
     * A surgical `BEFORE UPDATE` RAISE(ABORT) on `learnings`: every read still works, so the
     * existence SELECT succeeds and classification is correct — only the write fails. That keeps
     * this case distinguishable from the SELECT case above instead of collapsing both into
     * "the learnings table is broken".
     */
    function breakTheReaffirmUpdate(dbPath: string): void {
      const db = new Database(dbPath);
      try {
        db.exec(`
          CREATE TRIGGER force_reaffirm_update_fail BEFORE UPDATE ON learnings
          BEGIN SELECT RAISE(ABORT, 'forced reaffirm UPDATE failure'); END;
        `);
        // PROBE both halves of the injection, at the raw DB: the UPDATE must abort, and the
        // SELECT must still work — otherwise this test would silently degenerate into a second
        // copy of the broken-SELECT case above.
        expect(() =>
          db.prepare('UPDATE learnings SET last_reviewed_at = ? WHERE id IN (?)').run('x', 1)
        ).toThrow(/forced reaffirm UPDATE failure/);
        expect((db.prepare('SELECT id FROM learnings').all() as unknown[]).length).toBe(2);
      } finally {
        db.close();
      }
    }

    it('reaffirms nothing, calls nothing missing, and names the rejected write', async () => {
      const fixture = await makeFixture('103');
      const cited = fixture.existingLearningIds;
      breakTheReaffirmUpdate(fixture.dbPath);

      const before = cited.map((id) => lastReviewedAt(fixture.dbPath, id));
      expect(before).toEqual(cited.map(() => fixture.staleStamp));

      const { result, data, text } = await captureCiting(fixture, cited);

      expect(result.success).toBe(true);

      // The rows EXIST — the SELECT proved that — so calling them missing would be the same
      // false claim by another route. And nothing was bumped, so nothing may be reported bumped.
      expect(data.missingCitedLearningIds ?? []).toEqual([]);
      expect(data.explicitlyReaffirmedLearningIds ?? []).toEqual([]);

      // READ-BACK, not a response-shape check: the timestamps really did not move.
      expect(cited.map((id) => lastReviewedAt(fixture.dbPath, id))).toEqual(before);

      const failures = data.writeFailures ?? [];
      const updateFailure = failures.find((f) => /learning/i.test(f.op));
      expect(updateFailure).toBeDefined();
      expect(updateFailure?.message).toMatch(/forced reaffirm UPDATE failure/);

      expect(text).toContain('Write failures');
      expect(text).toMatch(/forced reaffirm UPDATE failure/);
    });
  });
});
