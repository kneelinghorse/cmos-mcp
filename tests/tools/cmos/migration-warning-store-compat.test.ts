// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real-SQLite handler proofs that migration warnings survive legacy stores and errors.
// ABOUTME: Advisory failures neither throw nor repeat when one answer revisits an ensure path.

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { cmosFeedback, formatFeedbackForLLM } from '../../../src/tools/cmos/cmos-feedback';
import { formatLearningsForLLM } from '../../../src/tools/cmos/cmos-learnings';
import {
  cmosLearningsReaffirm,
  formatLearningsReaffirmForLLM,
} from '../../../src/tools/cmos/cmos-learnings-reaffirm';
import { cmosLearningsUpdate } from '../../../src/tools/cmos/cmos-learnings-update';
import {
  cmosMissionMove,
  formatMissionMoveForLLM,
} from '../../../src/tools/cmos/cmos-mission-move';
import {
  cmosSessionCapture,
  formatSessionCaptureForLLM,
} from '../../../src/tools/cmos/cmos-session-capture';
import {
  cmosSessionComplete,
  formatSessionCompleteForLLM,
} from '../../../src/tools/cmos/cmos-session-complete';
import { cmosSprintList, formatSprintListForLLM } from '../../../src/tools/cmos/cmos-sprint-list';
import { reaffirmLearningsByIds } from '../../../src/tools/cmos/learning-reaffirm';
import { ensureReviewTimestamps } from '../../../src/tools/cmos/schema-migrations';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

const AUTHOR_NAMESPACE_MARKER = 'author_namespace_columns';
const COLLIDING_AUTHOR_INDEX = 'idx_learnings_author_session';
const COLLIDING_FEEDBACK_INDEX = 'idx_agent_feedback_status';
const COLLIDING_LEARNING_INDEX = 'idx_learnings_status';
const COLLIDING_NEXT_STEP_INDEX = 'idx_next_steps_status';
const COLLIDING_CONSTRAINT_INDEX = 'idx_constraints_status';

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function currentStore(prefix: string): { readonly projectRoot: string; readonly dbPath: string } {
  const projectRoot = mkTmp(prefix);
  const dbPath = seedCmosDb(projectRoot, { projectName: path.basename(prefix) });
  reidentifyCmosTestStore(projectRoot);
  return { projectRoot, dbPath };
}

function collideIndexWithView(dbPath: string, indexName: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`DROP INDEX ${indexName}`);
    db.exec(`CREATE VIEW ${indexName} AS SELECT 1 AS collided`);
  } finally {
    db.close();
  }
}

function insertLearning(dbPath: string, content: string): number {
  const db = new Database(dbPath);
  try {
    return Number(
      db
        .prepare(
          `INSERT INTO learnings (content, status, created_at)
           VALUES (?, 'active', ?)`
        )
        .run(content, new Date().toISOString()).lastInsertRowid
    );
  } finally {
    db.close();
  }
}

function createAbortTrigger(dbPath: string, ddl: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(ddl);
  } finally {
    db.close();
  }
}

function provisionFeedbackTable(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE agent_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        session_id TEXT,
        sprint_id TEXT,
        mission_id TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_note TEXT
      );
      CREATE INDEX idx_agent_feedback_status ON agent_feedback (status);
    `);
  } finally {
    db.close();
  }
}

function replaceMissionsTableWithTimestamplessView(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      INSERT INTO sprints (id, title, status)
      VALUES ('s88-source', 'Source sprint', 'Active'),
             ('s88-target', 'Target sprint', 'Planned');
      INSERT INTO missions
        (id, sprint_id, name, status, notes, created_at, started_at, updated_at)
      VALUES
        ('s88-move-fixture', 's88-source', 'Move warning fixture', 'Queued', '',
         '2026-08-28T00:00:00.000Z', NULL, '2026-08-28T00:00:00.000Z');

      DROP INDEX IF EXISTS idx_missions_aggkey;
      ALTER TABLE missions RENAME TO missions_backing;
      CREATE VIEW missions AS
      SELECT id, sprint_id, name, status, completed_at, notes,
             objective, context, success_criteria, deliverables, reference_docs,
             domain_fields, created_at, started_at, metadata, project_id,
             stable_event_id, occurred_at, origin_seq, event_type, schema_version,
             author_user_id
      FROM missions_backing;
    `);
  } finally {
    db.close();
  }
}

function warningOccurrences(warnings: readonly string[] | undefined, needle: string): number {
  return (warnings ?? []).filter((warning) => warning.includes(needle)).length;
}

function textOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Roll a current seed back to the pre-s69 author-session shape. The target index name is then
 * occupied by a real SQLite view, so the lazy migration can rename both columns successfully but
 * must disclose its failed CREATE INDEX and continue serving the handler.
 */
function legacyAuthorNamespaceStore(): {
  readonly projectRoot: string;
  readonly dbPath: string;
  readonly sessionId: string;
} {
  const projectRoot = mkTmp('cmos-m09-legacy-warning-');
  const dbPath = seedCmosDb(projectRoot, { projectName: 'Legacy migration warning' });
  const projectId = reidentifyCmosTestStore(projectRoot);
  const sessionId = 'PS-2026-08-28-901';
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO sessions
         (id, type, title, started_at, agent, status, captures,
          project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
       VALUES (?, 'build', 'Legacy warning fixture', ?, 'jest', 'active', '[]',
               ?, ?, ?, 1, 'session_started', 1)`
    ).run(sessionId, new Date().toISOString(), projectId, '01M09LEGACYSESSION00000000', Date.now());

    db.exec(`
      DROP INDEX IF EXISTS idx_strategic_decisions_author_session;
      DROP INDEX IF EXISTS idx_learnings_author_session;
      ALTER TABLE strategic_decisions RENAME COLUMN author_session_id TO session_id;
      ALTER TABLE learnings RENAME COLUMN author_session_id TO session_id;
      DELETE FROM metadata WHERE key = '${AUTHOR_NAMESPACE_MARKER}';
    `);
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, session_id)
       VALUES ('legacy', ?, ?)`
    ).run(new Date().toISOString(), sessionId);
    db.exec(`CREATE VIEW ${COLLIDING_AUTHOR_INDEX} AS SELECT 1 AS collided`);
  } finally {
    db.close();
  }
  CmosDetector.resetInstance();
  return { projectRoot, dbPath, sessionId };
}

/**
 * "Foreign" here means a consumer-owned partial schema, not a second CMOS project identity:
 * it contains only metadata plus a materialized sprint_summary projection. It deliberately omits
 * the canonical sprints/missions tables and owns a base table whose name collides with CMOS's
 * migratable view. The reader historically answered from this shape and must keep doing so.
 */
function foreignConsumerProjectionStore(): {
  readonly projectRoot: string;
  readonly dbPath: string;
} {
  const projectRoot = mkTmp('cmos-m09-foreign-warning-');
  const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO metadata (key, value) VALUES
        ('project_id', 'foreign-consumer-projection'),
        ('project_name', 'Foreign consumer projection');

      CREATE TABLE sprint_summary (
        sprint_id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        focus TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER,
        blocked_missions INTEGER,
        active_missions INTEGER,
        decisions_count INTEGER
      );
      INSERT INTO sprint_summary
        (sprint_id, title, status, total_missions, completed_missions,
         blocked_missions, active_missions, decisions_count)
      VALUES ('consumer-sprint', 'Consumer projection row', 'Completed', 4, 4, 0, 0, 2);
    `);
  } finally {
    db.close();
  }
  CmosDetector.resetInstance();
  return { projectRoot, dbPath };
}

function seedActiveSessionWithCaptures(
  dbPath: string,
  sessionId: string,
  captures: readonly Record<string, unknown>[]
): void {
  const db = new Database(dbPath);
  try {
    const projectId = (
      db.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as { value: string }
    ).value;
    db.prepare(
      `INSERT INTO sessions
         (id, type, title, started_at, agent, status, captures,
          project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
       VALUES (?, 'build', 'Warning de-dup fixture', ?, 'jest', 'active', ?,
               ?, ?, ?, 1, 'session_started', 1)`
    ).run(
      sessionId,
      new Date().toISOString(),
      JSON.stringify(captures),
      projectId,
      `event-${sessionId}`,
      Date.now()
    );
  } finally {
    db.close();
  }
}

function replaceDecisionsTableWithNonAlterableView(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      DROP TABLE strategic_decisions;
      CREATE VIEW strategic_decisions AS
      SELECT 1 AS id, '' AS decision_text, '' AS created_at WHERE 0;
    `);
  } finally {
    db.close();
  }
}

function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
      (row) => row.name
    );
  } finally {
    db.close();
  }
}

