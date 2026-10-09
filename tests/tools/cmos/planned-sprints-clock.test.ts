// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 (feedback #47) — a sprint list page that leaves Planned sprints out says how many and
// ABOUTME: how to list them, and the context view's recentSprintCount never counts a Planned sprint.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { cmosContext } from '../../../src/tools/cmos/cmos-context';
import { cmosSprint, formatSprintForLLM } from '../../../src/tools/cmos/cmos-sprint';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s93m11-planned-'));
  const dbPath = seedCmosDb(projectRoot, { projectName: 'planned sprints' });
  reidentifyCmosTestStore(projectRoot);
  const db = new Database(dbPath);
  try {
    const sprint = db.prepare(
      'INSERT INTO sprints (id, title, status, start_date) VALUES (?, ?, ?, ?)'
    );
    sprint.run('sprint-1', 'One', 'Completed', '2026-01-01');
    sprint.run('sprint-2', 'Two', 'completed', '2026-01-15');
    sprint.run('sprint-3', 'Three', 'Active', '2026-02-01');
    // Planned sprints have no start date yet; the page orders by start date.
    sprint.run('sprint-4', 'Four', 'Planned', null);
    sprint.run('sprint-5', 'Five', 'planned', null);
    sprint.run('sprint-6', 'Six', 'PLANNED', null);
  } finally {
    db.close();
  }
  CmosDetector.resetInstance();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('s93-m11 — Planned sprints are named when a page leaves them out', () => {
  it('a short unfiltered page counts the Planned sprints it left out and says how to list them', async () => {
    const listed = await cmosSprint({ action: 'list', limit: 3, projectRoot });
    expect(listed.success).toBe(true);
    const data = listed.data as { sprints: Array<{ status: string }>; omittedPlanned?: number };
    const plannedOnPage = data.sprints.filter((s) => s.status.toUpperCase() === 'PLANNED').length;
    expect(data.omittedPlanned).toBe(3 - plannedOnPage);
    expect(data.omittedPlanned).toBeGreaterThan(0);
    expect(formatSprintForLLM('list', listed)).toContain(
      'cmos_sprint(action="list", status="Planned") lists them.'
    );
  });

  it('a page that holds every sprint, or a filtered one, names nothing', async () => {
    const all = await cmosSprint({ action: 'list', limit: 50, projectRoot });
    expect((all.data as { omittedPlanned?: number }).omittedPlanned).toBeUndefined();
    const completed = await cmosSprint({
      action: 'list',
      status: 'Completed',
      limit: 1,
      projectRoot,
    });
    expect((completed.data as { omittedPlanned?: number }).omittedPlanned).toBeUndefined();
  });
});

describe('s93-m11 — the context view counts only sprints that have happened', () => {
  it('recentSprintCount counts Completed and Active in any letter case, never Planned', async () => {
    const viewed = await cmosContext({ action: 'view', projectRoot });
    expect(viewed.success).toBe(true);
    const metrics = (viewed.data as { healthMetrics?: { recentSprintCount: number } })
      .healthMetrics;
    expect(metrics?.recentSprintCount).toBe(3);
  });
});
