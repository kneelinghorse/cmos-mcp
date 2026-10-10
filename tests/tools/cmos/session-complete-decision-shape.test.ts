// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Session close must prepare decision storage for both parameter and stored-capture inputs.
// ABOUTME: A rejected migration leaves the session active and preserves its retryable lifecycle state.

import Database from 'better-sqlite3';
import { cmosSessionComplete } from '../../../src/tools/cmos/cmos-session-complete';
import { createSeededCmosProject, type SeededCmosProject } from '../../helpers/seedCmosDb';

let project: SeededCmosProject;
const fields = [
  'context_text',
  'alternatives',
  'consequences',
  'deciders',
  'approval_mode',
  'approval_draft',
  'approval_words',
];
const content = 'Prepare decision storage before closing its authoring session.';

beforeEach(async () => {
  project = await createSeededCmosProject({}, 'cmos-session-close-shape-');
  const db = new Database(project.dbPath);
  try {
    for (const name of ['decisions_fts_insert', 'decisions_fts_delete', 'decisions_fts_update'])
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec('DROP TABLE IF EXISTS decisions_fts');
    for (const field of fields) db.exec(`ALTER TABLE strategic_decisions DROP COLUMN ${field}`);
    db.prepare("DELETE FROM metadata WHERE key='decision_shape_columns'").run();
    db.prepare(
      `INSERT INTO sessions (id,type,title,started_at,status,captures)
       VALUES ('shape-close','planning','Shape preflight',?,'active','[]')`
    ).run(new Date(Date.now() - 60_000).toISOString());
  } finally {
    db.close();
  }
});
afterEach(async () => project.cleanup());

it.each(['parameters', 'stored capture'])(
  'migrates a legacy store before completing a session with decisions from %s',
  async (source) => {
    if (source === 'stored capture') {
      const db = new Database(project.dbPath);
      db.prepare("UPDATE sessions SET captures=? WHERE id='shape-close'").run(
        JSON.stringify([{ category: 'decision', content }])
      );
      db.close();
    }
    const result = await cmosSessionComplete({
      projectRoot: project.projectRoot,
      sessionId: 'shape-close',
      summary: 'Verified the decision migration before session close.',
      ...(source === 'parameters' ? { decisions: [content] } : {}),
    });
    expect(result.success).toBe(true);
    expect(result.data?.decisionsExtracted).toBe(1);
    const db = new Database(project.dbPath, { readonly: true });
    try {
      expect(
        db.prepare("SELECT value FROM metadata WHERE key='decision_shape_columns'").get()
      ).toEqual({ value: '1' });
      const columns = db.pragma('table_info(strategic_decisions)') as { name: string }[];
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(fields));
      expect(db.prepare('SELECT decision_text FROM strategic_decisions').all()).toEqual([
        { decision_text: content },
      ]);
      expect(db.prepare("SELECT status FROM sessions WHERE id='shape-close'").get()).toEqual({
        status: 'completed',
      });
    } finally {
      db.close();
    }
  }
);

it('refuses a parameters-only close before lifecycle writes when migration cannot own the FTS table', async () => {
  const db = new Database(project.dbPath);
  let before: unknown;
  try {
    db.exec('CREATE TABLE decisions_fts (unowned_payload TEXT)');
    before = db
      .prepare(
        "SELECT status,completed_at,summary,captures,next_steps FROM sessions WHERE id='shape-close'"
      )
      .get();
  } finally {
    db.close();
  }
  const result = await cmosSessionComplete({
    projectRoot: project.projectRoot,
    sessionId: 'shape-close',
    summary: 'This close must remain retryable.',
    decisions: [content],
  });
  expect(result).toMatchObject({ success: false, error: { code: 'DB_QUERY_FAILED' } });
  expect(result.error?.suggestion).toBeTruthy();
  expect(result.warnings?.join(' ')).toContain('unrecognized or foreign definition');
  const after = new Database(project.dbPath, { readonly: true });
  try {
    expect(
      after
        .prepare(
          "SELECT status,completed_at,summary,captures,next_steps FROM sessions WHERE id='shape-close'"
        )
        .get()
    ).toEqual(before);
    expect(after.prepare('SELECT COUNT(*) AS n FROM strategic_decisions').get()).toEqual({ n: 0 });
    expect(
      after.prepare("SELECT COUNT(*) AS n FROM session_events WHERE action='complete'").get()
    ).toEqual({ n: 0 });
    expect(
      after.prepare("SELECT value FROM metadata WHERE key='decision_shape_columns'").get()
    ).toBeUndefined();
  } finally {
    after.close();
  }
});
