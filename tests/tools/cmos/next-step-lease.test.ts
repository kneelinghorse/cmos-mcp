// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s91-m06 — the next-steps lease through the real routers: list shows age and lease state,
// ABOUTME: sprint close drops only rows at or past the lapse line, and reopen undoes the drop.

/**
 * THE LEASE (policy 2, operator 2026-09-17). Age = Completed sprints with a recorded end_date
 * later than COALESCE(resolved_at, created_at). Warn at 3, drop at 4 unless carried; carry renews.
 *
 * The fixture reproduces the shape measured on the origin store at planning (nine rows at >= 4,
 * four at 3), including the edge the critic found: the closing sprint's own end_date is written
 * AFTER the survey, so a row at 3 going into the close must be WARNED, not dropped — computing
 * the lease after that write would read it as 4. Dates are Date.now()-relative, never pinned.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  cmosSprintComplete,
  formatSprintCompleteForLLM,
  type CmosSprintCompleteResult,
} from '../../../src/tools/cmos/cmos-sprint-complete';
import { cmosNextSteps } from '../../../src/tools/cmos/cmos-next-steps';
import {
  LEASE_COUNTING_RULE,
  LEASE_IDLE_WARN_DAYS,
  LEASE_LAPSE_AT,
  LEASE_MIN_AGE_DAYS,
  LEASE_WARN_AT,
} from '../../../src/tools/cmos/next-step-lease';
import {
  END_DATE_REPAIR_MARKER,
  normalizeCloseTimestamp,
} from '../../../src/tools/cmos/sprint-end-date-repair';
import { cmosAgentOnboard } from '../../../src/tools/cmos/cmos-agent-onboard';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { withClient } from '../../../src/tools/cmos/client';
import {
  ensureAuthorNamespaceColumns,
  ensureFirehoseEventColumns,
} from '../../../src/tools/cmos/schema-migrations';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString();
const CLOSING = 'sprint-close';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Row id -> expected closes survived going INTO the close. */
const EXPECTED_AGE: Record<number, number> = {
  1: 6, // pending, created before all six closes
  2: 4, // pending
  3: 3, // pending — must be WARNED, not dropped, even though this close ends after it
  4: 0, // pending, fresh
  5: 4, // carried long ago, renewal 45 days back — carried rows lease too
  6: 0, // carried 5 days ago — the carry renewed it
};

