// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m02 real-store positive fire: the one-time end_date repair on a COPY of this repo's live
// ABOUTME: store re-dates exactly the sprints whose end_date is later than their recorded close.

/**
 * WHY A LIVE-STORE COPY. The repair's anchors are two tables a fixture only imitates —
 * `session_events` (one row per close since the event log existed) and the `sprint_complete:*`
 * context snapshots — and the defect it repairs is a property of real history: this store's
 * sprint-54 was planned for 2026-05-14 and closed on 2026-04-17. A mock-client test cannot catch a
 * wrong-column or wrong-table anchor query (process hardening practice 4).
 *
 * The expected sets are MEASURED from the copy before the repair runs, by an independent query, so
 * the test stays true as the live store grows. One planned date is also PLANTED on the copy (a
 * Completed sprint anchored by a close event, given a date 30 days after it), so the fire stays
 * positive after the live store's own repair has run at a real close.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { withClientAsync } from '../../../src/tools/cmos/client';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { createSuccess } from '../../../src/tools/cmos/errors';
import {
  END_DATE_REPAIR_MARKER,
  normalizeCloseTimestamp,
  repairCompletedSprintEndDates,
  type SprintEndDateRepair,
} from '../../../src/tools/cmos/sprint-end-date-repair';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The repair is fired against a copy of the private live store's real sprint and close history.",
  paths: { liveDb: 'cmos/db/cmos.sqlite' },
});

interface Anchored {
  id: string;
  endDate: string | null;
  anchor: string | null;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The independent oracle: every Completed sprint with its latest recorded close. */
function readAnchors(dbPath: string): Anchored[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.end_date AS endDate,
                COALESCE(
                  (SELECT MAX(ts) FROM session_events
                    WHERE action = 'sprint_complete' AND mission = s.id),
                  (SELECT MAX(created_at) FROM context_snapshots
                    WHERE source = 'sprint_complete:' || s.id)
                ) AS anchor
           FROM sprints s WHERE s.status = 'Completed' ORDER BY s.id`
      )
      .all() as Anchored[];
    return rows.map((row) => ({
      ...row,
      anchor: row.anchor ? normalizeCloseTimestamp(row.anchor) : null,
    }));
  } finally {
    db.close();
  }
}

const isLaterThanClose = (row: Anchored): boolean =>
  row.anchor !== null &&
  row.endDate !== null &&
  !Number.isNaN(Date.parse(row.endDate)) &&
  Date.parse(row.endDate) > Date.parse(row.anchor);

PRIVATE.describe('s92-m02 end_date repair on a live-store copy', () => {
  let tempRoot: string;
  let copyPath: string;
  let hashBefore: string;
  let planted: string;
  let before: Anchored[];
  let repair: SprintEndDateRepair | null;

  beforeAll(async () => {
    hashBefore = sha256(PRIVATE.paths.liveDb);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's92-m02-repair-'));
    const dbDir = path.join(tempRoot, 'cmos', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    copyPath = path.join(dbDir, 'cmos.sqlite');
    const source = new Database(PRIVATE.paths.liveDb, { readonly: true, fileMustExist: true });
    try {
      await source.backup(copyPath);
    } finally {
      source.close();
    }

    // Plant one planned date on an event-anchored sprint, and clear the marker so the repair runs.
    const db = new Database(copyPath);
    try {
      const target = db
        .prepare(
          `SELECT s.id AS id, MAX(e.ts) AS closedAt FROM sprints s
             JOIN session_events e ON e.mission = s.id AND e.action = 'sprint_complete'
            WHERE s.status = 'Completed' GROUP BY s.id ORDER BY MAX(e.ts) DESC LIMIT 1`
        )
        .get() as { id: string; closedAt: string };
      planted = target.id;
      db.prepare('UPDATE sprints SET end_date = ? WHERE id = ?').run(
        new Date(Date.parse(target.closedAt) + 30 * 24 * 60 * 60 * 1000).toISOString(),
        planted
      );
      db.prepare('DELETE FROM metadata WHERE key = ?').run(END_DATE_REPAIR_MARKER);
    } finally {
      db.close();
    }

    before = readAnchors(copyPath);
    CmosDetector.resetInstance();
    const result = await withClientAsync(
      async (client) => createSuccess(repairCompletedSprintEndDates(client)),
      { projectRoot: tempRoot, registerProject: false }
    );
    repair = result.success ? (result.data ?? null) : null;
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    // The live store itself was only ever read.
    expect(sha256(PRIVATE.paths.liveDb)).toBe(hashBefore);
  });

  it('fires: re-dates exactly the sprints whose end_date is later than their recorded close', () => {
    const expected = before.filter(isLaterThanClose).map((row) => row.id);
    expect(expected).toContain(planted);
    expect(repair).not.toBeNull();
    expect(repair!.failures).toEqual([]);
    expect(repair!.repaired.map((r) => r.sprintId).sort()).toEqual([...expected].sort());
  });

  it('names every Completed sprint that has no recorded close, and leaves it untouched', () => {
    const unanchored = before.filter((row) => row.anchor === null);
    expect(repair!.unanchored).toEqual(
      unanchored.map((row) => ({ sprintId: row.id, endDate: row.endDate }))
    );
    const after = new Map(readAnchors(copyPath).map((row) => [row.id, row]));
    for (const row of unanchored) expect(after.get(row.id)!.endDate).toBe(row.endDate);
  });

  it('leaves no Completed sprint dated later than its close, and touches no correct one', () => {
    const after = readAnchors(copyPath);
    expect(after.filter(isLaterThanClose)).toEqual([]);
    const repairedIds = new Set(repair!.repaired.map((r) => r.sprintId));
    for (const row of before) {
      const now = after.find((candidate) => candidate.id === row.id)!;
      if (repairedIds.has(row.id)) expect(now.endDate).toBe(row.anchor);
      else expect(now.endDate).toBe(row.endDate);
    }
  });

  it('runs once: the marker it wrote makes a second call a no-op', async () => {
    const second = await withClientAsync(
      async (client) => createSuccess(repairCompletedSprintEndDates(client)),
      { projectRoot: tempRoot, registerProject: false }
    );
    expect(second.success).toBe(true);
    expect(second.data).toBeNull();
  });
});
