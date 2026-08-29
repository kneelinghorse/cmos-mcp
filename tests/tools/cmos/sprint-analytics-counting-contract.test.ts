// ABOUTME: s88-m04 — analytics must publish the exact membership rule behind its counts.
// ABOUTME: A missing count source is unknown, never a fabricated zero beneath that rule.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSprintAnalytics,
  formatSprintAnalyticsForLLM,
} from '../../../src/tools/cmos/cmos-sprint-analytics';
import { seedCmosDb } from '../../helpers/seedCmosDb';

describe('s88-m04 analytics counting contract', () => {
  let projectRoot: string;
  let dbPath: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s88-m04-analytics-'));
    dbPath = seedCmosDb(projectRoot, { projectName: 's88-m04 analytics' });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function seedClosedSprint(): void {
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO sprints (id, title, status, start_date, end_date)
         VALUES ('sprint-1', 'Counting contract', 'Completed', '2026-01-01', '2026-01-10')`
      ).run();
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, started_at, completed_at)
         VALUES ('s1-m01', 'sprint-1', 'Done', 'Completed',
                 '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z')`
      ).run();
    } finally {
      db.close();
    }
  }

  it('counts stored sprint_id membership even when rows were created after end_date', async () => {
    seedClosedSprint();
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO strategic_decisions
           (decision_text, created_at, sprint_id, status, project_id)
         VALUES ('post-close decision', '2026-01-20T00:00:00Z', 'sprint-1', 'active', 's88-m04-analytics')`
      ).run();
      db.prepare(
        `INSERT INTO learnings
           (content, created_at, sprint_id, status, project_id)
         VALUES ('post-close learning', '2026-01-20T00:00:00Z', 'sprint-1', 'active', 's88-m04-analytics')`
      ).run();
      db.prepare(
        `INSERT INTO sessions
           (id, type, title, sprint_id, started_at, agent, status, captures, project_id)
         VALUES ('PS-POST-END', 'review', 'Post end', 'sprint-1',
                 '2026-01-20T00:00:00Z', 'tester', 'completed', '[]', 's88-m04-analytics')`
      ).run();
    } finally {
      db.close();
    }

    const result = await cmosSprintAnalytics({ projectRoot });

    expect(result.success).toBe(true);
    expect(result.data?.countingRule).toMatch(/sprint_id/i);
    expect(result.data?.countingRule).toMatch(/not clipped|without.*clipp/i);
    expect(result.data?.sprints).toHaveLength(1);
    expect(result.data?.sprints[0]).toEqual(
      expect.objectContaining({ decisionsCount: 1, learningsCount: 1, sessionsCount: 1 })
    );
    expect(formatSprintAnalyticsForLLM(result)).toContain(result.data!.countingRule);
  });

  it('publishes the counting rule even when the analyzed window is empty', async () => {
    const result = await cmosSprintAnalytics({ projectRoot });

    expect(result.success).toBe(true);
    expect(result.data?.sprints).toEqual([]);
    expect(result.data?.countingRule).toMatch(/sprint_id/i);
    expect(formatSprintAnalyticsForLLM(result)).toContain(result.data!.countingRule);
  });

  it('does not publish a fabricated zero when a membership table cannot be read', async () => {
    seedClosedSprint();
    const db = new Database(dbPath);
    try {
      db.exec('DROP TABLE learnings');
    } finally {
      db.close();
    }

    const result = await cmosSprintAnalytics({ projectRoot });

    expect(result.success).toBe(true);
    expect(result.data?.sprints).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/learnings.*not zero|learnings.*not a zero/i)])
    );
  });

  it('does not publish a fabricated decision zero when the direct membership read fails', async () => {
    seedClosedSprint();
    const db = new Database(dbPath);
    try {
      // A same-named base table keeps the sprint-window read valid after the decision table is
      // removed, so this fire reaches the direct strategic_decisions helper specifically.
      db.exec(`
        DROP VIEW sprint_summary;
        CREATE TABLE sprint_summary (
          sprint_id TEXT,
          title TEXT,
          status TEXT,
          total_missions INTEGER,
          completed_missions INTEGER,
          blocked_missions INTEGER
        );
        INSERT INTO sprint_summary
        VALUES ('sprint-1', 'Counting contract', 'Completed', 1, 1, 0);
        DROP TABLE strategic_decisions;
      `);
    } finally {
      db.close();
    }

    const result = await cmosSprintAnalytics({ projectRoot });

    expect(result.success).toBe(true);
    expect(result.data?.sprints).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/strategic_decisions.*unknown, not zero/i)])
    );
  });

  it('does not publish a fabricated session zero when the sessions read fails', async () => {
    seedClosedSprint();
    const db = new Database(dbPath);
    try {
      db.exec('DROP TABLE sessions');
    } finally {
      db.close();
    }

    const result = await cmosSprintAnalytics({ projectRoot });

    expect(result.success).toBe(true);
    expect(result.data?.sprints).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/sessions.*unknown, not zero/i)])
    );
  });

  it('reports zero linked sessions only after establishing session_missions is absent', async () => {
    seedClosedSprint();
    const db = new Database(dbPath);
    try {
      db.exec('DROP TABLE session_missions');
    } finally {
      db.close();
    }

    const result = await cmosSprintAnalytics({ projectRoot });

    expect(result.success).toBe(true);
    expect(result.data?.sprints).toHaveLength(1);
    expect(result.data?.sprints[0]?.linkedSessionsCount).toBe(0);
  });

  it('does not turn a session_missions query error into zero', async () => {
    seedClosedSprint();
    const db = new Database(dbPath);
    try {
      db.exec(`
        DROP TABLE session_missions;
        CREATE TABLE session_missions (mission_id TEXT);
      `);
    } finally {
      db.close();
    }

    const result = await cmosSprintAnalytics({ projectRoot });

    expect(result.success).toBe(true);
    expect(result.data?.sprints).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/session_missions.*unknown, not zero/i)])
    );
  });

  it('derives decision membership directly when sprint_summary is a same-named base table', async () => {
    seedClosedSprint();
    const db = new Database(dbPath);
    try {
      db.exec('DROP VIEW sprint_summary');
      db.exec(`
        CREATE TABLE sprint_summary (
          sprint_id TEXT,
          title TEXT,
          status TEXT,
          total_missions INTEGER,
          completed_missions INTEGER,
          blocked_missions INTEGER,
          decisions_count INTEGER
        );
      `);
      db.prepare(
        `INSERT INTO sprint_summary
         VALUES ('sprint-1', 'Counting contract', 'Completed', 1, 1, 0, 999)`
      ).run();
      db.prepare(
        `INSERT INTO strategic_decisions
           (decision_text, created_at, sprint_id, status, project_id)
         VALUES ('real membership', '2026-01-20T00:00:00Z', 'sprint-1', 'active', 's88-m04-analytics')`
      ).run();
    } finally {
      db.close();
    }

    const result = await cmosSprintAnalytics({ projectRoot });

    expect(result.success).toBe(true);
    expect(result.data?.sprints[0]?.decisionsCount).toBe(1);
  });
});