function buildStore(): { projectRoot: string; dbPath: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s91-m06-lease-'));
  tmpDirs.push(projectRoot);
  const dbPath = seedCmosDb(projectRoot, { projectName: 's91-m06 lease' });
  reidentifyCmosTestStore(projectRoot);

  const db = new Database(dbPath);
  try {
    const sprint = db.prepare(
      `INSERT INTO sprints (id, title, status, start_date, end_date) VALUES (?, ?, ?, ?, ?)`
    );
    [60, 50, 40, 30, 20, 10].forEach((ago, i) =>
      sprint.run(`sprint-old-${i}`, `Old ${i}`, 'Completed', iso(ago + 9), iso(ago))
    );
    // A legacy Completed sprint with no end_date: the counting rule's named hole, never counted.
    sprint.run('sprint-legacy', 'Legacy', 'Completed', iso(200), null);
    sprint.run(CLOSING, 'Closing', 'Active', iso(9), null);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, created_at) VALUES ('mc-1', ?, 'm', 'Completed', ?)`
    ).run(CLOSING, iso(5));

    const step = db.prepare(
      `INSERT INTO next_steps (id, content, status, sprint_id, created_at, resolved_at, carried_to_sprint)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`
    );
    step.run(1, 'six closes old', 'pending', iso(70), null, null);
    step.run(2, 'four closes old', 'pending', iso(45), null, null);
    step.run(3, 'three closes old', 'pending', iso(35), null, null);
    step.run(4, 'fresh', 'pending', iso(1), null, null);
    step.run(5, 'carried, not renewed since', 'carried', iso(100), iso(45), CLOSING);
    step.run(6, 'carried recently', 'carried', iso(100), iso(5), CLOSING);
    step.run(7, 'already completed', 'completed', iso(100), iso(90), null);
  } finally {
    db.close();
  }
  return { projectRoot, dbPath };
}

function rowsById(dbPath: string): Map<number, Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM next_steps ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    return new Map(rows.map((r) => [r.id as number, r]));
  } finally {
    db.close();
  }
}

describe('s91-m06 next-steps lease', () => {
  it('lists open rows (pending AND carried) by default with age and lease state', async () => {
    const { projectRoot } = buildStore();
    const result = await cmosNextSteps({ nextStepAction: 'list', projectRoot });

    expect(result.success).toBe(true);
    const items = result.data!.items!;
    expect(items.map((i) => i.id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const item of items) {
      expect(item.closesSurvived).toBe(EXPECTED_AGE[item.id]);
    }
    const lease = Object.fromEntries(items.map((i) => [i.id, i.lease]));
    expect(lease).toEqual({
      1: 'lapsing',
      2: 'lapsing',
      3: 'warning',
      4: 'ok',
      5: 'lapsing',
      6: 'ok',
    });

    const pendingOnly = await cmosNextSteps({
      nextStepAction: 'list',
      nextStepStatus: 'pending',
      projectRoot,
    });
    expect(pendingOnly.data!.items!.map((i) => i.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('drops exactly the rows at or past the lapse line inside the close, and nothing else', async () => {
    const { projectRoot, dbPath } = buildStore();
    // The close's lazy firehose migration backfills genesis columns on every row; settle it first
    // so "byte-identical" compares the close's own writes, not the migration's.
    await withClient(
      (client) => {
        ensureFirehoseEventColumns(client);
        ensureAuthorNamespaceColumns(client);
        return { success: true as const, data: null };
      },
      { projectRoot }
    );
    const before = rowsById(dbPath);

    const result = (await cmosSprintComplete({
      sprintId: CLOSING,
      summary: 's91-m06 lease close',
      projectRoot,
    })) as CmosToolResult<CmosSprintCompleteResult>;

    expect(result.success).toBe(true);
    const data = result.data!;
    expect(data.nextStepsSurvey.lease).toEqual({
      warnAt: LEASE_WARN_AT,
      lapseAt: LEASE_LAPSE_AT,
      countingRule: LEASE_COUNTING_RULE,
      warned: [3],
      lapsed: [1, 2, 5],
      minAgeDays: LEASE_MIN_AGE_DAYS,
      heldByMinAge: [],
      idleWarnDays: LEASE_IDLE_WARN_DAYS,
      idle: [],
    });
    expect(data.lapsedDroppedIds).toEqual([1, 2, 5]);
    expect(data.nextStepsSurvey.totalPending).toBe(4);
    expect(data.nextStepsSurvey.totalOpen).toBe(6);

    const after = rowsById(dbPath);
    for (const id of [1, 2, 5]) {
      expect(after.get(id)!.status).toBe('dropped');
      expect(after.get(id)!.resolved_at).not.toBeNull();
    }
    // Every other row is byte-identical — the close still never writes `completed`.
    for (const id of [3, 4, 6, 7]) {
      expect(after.get(id)).toEqual(before.get(id));
    }

    const text = formatSprintCompleteForLLM(result);
    expect(text).toContain(LEASE_COUNTING_RULE);
    expect(text).toContain(`warn at ${LEASE_WARN_AT}`);
    expect(text).toContain(`drop at ${LEASE_LAPSE_AT}`);
    expect(text).toContain(
      'cmos_context(action="next_steps", nextStepAction="reopen", nextStepIds=[1, 2, 5])'
    );
  });

  it('undoes a lease drop with reopen, restarting the clock from created_at', async () => {
    const { projectRoot, dbPath } = buildStore();
    await cmosSprintComplete({ sprintId: CLOSING, summary: 's91-m06 lease close', projectRoot });

    const reopened = await cmosNextSteps({
      nextStepAction: 'reopen',
      nextStepIds: [2],
      projectRoot,
    });
    expect(reopened.data?.affected).toBe(1);
    const row = rowsById(dbPath).get(2)!;
    expect(row.status).toBe('pending');
    expect(row.resolved_at).toBeNull();
  });

  it('renews a lease on carry: a carried row restarts at zero', async () => {
    const { projectRoot } = buildStore();
    const carried = await cmosNextSteps({
      nextStepAction: 'carry',
      nextStepIds: [1],
      projectRoot,
    });
    expect(carried.data?.affected).toBe(1);

    const listed = await cmosNextSteps({ nextStepAction: 'list', projectRoot });
    const row = listed.data!.items!.find((i) => i.id === 1)!;
    expect(row.status).toBe('carried');
    expect(row.closesSurvived).toBe(0);
    expect(row.lease).toBe('ok');
  });
});

/**
 * s92-m02 — THE LEASE COUNTS REAL CLOSES. Every fixture here is a store shape measured in the field:
 * TraceLab's sprints 42–47, 49, 55 and 65 kept a PLANNED end date later than their actual close
 * (3.1.0 wrote `end_date = COALESCE(end_date, ?)`), so rows carried after those closes counted them
 * as closes survived and were dropped minutes after the carry (TraceLab feedback #83).
 */
describe('s92-m02 the lease counts real closes, with the operator calendar bounds', () => {
  const FUTURE = (daysAhead: number): string =>
    new Date(Date.now() + daysAhead * DAY).toISOString();

  function store(prefix: string): { projectRoot: string; dbPath: string } {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(projectRoot);
    const dbPath = seedCmosDb(projectRoot, { projectName: 's92-m02 lease' });
    reidentifyCmosTestStore(projectRoot);
    return { projectRoot, dbPath };
  }

  function addSprint(
    db: Database.Database,
    id: string,
    status: string,
    endDate: string | null,
    closedAt?: string
  ): void {
    db.prepare(
      `INSERT INTO sprints (id, title, status, start_date, end_date) VALUES (?, ?, ?, ?, ?)`
    ).run(id, id, status, iso(120), endDate);
    if (closedAt) {
      db.prepare(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'sprint_complete', 'Completed', 'closed', '{}')`
      ).run(closedAt, id);
    }
  }

  function addClosingSprint(db: Database.Database, endDate: string | null = null): void {
    addSprint(db, CLOSING, 'Active', endDate);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, created_at) VALUES ('mc-1', ?, 'm', 'Completed', ?)`
    ).run(CLOSING, iso(5));
  }

  function addStep(
    db: Database.Database,
    id: number,
    status: 'pending' | 'carried',
    createdAt: string,
    resolvedAt: string | null
  ): void {
    db.prepare(
      `INSERT INTO next_steps (id, content, status, sprint_id, created_at, resolved_at, carried_to_sprint)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`
    ).run(id, `step ${id}`, status, createdAt, resolvedAt, status === 'carried' ? CLOSING : null);
  }

  function sprintEndDate(dbPath: string, id: string): string | null {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (
        db.prepare('SELECT end_date FROM sprints WHERE id = ?').get(id) as {
          end_date: string | null;
        }
      ).end_date;
    } finally {
      db.close();
    }
  }

  it('keeps a freshly carried row: closes that happened BEFORE the carry never count (red in 3.1.0)', async () => {
    const { projectRoot, dbPath } = store('cmos-s92-m02-carry-');
    const db = new Database(dbPath);
    try {
      // Four sprints closed 10, 8, 6 and 4 days ago, each still carrying a planned end date 5-8
      // days in the FUTURE — exactly the TraceLab shape.
      [10, 8, 6, 4].forEach((closedDaysAgo, i) =>
        addSprint(db, `sprint-planned-${i}`, 'Completed', FUTURE(5 + i), iso(closedDaysAgo))
      );
      addClosingSprint(db);
      addStep(db, 1, 'carried', iso(60), iso(1)); // carried yesterday, after all four closes
    } finally {
      db.close();
    }

    const listed = await cmosNextSteps({ nextStepAction: 'list', projectRoot });
    const row = listed.data!.items!.find((item) => item.id === 1)!;
    expect(row.closesSurvived).toBe(0);
    expect(row.lease).toBe('ok');

    const closed = (await cmosSprintComplete({
      sprintId: CLOSING,
      summary: 's92-m02 carry',
      projectRoot,
    })) as CmosToolResult<CmosSprintCompleteResult>;
    expect(closed.success).toBe(true);
    expect(closed.data!.lapsedDroppedIds).toEqual([]);
    // The one-time repair re-dated all four to their recorded closes.
    expect(closed.data!.endDateRepair!.repaired.map((r) => r.sprintId).sort()).toEqual([
      'sprint-planned-0',
      'sprint-planned-1',
      'sprint-planned-2',
      'sprint-planned-3',
    ]);
    expect(rowsById(dbPath).get(1)!.status).toBe('carried');
  });

  it('stamps the actual close time and reports the planned end date', async () => {
    const { projectRoot, dbPath } = store('cmos-s92-m02-stamp-');
    const planned = FUTURE(7);
    const db = new Database(dbPath);
    try {
      addClosingSprint(db, planned);
    } finally {
      db.close();
    }

    const closed = (await cmosSprintComplete({
      sprintId: CLOSING,
      summary: 's92-m02 stamp',
      projectRoot,
    })) as CmosToolResult<CmosSprintCompleteResult>;

    expect(closed.data!.plannedEndDate).toBe(planned);
    expect(sprintEndDate(dbPath, CLOSING)).toBe(closed.data!.completedAt);
    expect(formatSprintCompleteForLLM(closed)).toContain(`the planned end date was ${planned}`);
  });

  it('never drops a row younger than 14 days, however many closes it survived', async () => {
    const { projectRoot, dbPath } = store('cmos-s92-m02-floor-');
    const db = new Database(dbPath);
    try {
      // Five closes in the last six days (TraceLab: five closes in 45 hours).
      [6, 5, 4, 3, 2].forEach((ago, i) =>
        addSprint(db, `sprint-fast-${i}`, 'Completed', iso(ago), iso(ago))
      );
      addClosingSprint(db);
      addStep(db, 1, 'pending', iso(10), null); // 5 closes, 10 days old → kept by the floor
      addStep(db, 2, 'pending', iso(20), null); // 5 closes, 20 days old → dropped
    } finally {
      db.close();
    }

    const closed = (await cmosSprintComplete({
      sprintId: CLOSING,
      summary: 's92-m02 floor',
      projectRoot,
    })) as CmosToolResult<CmosSprintCompleteResult>;

    const lease = closed.data!.nextStepsSurvey.lease!;
    expect(lease.lapsed).toEqual([2]);
    expect(lease.heldByMinAge).toEqual([1]);
    expect(closed.data!.lapsedDroppedIds).toEqual([2]);
    const after = rowsById(dbPath);
    expect(after.get(1)!.status).toBe('pending');
    expect(after.get(2)!.status).toBe('dropped');
    expect(formatSprintCompleteForLLM(closed)).toContain(
      `Kept by the ${LEASE_MIN_AGE_DAYS}-day floor`
    );
  });

  it('warns about a row that survived no close for 6 weeks, and never drops by the calendar alone', async () => {
    const { projectRoot, dbPath } = store('cmos-s92-m02-idle-');
    const db = new Database(dbPath);
    try {
      addClosingSprint(db);
      addStep(db, 1, 'pending', iso(400), null); // a very old row in a project with no closes
      addStep(db, 2, 'pending', iso(30), null); // younger than 6 weeks
    } finally {
      db.close();
    }

    const listed = await cmosNextSteps({ nextStepAction: 'list', projectRoot });
    const leaseById = Object.fromEntries(listed.data!.items!.map((i) => [i.id, i.lease]));
    expect(leaseById).toEqual({ 1: 'idle', 2: 'ok' });

    const onboard = await cmosAgentOnboard({ projectRoot });
    expect(onboard.data!.suggestedActions.map((a) => a.action).join('\n')).toContain(
      `1 next-step(s) idle for ${LEASE_IDLE_WARN_DAYS}+ days with no sprint close: #1`
    );

    const closed = (await cmosSprintComplete({
      sprintId: CLOSING,
      summary: 's92-m02 idle',
      projectRoot,
    })) as CmosToolResult<CmosSprintCompleteResult>;
    expect(closed.data!.nextStepsSurvey.lease!.idle).toEqual([1]);
    expect(closed.data!.lapsedDroppedIds).toEqual([]);
    expect(rowsById(dbPath).get(1)!.status).toBe('pending');
  });

  it('repairs once: anchors on the close event, else the close snapshot, and names the unanchored', async () => {
    const { projectRoot, dbPath } = store('cmos-s92-m02-repair-');
    const eventClose = iso(9);
    const snapshotClose = new Date(Date.now() - 7 * DAY).toISOString();
    const snapshotCloseSqlite = snapshotClose.replace('T', ' ').replace(/\.\d+Z$/, '');
    const correctClose = iso(20);
    const unanchoredEnd = iso(30);
    const db = new Database(dbPath);
    try {
      addSprint(db, 'sprint-event', 'Completed', iso(1), eventClose); // planned later than its close
      addSprint(db, 'sprint-snapshot', 'Completed', iso(1)); // anchored by a snapshot only
      db.prepare(
        `INSERT INTO context_snapshots (context_id, content, content_hash, source, created_at)
         VALUES ('master_context', '{}', 'h-snap', 'sprint_complete:sprint-snapshot', ?)`
      ).run(snapshotCloseSqlite);
      addSprint(db, 'sprint-correct', 'Completed', correctClose, correctClose); // already right
      addSprint(db, 'sprint-unanchored', 'Completed', unanchoredEnd); // nothing records its close
      addClosingSprint(db);
      // A second sprint to close afterwards, proving the repair runs once.
      addSprint(db, 'sprint-two', 'Planned', null);
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, created_at) VALUES ('mc-2', 'sprint-two', 'm', 'Completed', ?)`
      ).run(iso(1));
    } finally {
      db.close();
    }

    const first = (await cmosSprintComplete({
      sprintId: CLOSING,
      summary: 's92-m02 repair',
      projectRoot,
    })) as CmosToolResult<CmosSprintCompleteResult>;
    const repair = first.data!.endDateRepair!;
    expect(repair.failures).toEqual([]);
    expect(Object.fromEntries(repair.repaired.map((r) => [r.sprintId, r.anchor]))).toEqual({
      'sprint-event': 'session_event',
      'sprint-snapshot': 'snapshot',
    });
    expect(repair.unanchored).toEqual([{ sprintId: 'sprint-unanchored', endDate: unanchoredEnd }]);
    // Re-dated to the recorded close; the snapshot's SQLite timestamp is stored back as ISO-8601.
    expect(sprintEndDate(dbPath, 'sprint-event')).toBe(eventClose);
    expect(sprintEndDate(dbPath, 'sprint-snapshot')).toBe(
      `${snapshotCloseSqlite.replace(' ', 'T')}Z`
    );
    // A sprint already dated to its close, and one with no anchor, are left exactly as they were.
    expect(sprintEndDate(dbPath, 'sprint-correct')).toBe(correctClose);
    expect(sprintEndDate(dbPath, 'sprint-unanchored')).toBe(unanchoredEnd);

    // Marker-gated: the next close neither repeats it nor reports it.
    const markerDb = new Database(dbPath, { readonly: true });
    try {
      expect(
        markerDb.prepare('SELECT value FROM metadata WHERE key = ?').get(END_DATE_REPAIR_MARKER)
      ).toBeDefined();
    } finally {
      markerDb.close();
    }
    const second = (await cmosSprintComplete({
      sprintId: 'sprint-two',
      summary: 's92-m02 second close',
      projectRoot,
    })) as CmosToolResult<CmosSprintCompleteResult>;
    expect(second.success).toBe(true);
    expect(second.data!.endDateRepair).toBeUndefined();
  });

  it('normalizes SQLite CURRENT_TIMESTAMP spellings and leaves ISO strings alone', () => {
    expect(normalizeCloseTimestamp('2026-10-02 03:16:22')).toBe('2026-10-02T03:16:22Z');
    expect(normalizeCloseTimestamp('2026-10-02T03:16:22.662Z')).toBe('2026-10-02T03:16:22.662Z');
  });
});
