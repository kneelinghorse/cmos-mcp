/**
 * Staleness Detection Tests
 *
 * Tests for detecting and flagging stale decisions/learnings
 * based on sprint age thresholds.
 *
 * @module tests/tools/cmos/staleness-detection
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectAndFlagStaleness,
  getStaleCounts,
  DEFAULT_STALENESS_THRESHOLD,
} from '../../../src/tools/cmos/staleness-detection';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { withClient, type CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { createSuccess } from '../../../src/tools/cmos/errors';

describe('staleness-detection', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-staleness-test-'));
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT REFERENCES sprints(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT
      );

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT REFERENCES sprints(id),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_reviewed_at TEXT,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT,
        session_id TEXT,
        mission_id TEXT,
        source_chunk_ids TEXT,
        category TEXT,
        superseded_by INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        evidence TEXT
      );

      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        sprint_id TEXT,
        session_id TEXT,
        mission_id TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO metadata (key, value) VALUES ('project_name', 'CMOS MCP Test');
    `);
    db.close();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function runWithClient<T>(fn: (client: CmosDatabaseClient) => T): Promise<T> {
    let captured: T;
    await withClient(
      (client) => {
        captured = fn(client);
        return createSuccess(null);
      },
      { projectRoot: tempDir }
    );
    return captured!;
  }

  function seedSprints(count: number, activeSprintNum?: number): void {
    const db = new Database(dbPath);
    for (let i = 1; i <= count; i++) {
      const status = i === (activeSprintNum ?? count) ? 'Active' : 'Completed';
      db.prepare(`INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)`).run(
        `sprint-${i}`,
        `Sprint ${i}`,
        status
      );
    }
    db.close();
  }

  function seedDecisions(
    items: Array<{ text: string; sprintId: string; status?: string; evidence?: string }>
  ): void {
    const db = new Database(dbPath);
    for (const item of items) {
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status, evidence)
         VALUES (?, '2026-01-01T00:00:00Z', ?, ?, ?)`
      ).run(item.text, item.sprintId, item.status ?? 'active', item.evidence ?? null);
    }
    db.close();
  }

  function seedLearnings(
    items: Array<{ content: string; sprintId: string; status?: string }>
  ): void {
    const db = new Database(dbPath);
    for (const item of items) {
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status)
         VALUES (?, '2026-01-01T00:00:00Z', ?, ?)`
      ).run(item.content, item.sprintId, item.status ?? 'active');
    }
    db.close();
  }

  it('flags stale decisions when sprint age exceeds threshold', async () => {
    const totalSprints = DEFAULT_STALENESS_THRESHOLD + 5;
    seedSprints(totalSprints); // active sprint = totalSprints
    // "Old decision" lives in sprint-3 — older than threshold (cutoff = 5).
    // "Recent decision" lives just past the cutoff.
    const recentSprintNum = totalSprints - 3;
    seedDecisions([
      { text: 'Old decision', sprintId: 'sprint-3' },
      { text: 'Recent decision', sprintId: `sprint-${recentSprintNum}` },
    ]);

    const result = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.decisionsFlagged).toBe(1);
    expect(result.totalStaleDecisions).toBe(1);
    expect(result.currentSprintNumber).toBe(totalSprints);
    expect(result.cutoffSprintNumber).toBe(totalSprints - DEFAULT_STALENESS_THRESHOLD);

    // Verify DB state
    const db = new Database(dbPath);
    const stale = db
      .prepare("SELECT decision_text FROM strategic_decisions WHERE status = 'stale'")
      .all() as Array<{ decision_text: string }>;
    const active = db
      .prepare("SELECT decision_text FROM strategic_decisions WHERE status = 'active'")
      .all() as Array<{ decision_text: string }>;
    db.close();

    expect(stale).toHaveLength(1);
    expect(stale[0].decision_text).toBe('Old decision');
    expect(active).toHaveLength(1);
    expect(active[0].decision_text).toBe('Recent decision');
  });

  it.each([
    {
      branch: 'completed-sprint fallback',
      currentStatus: 'Completed',
      historicalStatus: 'Completed',
    },
    { branch: 'active-sprint query', currentStatus: 'Active', historicalStatus: 'Current' },
  ])('uses the highest canonical sprint in the $branch after a historical insert', async (row) => {
    const currentSprint = DEFAULT_STALENESS_THRESHOLD + 5;
    const db = new Database(dbPath);
    const insertSprint = db.prepare(`INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)`);
    for (let sprint = 1; sprint <= currentSprint; sprint += 1) {
      if (sprint === 3) continue;
      insertSprint.run(
        `sprint-${sprint}`,
        `Sprint ${sprint}`,
        sprint === currentSprint ? row.currentStatus : 'Completed'
      );
    }
    // A backfilled historical row has the newest rowid but is not the newest sprint.
    insertSprint.run('sprint-3', 'Sprint 3', row.historicalStatus);
    db.close();

    seedDecisions([{ text: 'Old decision', sprintId: 'sprint-2' }]);

    const result = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect({
      currentSprintNumber: result.currentSprintNumber,
      cutoffSprintNumber: result.cutoffSprintNumber,
      decisionsFlagged: result.decisionsFlagged,
    }).toEqual({
      currentSprintNumber: currentSprint,
      cutoffSprintNumber: currentSprint - DEFAULT_STALENESS_THRESHOLD,
      decisionsFlagged: 1,
    });
  });

  it('does not flag a stale-sprint decision when last_reviewed_at is recent', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);

    const recentReviewIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO strategic_decisions (
         decision_text,
         created_at,
         last_reviewed_at,
         sprint_id,
         status
       ) VALUES (?, '2026-01-01T00:00:00Z', ?, ?, 'active')`
    ).run('Recently reviewed decision', recentReviewIso, 'sprint-2');
    db.close();

    const result = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.decisionsFlagged).toBe(0);
    expect(result.totalStaleDecisions).toBe(0);

    const db2 = new Database(dbPath);
    const decision = db2
      .prepare(
        `SELECT status, last_reviewed_at
         FROM strategic_decisions
         WHERE decision_text = 'Recently reviewed decision'`
      )
      .get() as { status: string; last_reviewed_at: string | null };
    db2.close();

    expect(decision.status).toBe('active');
    expect(decision.last_reviewed_at).toBe(recentReviewIso);
  });

  it('flags stale learnings', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);
    seedLearnings([
      { content: 'Old learning', sprintId: 'sprint-2' },
      { content: 'New learning', sprintId: 'sprint-14' },
    ]);

    const result = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.learningsFlagged).toBe(1);
    expect(result.totalStaleLearnings).toBe(1);
  });

  it('exempts decisions referenced via supersession chain', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);

    const db = new Database(dbPath);
    // Decision A (old, in sprint-2)
    db.prepare(
      `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status)
       VALUES (1, 'Old decision A', '2026-01-01T00:00:00Z', 'sprint-2', 'active')`
    ).run();
    // Decision B (newer, references A via superseded_by)
    db.prepare(
      `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status, superseded_by)
       VALUES (2, 'Old decision B', '2026-01-01T00:00:00Z', 'sprint-2', 'active', 1)`
    ).run();
    // Decision C (old, unreferenced)
    db.prepare(
      `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status)
       VALUES (3, 'Unreferenced old', '2026-01-01T00:00:00Z', 'sprint-3', 'active')`
    ).run();
    db.close();

    const result = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    // Decision A is referenced (another decision's superseded_by = 1), so exempt
    // Decision B is not referenced by anything, but has superseded_by itself (it points to A) — B should be flagged
    // Decision C is unreferenced — should be flagged
    expect(result.decisionsFlagged).toBe(2); // B and C

    const db2 = new Database(dbPath);
    const staleIds = db2
      .prepare("SELECT id FROM strategic_decisions WHERE status = 'stale' ORDER BY id")
      .all() as Array<{ id: number }>;
    const activeIds = db2
      .prepare("SELECT id FROM strategic_decisions WHERE status = 'active' ORDER BY id")
      .all() as Array<{ id: number }>;
    db2.close();

    expect(activeIds.map((r) => r.id)).toEqual([1]); // A exempt
    expect(staleIds.map((r) => r.id)).toEqual([2, 3]); // B and C flagged
  });

  it('exempts decisions with evidence links', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);
    seedDecisions([
      { text: 'Has evidence', sprintId: 'sprint-2', evidence: '[{"type":"doc","id":"123"}]' },
      { text: 'No evidence', sprintId: 'sprint-2' },
    ]);

    const result = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.decisionsFlagged).toBe(1); // only "No evidence" flagged

    const db = new Database(dbPath);
    const stale = db
      .prepare("SELECT decision_text FROM strategic_decisions WHERE status = 'stale'")
      .all() as Array<{ decision_text: string }>;
    db.close();

    expect(stale).toHaveLength(1);
    expect(stale[0].decision_text).toBe('No evidence');
  });

  it('does not flag when there are fewer sprints than threshold', async () => {
    const seedCount = DEFAULT_STALENESS_THRESHOLD - 5;
    seedSprints(seedCount); // Half-the-threshold sprints — cutoff goes negative.
    seedDecisions([{ text: 'Sprint 1 decision', sprintId: 'sprint-1' }]);

    const result = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.decisionsFlagged).toBe(0);
    expect(result.cutoffSprintNumber).toBe(seedCount - DEFAULT_STALENESS_THRESHOLD);
  });

  it('is idempotent — re-running does not re-flag already stale items', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);
    seedDecisions([{ text: 'Old decision', sprintId: 'sprint-2' }]);

    const result1 = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );
    expect(result1.decisionsFlagged).toBe(1);

    const result2 = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );
    expect(result2.decisionsFlagged).toBe(0); // already flagged, no new flags
    expect(result2.totalStaleDecisions).toBe(1); // still counts as stale
  });

  it('does not flag non-active items', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);
    seedDecisions([
      { text: 'Already archived', sprintId: 'sprint-2', status: 'archived' },
      { text: 'Already superseded', sprintId: 'sprint-2', status: 'superseded' },
    ]);

    const result = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.decisionsFlagged).toBe(0);
    expect(result.totalStaleDecisions).toBe(0);
  });

  it('getStaleCounts returns counts without mutating', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);
    seedDecisions([
      { text: 'Stale one', sprintId: 'sprint-2', status: 'stale' },
      { text: 'Active one', sprintId: 'sprint-14' },
    ]);
    seedLearnings([{ content: 'Stale learning', sprintId: 'sprint-1', status: 'stale' }]);

    const counts = await runWithClient((client) => getStaleCounts(client));

    expect(counts.staleDecisions).toBe(1);
    expect(counts.staleLearnings).toBe(1);
  });

  it('works when decisions/learnings tables do not exist', async () => {
    const db = new Database(dbPath);
    db.exec('DROP TABLE strategic_decisions');
    db.exec('DROP TABLE learnings');
    db.close();

    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);

    const result = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.decisionsFlagged).toBe(0);
    expect(result.learningsFlagged).toBe(0);
    expect(result.totalStaleDecisions).toBe(0);
    expect(result.totalStaleLearnings).toBe(0);
  });

  it('uses configurable threshold', async () => {
    // This test exercises the threshold override path with explicit values, so
    // it deliberately uses a fixed seed (15 sprints) and explicit threshold
    // arguments — the math here is NOT keyed off DEFAULT_STALENESS_THRESHOLD.
    seedSprints(15);
    seedDecisions([
      { text: 'Sprint 10 decision', sprintId: 'sprint-10' }, // 5 sprints old
    ]);

    // With threshold 3, sprint-10 is stale (15 - 3 = 12, and 10 <= 12)
    const result3 = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: 3 })
    );
    expect(result3.decisionsFlagged).toBe(1);

    // Reset status for next test
    const db = new Database(dbPath);
    db.prepare("UPDATE strategic_decisions SET status = 'active'").run();
    db.close();

    // With threshold 10, sprint-10 is NOT stale (15 - 10 = 5, and 10 > 5)
    const result10 = await runWithClient((client) =>
      detectAndFlagStaleness(client, { threshold: 10 })
    );
    expect(result10.decisionsFlagged).toBe(0);
  });
});
