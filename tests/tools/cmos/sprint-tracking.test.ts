// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s91-m07 — sprint add/update/complete keep master_context.sprint_tracking in step, and the
// ABOUTME: review digest labels a fallback sprint instead of presenting it as the open one.

import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';

import { createSeededCmosProject, type SeededCmosProject } from '../../helpers/seedCmosDb';
import { cmosSprint } from '../../../src/tools/cmos/cmos-sprint';
import { cmosReview, formatReviewForLLM } from '../../../src/tools/cmos/cmos-review';

const projects: SeededCmosProject[] = [];
afterEach(async () => {
  while (projects.length > 0) await projects.pop()!.cleanup();
});

async function seeded(): Promise<SeededCmosProject> {
  const project = await createSeededCmosProject({}, 'cmos-s91-m07-tracking-');
  projects.push(project);
  return project;
}

function tracking(dbPath: string): Record<string, unknown> | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(`SELECT content FROM contexts WHERE id = 'master_context'`).get() as {
      content: string;
    };
    return (JSON.parse(row.content) as { sprint_tracking?: Record<string, unknown> })
      .sprint_tracking;
  } finally {
    db.close();
  }
}

describe('s91-m07 sprint_tracking pointers', () => {
  it('follows add, status update, and close; a close with nothing open leaves current null', async () => {
    const { projectRoot, dbPath } = await seeded();

    const added = await cmosSprint({
      action: 'add',
      sprintId: 'sprint-a',
      title: 'A',
      focus: 'first',
      status: 'Active',
      projectRoot,
    } as never);
    expect(added.success).toBe(true);
    expect(tracking(dbPath)).toMatchObject({
      current_sprint: { id: 'sprint-a', title: 'A', status: 'Active', focus: 'first' },
    });

    await cmosSprint({
      action: 'add',
      sprintId: 'sprint-b',
      title: 'B',
      status: 'Planned',
      projectRoot,
    } as never);
    // A Planned add opens nothing, so the pointer does not move.
    expect(tracking(dbPath)).toMatchObject({ current_sprint: { id: 'sprint-a' } });

    await cmosSprint({
      action: 'update',
      sprintId: 'sprint-b',
      fields: { status: 'Active' },
      projectRoot,
    } as never);
    // The single-current invariant demotes sprint-a; the pointer follows the open sprint.
    expect(tracking(dbPath)).toMatchObject({
      current_sprint: { id: 'sprint-b', status: 'Active' },
    });

    const closed = await cmosSprint({
      action: 'complete',
      sprintId: 'sprint-b',
      summary: 'close b',
      projectRoot,
    } as never);
    expect(closed.success).toBe(true);
    expect(tracking(dbPath)).toEqual(
      expect.objectContaining({ current_sprint: null, last_completed_sprint: 'sprint-b' })
    );
  });

  it('never writes sprint state into project_identity.status or the two dead metadata keys', async () => {
    const { projectRoot, dbPath } = await seeded();
    await cmosSprint({
      action: 'add',
      sprintId: 'sprint-a',
      title: 'A',
      status: 'Active',
      projectRoot,
    } as never);

    const db = new Database(dbPath, { readonly: true });
    try {
      const keys = db
        .prepare(`SELECT key FROM metadata WHERE key IN ('current_sprint', 'sprint_status')`)
        .all();
      expect(keys).toEqual([]);
      const master = JSON.parse(
        (
          db.prepare(`SELECT content FROM contexts WHERE id = 'master_context'`).get() as {
            content: string;
          }
        ).content
      ) as { project_identity?: { status?: string } };
      expect(master.project_identity?.status ?? '').not.toContain('sprint-a');
    } finally {
      db.close();
    }
  });
});

describe('s91-m07 digest fallback label', () => {
  it('labels a Completed sprint named because none is open', async () => {
    const { projectRoot, dbPath } = await seeded();
    const db = new Database(dbPath);
    db.exec(
      `INSERT INTO sprints (id, title, status, end_date) VALUES ('sprint-done', 'Done', 'Completed', '2026-01-01')`
    );
    db.close();

    const review = await cmosReview({ projectRoot });
    expect(review.data!.sprint).toMatchObject({ id: 'sprint-done', resolvedBy: 'fallback' });
    expect(formatReviewForLLM(review)).toContain(
      'Sprint sprint-done: Done [Completed, most recent; none open]'
    );
  });

  it('shows no fallback marker for an Active sprint', async () => {
    const { projectRoot, dbPath } = await seeded();
    const db = new Database(dbPath);
    db.exec(`INSERT INTO sprints (id, title, status) VALUES ('sprint-live', 'Live', 'Active')`);
    db.close();

    const review = await cmosReview({ projectRoot });
    expect(review.data!.sprint).toMatchObject({ id: 'sprint-live', resolvedBy: 'open' });
    expect(formatReviewForLLM(review)).toContain('Sprint sprint-live: Live [Active]');
  });
});
