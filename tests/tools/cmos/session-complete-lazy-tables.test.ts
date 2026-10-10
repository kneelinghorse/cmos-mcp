// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Session close prepares every pending extraction table before firehose migration stamps.
// ABOUTME: Mixed legacy captures and parameters must all persist when their tables start absent.

import Database from 'better-sqlite3';
import { cmosSessionComplete } from '../../../src/tools/cmos/cmos-session-complete';
import { createSeededCmosProject, type SeededCmosProject } from '../../helpers/seedCmosDb';

jest.mock('../../../src/intelligence/embedding-pipeline', () => ({
  recordEmbedding: jest.fn(async () => ({ success: true })),
  decisionEmbeddingInput: (text: string) => text,
}));

let project: SeededCmosProject;
beforeEach(async () => {
  project = await createSeededCmosProject({}, 'cmos-session-lazy-tables-');
  const db = new Database(project.dbPath);
  try {
    db.exec('DROP TABLE next_steps; DROP TABLE constraints');
    db.prepare(
      "DELETE FROM metadata WHERE key IN ('firehose_event_columns', 'author_namespace_columns')"
    ).run();
    db.prepare(
      `INSERT INTO sessions (id,type,title,started_at,status,captures)
       VALUES ('lazy-close','planning','Legacy mixed captures',?,'active',?)`
    ).run(
      new Date(Date.now() - 60_000).toISOString(),
      JSON.stringify([
        { category: 'next-step', content: 'Keep capture-sourced follow-up' },
        { category: 'constraint', content: 'Keep the recorded boundary' },
      ])
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name IN ('next_steps','constraints')").all()
    ).toEqual([]);
  } finally {
    db.close();
  }
});
afterEach(async () => project.cleanup());

it.each(['parameters', 'capture', 'none'])(
  'creates both absent extraction tables before firehose preparation with decision input from %s',
  async (source) => {
    const decision = 'Keep every category when closing a legacy session.';
    if (source === 'capture') {
      const db = new Database(project.dbPath);
      const row = db.prepare("SELECT captures FROM sessions WHERE id='lazy-close'").get() as {
        captures: string;
      };
      db.prepare("UPDATE sessions SET captures=? WHERE id='lazy-close'").run(
        JSON.stringify([...JSON.parse(row.captures), { category: 'decision', content: decision }])
      );
      db.close();
    }
    const result = await cmosSessionComplete({
      projectRoot: project.projectRoot,
      sessionId: 'lazy-close',
      summary: 'Preserved mixed captures and explicit next steps.',
      nextSteps: ['Keep capture-sourced follow-up', 'Keep parameter-sourced follow-up'],
      ...(source === 'parameters' ? { decisions: [decision] } : {}),
    });
    expect(result.success).toBe(true);
    expect(result.data?.writeFailures).toEqual([]);
    expect(result.data).toMatchObject({
      decisionsExtracted: source === 'none' ? 0 : 1,
      nextStepsExtracted: 2,
      constraintsExtracted: 1,
    });
    const db = new Database(project.dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT content FROM next_steps ORDER BY id').all()).toEqual([
        { content: 'Keep capture-sourced follow-up' },
        { content: 'Keep parameter-sourced follow-up' },
      ]);
      expect(db.prepare('SELECT content FROM constraints').all()).toEqual([
        { content: 'Keep the recorded boundary' },
      ]);
      for (const table of ['next_steps', 'constraints']) {
        const columns = db.pragma(`table_info(${table})`) as { name: string }[];
        expect(columns.map((column) => column.name)).toEqual(
          expect.arrayContaining([
            'project_id',
            'stable_event_id',
            'occurred_at',
            'origin_seq',
            'event_type',
            'schema_version',
          ])
        );
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${table} WHERE stable_event_id IS NULL OR event_type IS NULL`
            )
            .get()
        ).toEqual({ n: 0 });
      }
    } finally {
      db.close();
    }
  }
);
