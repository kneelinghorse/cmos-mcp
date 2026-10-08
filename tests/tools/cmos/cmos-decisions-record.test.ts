// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s91-m04 — cmos_decisions(action="record") writes a decision outside a session and points
// ABOUTME: every correction at what it corrects, in the same transaction, through the real router.

/**
 * WHY THIS ACTION EXISTS. Until s91-m04 the only ways to write a decision were side effects of
 * completing a mission or a session, or `cmos_session(capture)` inside an active session. Stage1
 * lost the decisions on five mission completions and had no recovery path; policy 3 (decisions
 * keep the ADR lifecycle) needs a correction to name what it supersedes the moment it is written.
 *
 * Every test drives the published router against a real seeded store (CMOS_SCHEMA) and verifies
 * state by SQL — SQL never supplies an id a follow-up call uses.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';

import { createSeededCmosProject, type SeededCmosProject } from '../../helpers/seedCmosDb';
import { cmosDecisions, formatDecisionsForLLM } from '../../../src/tools/cmos/cmos-decisions';
import { cmosSession } from '../../../src/tools/cmos/cmos-session';

interface RecordReceipt {
  decisionId: number;
  materialization: 'materialized' | 'existing';
  sprintId: string | null;
  authorSessionId: string | null;
  implicitSession?: { opened: boolean };
  superseded: Array<{ id: number; previousStatus: string; newStatus: string }>;
}

const projects: SeededCmosProject[] = [];

afterEach(async () => {
  while (projects.length > 0) await projects.pop()!.cleanup();
});

async function seeded(): Promise<SeededCmosProject> {
  const project = await createSeededCmosProject({}, 'cmos-s91-m04-record-');
  projects.push(project);
  const db = new Database(project.dbPath);
  try {
    db.exec(`
      INSERT INTO sprints (id, title, status) VALUES ('sprint-a', 'A', 'Completed');
      INSERT INTO sprints (id, title, status) VALUES ('sprint-b', 'B', 'Active');
      INSERT INTO missions (id, sprint_id, name, status) VALUES ('ma-1', 'sprint-a', 'done', 'Completed');
    `);
  } finally {
    db.close();
  }
  return project;
}

function seedDecision(dbPath: string, text: string, sprintId: string | null): number {
  const db = new Database(dbPath);
  try {
    // Seed through a real capture would need a session; the target only has to EXIST, so the
    // firehose columns are satisfied directly. The id is read back, never invented.
    const info = db
      .prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status,
           project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
         VALUES (?, ?, ?, 'active', 'p', ?, ?, 1, 'decision_captured', 1)`
      )
      .run(text, new Date().toISOString(), sprintId, `SEED${Date.now()}${text.length}`, Date.now());
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

function row(dbPath: string, id: number): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM strategic_decisions WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
  } finally {
    db.close();
  }
}

function count(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM strategic_decisions').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

async function record(projectRoot: string, args: Record<string, unknown>) {
  return cmosDecisions({ action: 'record', projectRoot, ...args } as never);
}

describe('cmos_decisions(action="record") — s91-m04', () => {
  it('writes the correction and points the target at it in one call', async () => {
    const project = await seeded();
    const target = seedDecision(project.dbPath, 'The refuted claim.', 'sprint-b');

    const result = await record(project.projectRoot, {
      content: 'The correction, which supersedes the refuted claim.',
      supersedes: [target],
    });

    expect(result.success).toBe(true);
    const receipt = result.data as unknown as RecordReceipt;
    expect(receipt.materialization).toBe('materialized');
    expect(row(project.dbPath, receipt.decisionId)).toMatchObject({ status: 'active' });
    expect(row(project.dbPath, target)).toMatchObject({
      status: 'superseded',
      superseded_by: receipt.decisionId,
    });
    expect(receipt.superseded).toEqual([
      { id: target, previousStatus: 'active', newStatus: 'superseded' },
    ]);
    const text = formatDecisionsForLLM('record', result);
    expect(text).toContain(`#${target}: active → superseded`);
  });

  it("recovers a completed mission's lost decision with the mission's own sprint", async () => {
    const project = await seeded();

    const result = await record(project.projectRoot, {
      content: 'The decision Stage1 lost when ma-1 completed.',
      missionId: 'ma-1',
    });

    expect(result.success).toBe(true);
    const receipt = result.data as unknown as RecordReceipt;
    expect(receipt.sprintId).toBe('sprint-a');
    // s92-m03: with no session open, the row is attributed to this process's implicit session,
    // opened for it (3.1.0 stored NULL).
    expect(receipt.implicitSession).toEqual({ opened: true });
    expect(row(project.dbPath, receipt.decisionId)).toMatchObject({
      mission_id: 'ma-1',
      sprint_id: 'sprint-a',
      author_session_id: receipt.authorSessionId,
      event_type: 'decision_captured',
    });
    expect(receipt.authorSessionId).toMatch(/^PS-\d{4}-\d{2}-\d{2}-\d{3}$/);
  });

  it('stamps the active session when one exists, so the row stays attributable', async () => {
    const project = await seeded();
    const started = await cmosSession({
      action: 'start',
      type: 'custom',
      title: 'record attribution',
      projectRoot: project.projectRoot,
    } as never);
    const sessionId = (started.data as { sessionId: string }).sessionId;

    const result = await record(project.projectRoot, { content: 'Written inside a session.' });
    const receipt = result.data as unknown as RecordReceipt;
    expect(row(project.dbPath, receipt.decisionId)).toMatchObject({
      author_session_id: sessionId,
    });
  });

  it('is idempotent on retry: the same text returns the existing row, no duplicate', async () => {
    const project = await seeded();
    const first = await record(project.projectRoot, { content: 'Retried after a lost call.' });
    const before = count(project.dbPath);
    const second = await record(project.projectRoot, { content: 'Retried after a lost call.' });

    expect((second.data as unknown as RecordReceipt).decisionId).toBe(
      (first.data as unknown as RecordReceipt).decisionId
    );
    expect((second.data as unknown as RecordReceipt).materialization).toBe('existing');
    expect(count(project.dbPath)).toBe(before);
  });

  it('refuses a supersedes target that does not exist and writes nothing', async () => {
    const project = await seeded();
    const before = count(project.dbPath);

    const result = await record(project.projectRoot, {
      content: 'Points at a row that is not there.',
      supersedes: [999_999],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'supersedes' });
    expect(result.error?.suggestion).toContain('cmos_decisions(action="list")');
    expect(count(project.dbPath)).toBe(before);
  });

  it('refuses to let a decision supersede itself and leaves it active', async () => {
    const project = await seeded();
    const first = await record(project.projectRoot, { content: 'Cannot replace itself.' });
    const id = (first.data as unknown as RecordReceipt).decisionId;

    const result = await record(project.projectRoot, {
      content: 'Cannot replace itself.',
      supersedes: [id],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'supersedes' });
    expect(row(project.dbPath, id)).toMatchObject({ status: 'active', superseded_by: null });
  });

  it('refuses an unknown missionId instead of stamping a false provenance claim', async () => {
    const project = await seeded();
    const result = await record(project.projectRoot, {
      content: 'Belongs to a mission that does not exist.',
      missionId: 'no-such-mission',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSION_NOT_FOUND');
  });

  it('resolves the open sprint when no mission or sprintId is given, and discloses a null', async () => {
    const project = await seeded();
    const open = await record(project.projectRoot, { content: 'Tagged to the open sprint.' });
    expect((open.data as unknown as RecordReceipt).sprintId).toBe('sprint-b');

    const db = new Database(project.dbPath);
    db.exec(`UPDATE sprints SET status = 'Completed' WHERE id = 'sprint-b'`);
    db.close();
    const none = await record(project.projectRoot, { content: 'No sprint is open now.' });
    expect((none.data as unknown as RecordReceipt).sprintId).toBeNull();
    expect(none.warnings?.join('\n')).toContain('no open sprint');
  });

  it('requires content', async () => {
    const project = await seeded();
    const result = await record(project.projectRoot, { content: '   ' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });
});