describe('s88-m09 advisory migration warnings preserve store compatibility', () => {
  it('an old, un-migrated author namespace resolves successfully despite a real DDL collision', async () => {
    const { projectRoot, dbPath, sessionId } = legacyAuthorNamespaceStore();

    expect(columnNames(dbPath, 'strategic_decisions')).toEqual(
      expect.arrayContaining(['session_id'])
    );
    expect(columnNames(dbPath, 'strategic_decisions')).not.toContain('author_session_id');
    expect(columnNames(dbPath, 'learnings')).toEqual(expect.arrayContaining(['session_id']));
    const before = new Database(dbPath, { readonly: true });
    try {
      expect(
        before.prepare(`SELECT value FROM metadata WHERE key = ?`).get(AUTHOR_NAMESPACE_MARKER)
      ).toBeUndefined();
      expect(
        before.prepare(`SELECT type FROM sqlite_master WHERE name = ?`).get(COLLIDING_AUTHOR_INDEX)
      ).toEqual({ type: 'view' });
    } finally {
      before.close();
    }

    const pending = cmosSessionCapture({
      projectRoot,
      sessionId,
      category: 'decision',
      // A pre-seeded duplicate avoids unrelated embedding work; this test isolates opening and
      // applying the schema migration, not model availability.
      content: 'legacy',
    });
    await expect(pending).resolves.toMatchObject({ success: true });
    const result = await pending;

    const migrationWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes(COLLIDING_AUTHOR_INDEX)
    );
    expect(migrationWarnings).toHaveLength(1);
    expect(migrationWarnings[0]).toMatch(/CREATE INDEX.*failed: DB_QUERY_FAILED/);
    expect(formatSessionCaptureForLLM(result)).toContain(migrationWarnings[0]);
    expect(result.data).toMatchObject({ decisionAlreadyExtracted: true });
    expect(columnNames(dbPath, 'strategic_decisions')).toContain('author_session_id');
    expect(columnNames(dbPath, 'learnings')).toContain('author_session_id');
  });

  it('a foreign partial consumer store still answers when its base table collides with the view migration', async () => {
    const { projectRoot, dbPath } = foreignConsumerProjectionStore();
    const before = new Database(dbPath, { readonly: true });
    try {
      const objects = before
        .prepare(
          `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name`
        )
        .all() as Array<{ name: string; type: string }>;
      expect(objects).toEqual(
        expect.arrayContaining([
          { name: 'metadata', type: 'table' },
          { name: 'sprint_summary', type: 'table' },
        ])
      );
      expect(objects.some((object) => object.name === 'sprints')).toBe(false);
      expect(objects.some((object) => object.name === 'missions')).toBe(false);
    } finally {
      before.close();
    }

    const pending = cmosSprintList({ projectRoot });
    await expect(pending).resolves.toMatchObject({ success: true });
    const result = await pending;

    expect(result.data?.sprints).toEqual([
      expect.objectContaining({ id: 'consumer-sprint', totalMissions: 4, parkedMissions: 0 }),
    ]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/sprint_summary exists as a table, not a view.*leaving it untouched/),
    ]);
    expect(formatSprintListForLLM(result)).toContain(result.warnings?.[0]);

    const after = new Database(dbPath, { readonly: true });
    try {
      expect(
        after.prepare(`SELECT type FROM sqlite_master WHERE name = 'sprint_summary'`).get()
      ).toEqual({ type: 'table' });
      expect(
        (
          after
            .prepare(
              `SELECT total_missions FROM sprint_summary WHERE sprint_id = 'consumer-sprint'`
            )
            .get() as { total_missions: number }
        ).total_missions
      ).toBe(4);
    } finally {
      after.close();
    }
  });

  it('keeps a pre-error migration warning visible when learnings update returns NOT_FOUND', async () => {
    const { projectRoot, dbPath } = currentStore('cmos-m09-error-warning-');
    collideIndexWithView(dbPath, COLLIDING_LEARNING_INDEX);

    const result = await cmosLearningsUpdate({
      learningId: 999_999,
      status: 'archived',
      projectRoot,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'MISSION_NOT_FOUND', message: 'Learning #999999 not found' },
    });

    const migrationWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes(COLLIDING_LEARNING_INDEX)
    );
    expect(migrationWarnings).toHaveLength(1);
    expect(migrationWarnings[0]).toMatch(/CREATE INDEX.*failed: DB_QUERY_FAILED/);

    const text = formatLearningsForLLM('update', result);
    expect(text.split('\n').slice(0, 3)).toEqual([
      '❌ Failed to update learning',
      'Error: Learning #999999 not found',
      'Suggestion: Use cmos_learnings list to find valid learning IDs',
    ]);
    expect(textOccurrences(text, migrationWarnings[0])).toBe(1);
  });

  it('keeps the feedback-table migration warning on an early NOT_FOUND answer', async () => {
    const { projectRoot, dbPath } = currentStore('cmos-m09-feedback-not-found-');
    provisionFeedbackTable(dbPath);
    collideIndexWithView(dbPath, COLLIDING_FEEDBACK_INDEX);

    const result = await cmosFeedback({
      action: 'triage',
      feedbackId: 999_999,
      projectRoot,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'FEEDBACK_NOT_FOUND', message: 'Feedback #999999 not found' },
    });

    const migrationWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes(COLLIDING_FEEDBACK_INDEX)
    );
    expect(migrationWarnings).toHaveLength(1);
    expect(migrationWarnings[0]).toMatch(/CREATE INDEX.*failed: DB_QUERY_FAILED/);

    const text = formatFeedbackForLLM('triage', result);
    expect(text).toContain('❌ cmos_feedback(triage) failed: Feedback #999999 not found');
    expect(textOccurrences(text, migrationWarnings[0])).toBe(1);
  });

  it('keeps the feedback-table migration warning when the later mutation fails', async () => {
    const { projectRoot, dbPath } = currentStore('cmos-m09-feedback-update-error-');
    provisionFeedbackTable(dbPath);
    const db = new Database(dbPath);
    let feedbackId: number;
    try {
      feedbackId = Number(
        db
          .prepare(
            `INSERT INTO agent_feedback (tool_name, body, status, created_at)
             VALUES ('jest', 'trigger the error arm', 'open', ?)`
          )
          .run(new Date().toISOString()).lastInsertRowid
      );
    } finally {
      db.close();
    }
    collideIndexWithView(dbPath, COLLIDING_FEEDBACK_INDEX);
    createAbortTrigger(
      dbPath,
      `CREATE TRIGGER reject_feedback_update
       BEFORE UPDATE ON agent_feedback
       BEGIN SELECT RAISE(ABORT, 'feedback update blocked'); END`
    );

    const result = await cmosFeedback({ action: 'triage', feedbackId, projectRoot });
    expect(result).toMatchObject({ success: false, error: { code: 'DB_QUERY_FAILED' } });
    expect(result.error?.message).toContain('feedback update blocked');
    const migrationWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes(COLLIDING_FEEDBACK_INDEX)
    );
    expect(migrationWarnings).toHaveLength(1);

    const text = formatFeedbackForLLM('triage', result);
    expect(text).toContain(result.error!.message);
    expect(textOccurrences(text, migrationWarnings[0])).toBe(1);
  });

  it('keeps both learning migrations visible when reaffirm returns NOT_FOUND', async () => {
    const { projectRoot, dbPath } = currentStore('cmos-m09-reaffirm-not-found-');
    collideIndexWithView(dbPath, COLLIDING_LEARNING_INDEX);

    const result = await cmosLearningsReaffirm({ learningId: 999_999, projectRoot });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'MISSION_NOT_FOUND', message: 'Learning #999999 not found' },
    });
    const migrationWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes(COLLIDING_LEARNING_INDEX)
    );
    expect(migrationWarnings).toHaveLength(1);
    expect(migrationWarnings[0]).toMatch(/CREATE INDEX.*failed: DB_QUERY_FAILED/);

    const text = formatLearningsReaffirmForLLM(result);
    expect(text).toContain('Error: Learning #999999 not found');
    expect(textOccurrences(text, migrationWarnings[0])).toBe(1);
  });

  it('keeps the learning migration warning when reaffirm UPDATE fails', async () => {
    const { projectRoot, dbPath } = currentStore('cmos-m09-reaffirm-update-error-');
    const learningId = insertLearning(dbPath, 'Reaffirm update failure fixture');
    collideIndexWithView(dbPath, COLLIDING_LEARNING_INDEX);
    createAbortTrigger(
      dbPath,
      `CREATE TRIGGER reject_learning_reaffirm
       BEFORE UPDATE ON learnings
       BEGIN SELECT RAISE(ABORT, 'learning reaffirm blocked'); END`
    );

    const result = await cmosLearningsReaffirm({ learningId, projectRoot });
    expect(result).toMatchObject({ success: false, error: { code: 'DB_QUERY_FAILED' } });
    expect(result.error?.message).toContain('learning reaffirm blocked');
    const migrationWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes(COLLIDING_LEARNING_INDEX)
    );
    expect(migrationWarnings).toHaveLength(1);

    const text = formatLearningsReaffirmForLLM(result);
    expect(text).toContain(result.error!.message);
    expect(textOccurrences(text, migrationWarnings[0])).toBe(1);
  });

  it('keeps a timestamp migration warning on a later mission-move write error', async () => {
    const { projectRoot, dbPath } = currentStore('cmos-m09-mission-move-error-');
    replaceMissionsTableWithTimestamplessView(dbPath);

    const result = await cmosMissionMove({
      missionId: 's88-move-fixture',
      toSprintId: 's88-target',
      projectRoot,
    });
    expect(result).toMatchObject({ success: false, error: { code: 'DB_QUERY_FAILED' } });
    const migrationWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes('ALTER TABLE missions ADD COLUMN updated_at')
    );
    expect(migrationWarnings).toHaveLength(1);
    expect(migrationWarnings[0]).toMatch(/failed: DB_QUERY_FAILED/);

    const text = formatMissionMoveForLLM(result);
    expect(text).toContain(result.error!.message);
    expect(textOccurrences(text, migrationWarnings[0])).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        db.prepare(`SELECT sprint_id FROM missions_backing WHERE id = 's88-move-fixture'`).get()
      ).toEqual({ sprint_id: 's88-source' });
    } finally {
      db.close();
    }
  });

  it('reports each persistent next-step and constraint migration failure once per completion', async () => {
    const { projectRoot, dbPath } = currentStore('cmos-m09-session-warning-dedup-');
    const sessionId = 'PS-2026-08-28-902';
    seedActiveSessionWithCaptures(dbPath, sessionId, [
      { category: 'next-step', content: 'First captured next step' },
      { category: 'next-step', content: 'Second captured next step' },
      { category: 'constraint', content: 'First captured constraint' },
      { category: 'constraint', content: 'Second captured constraint' },
    ]);
    collideIndexWithView(dbPath, COLLIDING_NEXT_STEP_INDEX);
    collideIndexWithView(dbPath, COLLIDING_CONSTRAINT_INDEX);

    const result = await cmosSessionComplete({
      sessionId,
      summary: 'Exercise every repeated schema-ensure branch.',
      nextSteps: ['Parameter-sourced next step'],
      projectRoot,
    });
    expect(result).toMatchObject({
      success: true,
      data: { nextStepsExtracted: 3, constraintsExtracted: 2 },
    });
    const nextStepWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes(COLLIDING_NEXT_STEP_INDEX)
    );
    const constraintWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes(COLLIDING_CONSTRAINT_INDEX)
    );
    expect(nextStepWarnings).toHaveLength(1);
    expect(constraintWarnings).toHaveLength(1);

    const text = formatSessionCompleteForLLM(result);
    expect(textOccurrences(text, nextStepWarnings[0])).toBe(1);
    expect(textOccurrences(text, constraintWarnings[0])).toBe(1);
  });

  it('uniquely merges a persistent review migration warning across reaffirm passes', async () => {
    const { dbPath } = currentStore('cmos-m09-reaffirm-warning-dedup-');
    const db = new Database(dbPath);
    let firstId: number;
    let secondId: number;
    try {
      firstId = Number(
        db
          .prepare(
            `INSERT INTO learnings (content, status, created_at)
             VALUES ('Explicit learning', 'active', ?)`
          )
          .run(new Date().toISOString()).lastInsertRowid
      );
      secondId = Number(
        db
          .prepare(
            `INSERT INTO learnings (content, status, created_at)
             VALUES ('Implicit learning', 'active', ?)`
          )
          .run(new Date().toISOString()).lastInsertRowid
      );
    } finally {
      db.close();
    }
    replaceDecisionsTableWithNonAlterableView(dbPath);

    const opened = await CmosDatabaseClient.create({ dbPath, registerProject: false });
    expect(opened.success).toBe(true);
    const client = opened.data!;
    try {
      // Prove the SQLite failure persists. De-duplication must happen in the answer carrier,
      // not because the second migration attempt happened to start succeeding.
      expect(
        warningOccurrences(ensureReviewTimestamps(client).warnings, 'strategic_decisions')
      ).toBe(1);
      expect(
        warningOccurrences(ensureReviewTimestamps(client).warnings, 'strategic_decisions')
      ).toBe(1);

      const warnings: string[] = [];
      const explicit = reaffirmLearningsByIds(
        client,
        [firstId],
        new Date().toISOString(),
        warnings
      );
      const implicit = reaffirmLearningsByIds(
        client,
        [secondId],
        new Date().toISOString(),
        warnings
      );
      expect(explicit.reaffirmedIds).toEqual([firstId]);
      expect(implicit.reaffirmedIds).toEqual([secondId]);
      expect(warningOccurrences(warnings, 'strategic_decisions')).toBe(1);
    } finally {
      client.close();
    }
  });
});
