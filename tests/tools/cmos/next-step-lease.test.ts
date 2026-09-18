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
  LEASE_LAPSE_AT,
  LEASE_WARN_AT,
} from '../../../src/tools/cmos/next-step-lease';
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
