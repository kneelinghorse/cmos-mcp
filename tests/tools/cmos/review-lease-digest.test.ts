// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s91-m06 — cmos_review's next_actions names the next-steps the next close will drop, and
// ABOUTME: flags a mission In Progress with no active session (feedback #40), inside the 4 KB budget.

import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';

import { createSeededCmosProject, type SeededCmosProject } from '../../helpers/seedCmosDb';
import { cmosReview, formatReviewForLLM } from '../../../src/tools/cmos/cmos-review';
import { cmosAgentOnboard } from '../../../src/tools/cmos/cmos-agent-onboard';

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString();

const projects: SeededCmosProject[] = [];
afterEach(async () => {
  while (projects.length > 0) await projects.pop()!.cleanup();
});

async function seeded(withInProgressMission: boolean): Promise<SeededCmosProject> {
  const project = await createSeededCmosProject({}, 'cmos-s91-m06-review-');
  projects.push(project);
  const db = new Database(project.dbPath);
  try {
    const sprint = db.prepare(
      `INSERT INTO sprints (id, title, status, start_date, end_date) VALUES (?, ?, ?, ?, ?)`
    );
    [50, 40, 30, 20, 10].forEach((ago, i) =>
      sprint.run(`sprint-old-${i}`, `Old ${i}`, 'Completed', iso(ago + 9), iso(ago))
    );
    sprint.run('sprint-now', 'Now', 'Active', iso(5), null);
    // Open work in the sprint, so the unrelated "all missions complete" prompt does not fire.
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, created_at) VALUES ('m-next', 'sprint-now', 'q', 'Queued', ?)`
    ).run(iso(3));
    if (withInProgressMission) {
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, created_at) VALUES ('m-now', 'sprint-now', 'n', 'In Progress', ?)`
      ).run(iso(2));
    }
    const step = db.prepare(
      `INSERT INTO next_steps (id, content, status, created_at) VALUES (?, ?, 'pending', ?)`
    );
    step.run(11, 'four closes old', iso(45));
    step.run(12, 'three closes old', iso(35));
    step.run(13, 'fresh', iso(1));
  } finally {
    db.close();
  }
  return project;
}

describe('s91-m06 review digest', () => {
  it('names the lapsing and warned next-steps on the promoted next_actions', async () => {
    const project = await seeded(false);
    const result = await cmosReview({ projectRoot: project.projectRoot });

    expect(result.success).toBe(true);
    const lease = result.data!.next_actions.find((a) =>
      a.action.includes('lapse at the next close')
    );
    expect(lease).toBeDefined();
    expect(lease!.action).toContain('1 next-step(s) lapse at the next close unless carried: #11');
    expect(lease!.action).toContain('1 at the warning age: #12');
    expect(lease!.action).not.toContain('#13');
    expect(result.data!.digestSizeBytes).toBeLessThanOrEqual(4096);
    expect(formatReviewForLLM(result)).toContain('#11');
  });

  it('flags a mission In Progress with no active session, within budget with the lease line', async () => {
    const project = await seeded(true);
    const onboard = await cmosAgentOnboard({ projectRoot: project.projectRoot });
    expect(onboard.data!.suggestedActions.map((a) => a.action)).toContain(
      'Mission m-now is In Progress with no active session'
    );

    const review = await cmosReview({ projectRoot: project.projectRoot });
    expect(review.data!.digestSizeBytes).toBeLessThanOrEqual(4096);
  });
});
