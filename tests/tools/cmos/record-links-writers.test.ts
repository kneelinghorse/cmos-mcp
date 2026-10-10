// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Canonical writers commit persisted records and citation links as one required unit.
// ABOUTME: Real SQLite faults protect capture history, dedup repair and completion retry boundaries.

import Database from 'better-sqlite3';
import { cmosDecisionsRecord } from '../../../src/tools/cmos/cmos-decisions-record';
import { cmosSessionCapture } from '../../../src/tools/cmos/cmos-session-capture';
import { cmosSessionComplete } from '../../../src/tools/cmos/cmos-session-complete';
import { cmosMissionComplete } from '../../../src/tools/cmos/cmos-mission-complete';
import { cmosDecisionsUpdate } from '../../../src/tools/cmos/cmos-decisions-update';
import { recordEmbedding } from '../../../src/intelligence/embedding-pipeline';
import { createSeededCmosProject, type SeededCmosProject } from '../../helpers/seedCmosDb';

jest.mock('../../../src/intelligence/embedding-pipeline', () => ({
  ...jest.requireActual('../../../src/intelligence/embedding-pipeline'),
  recordEmbedding: jest.fn(async () => ({ success: true, warnings: [] })),
}));

let project: SeededCmosProject;
let target: number;
function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(project.dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
beforeEach(async () => {
  project = await createSeededCmosProject({}, 'cmos-links-writer-');
  withDb((db) => {
    target = Number(
      db
        .prepare('INSERT INTO strategic_decisions(decision_text,created_at) VALUES (?,?)')
        .run('Earlier local design.', new Date(Date.now() - 60_000).toISOString()).lastInsertRowid
    );
    db.prepare(
      "INSERT INTO sessions(id,type,title,started_at,status) VALUES ('writer-session','build','Writer',?,'active')"
    ).run(new Date(Date.now() - 30_000).toISOString());
    db.exec(
      "INSERT INTO missions(id,name,status) VALUES ('writer-mission','Writer mission','In Progress')"
    );
  });
});
afterEach(async () => project.cleanup());

type Route = 'record' | 'decision capture' | 'learning capture' | 'session close' | 'mission close';
const routes: Route[] = [
  'record',
  'decision capture',
  'learning capture',
  'session close',
  'mission close',
];
function write(route: Route, content: string) {
  const projectRoot = project.projectRoot;
  if (route === 'record') return cmosDecisionsRecord({ projectRoot, content });
  if (route === 'session close')
    return cmosSessionComplete({
      projectRoot,
      sessionId: 'writer-session',
      summary: 'Close with linked decision.',
      decisions: [content],
    });
  if (route === 'mission close')
    return cmosMissionComplete({
      projectRoot,
      missionId: 'writer-mission',
      notes: 'Complete with linked decision.',
      decisions: [content],
    });
  return cmosSessionCapture({
    projectRoot,
    sessionId: 'writer-session',
    category: route === 'learning capture' ? 'learning' : 'decision',
    content,
  });
}
function edges() {
  return withDb((db) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='record_links'").get()
      ? db
          .prepare(
            'SELECT from_kind,from_id,to_kind,to_id FROM record_links ORDER BY from_id,to_id'
          )
          .all()
      : []
  );
}
function records(route: Route) {
  const table = route === 'learning capture' ? 'learnings' : 'strategic_decisions';
  return withDb((db) => db.prepare(`SELECT * FROM ${table}`).all()) as { id: number }[];
}
async function installFault() {
  const prepared = await cmosDecisionsRecord({
    projectRoot: project.projectRoot,
    content: 'Prepare the writer schema.',
  });
  expect(prepared.success).toBe(true);
  withDb((db) =>
    db.exec(
      "CREATE TRIGGER reject_writer_links BEFORE INSERT ON record_links BEGIN SELECT RAISE(FAIL,'required link rejected'); END"
    )
  );
}

it.each(routes)('%s stores its new local citation in the same write', async (route) => {
  const result = await write(route, `Follow d:${target} for the writer contract.`);
  expect(result.success).toBe(true);
  const rows = records(route);
  const source = rows[rows.length - 1];
  expect(edges()).toContainEqual({
    from_kind: route === 'learning capture' ? 'learning' : 'decision',
    from_id: source.id,
    to_kind: 'decision',
    to_id: target,
  });
});

it.each<Route>(['record', 'decision capture', 'learning capture'])(
  '%s repairs dedup links without another record',
  async (route) => {
    const content = `Retain d:${target} when this request is retried.`;
    expect((await write(route, content)).success).toBe(true);
    const before = records(route).length;
    withDb((db) => db.exec('DELETE FROM record_links'));
    expect((await write(route, content)).success).toBe(true);
    expect(records(route)).toHaveLength(before);
    expect(edges()).toHaveLength(1);
  }
);

it.each<Route>(['record', 'decision capture', 'learning capture', 'session close'])(
  '%s refuses a required link failure without persisting its record or capture',
  async (route) => {
    await installFault();
    const before = records(route).length;
    const session = withDb((db) =>
      db.prepare("SELECT status,captures FROM sessions WHERE id='writer-session'").get()
    );
    const result = await write(route, `This failed write cites d:${target}.`);
    expect(result.success).toBe(false);
    expect(result.error?.suggestion).toBeTruthy();
    expect(records(route)).toHaveLength(before);
    expect(edges()).toEqual([]);
    expect(
      withDb((db) =>
        db.prepare("SELECT status,captures FROM sessions WHERE id='writer-session'").get()
      )
    ).toEqual(session);
  }
);

it('mission close keeps its optional failure explicit and stores no incomplete decision', async () => {
  await installFault();
  const before = records('mission close').length;
  const result = await write('mission close', `Optional failed decision cites d:${target}.`);
  expect(result.success).toBe(true);
  expect(result.data).toMatchObject({ decisionCount: 0 });
  expect(result.warnings?.join(' ')).toContain('required link rejected');
  expect(records('mission close')).toHaveLength(before);
  expect(edges()).toEqual([]);
  expect(
    withDb((db) => db.prepare("SELECT status FROM missions WHERE id='writer-mission'").get())
  ).toEqual({ status: 'Completed' });
});

it('an unchanged explicit decision update repairs stored links', async () => {
  const written = await cmosDecisionsRecord({
    projectRoot: project.projectRoot,
    content: `d:${target} supplies the stored citation to repair.`,
  });
  expect(written.success).toBe(true);
  const decisionId = (written.data as { decisionId: number }).decisionId;
  withDb((db) => db.exec('DELETE FROM record_links'));
  const result = await cmosDecisionsUpdate({ projectRoot: project.projectRoot, decisionId });
  expect(result.success).toBe(true);
  expect(edges()).toHaveLength(1);
});

it('required link failure rolls back both a new record and its supersession pointer', async () => {
  await installFault();
  const result = await cmosDecisionsRecord({
    projectRoot: project.projectRoot,
    content: `d:${target} is superseded by this failed record.`,
    supersedes: [target],
  });
  expect(result.success).toBe(false);
  expect(
    withDb((db) =>
      db.prepare('SELECT status,superseded_by FROM strategic_decisions WHERE id=?').get(target)
    )
  ).toEqual({ status: 'active', superseded_by: null });
});

it('dedup materializes persisted rich fields instead of conflicting retry fields', async () => {
  const content = 'The immutable headline keeps its original reasoning.';
  const first = await cmosDecisionsRecord({
    projectRoot: project.projectRoot,
    content,
    context: `d:${target} supplies the stored reasoning.`,
  });
  expect(first.success).toBe(true);
  withDb((db) => db.exec('DELETE FROM record_links'));
  const retry = await cmosDecisionsRecord({
    projectRoot: project.projectRoot,
    content,
    context: 'The retry has no citation.',
  });
  expect(retry.success).toBe(true);
  expect(retry.warnings?.join(' ')).toContain('were not written');
  expect(edges()).toHaveLength(1);
});

it.each<Route>(['decision capture', 'learning capture'])(
  '%s rolls back the first link when a later required link fails',
  async (route) => {
    const added = await cmosDecisionsRecord({
      projectRoot: project.projectRoot,
      content: 'Another prior local target.',
    });
    const second = (added.data as { decisionId: number }).decisionId;
    withDb((db) => {
      db.prepare('UPDATE strategic_decisions SET created_at=? WHERE id=?').run(
        new Date(Date.now() - 30_000).toISOString(),
        second
      );
      db.exec(
        `CREATE TRIGGER reject_later_link BEFORE INSERT ON record_links WHEN new.to_id=${second} BEGIN SELECT RAISE(FAIL,'later citation rejected'); END`
      );
    });
    const before = records(route).length;
    const result = await write(route, `d:${target} and d:${second} must be committed together.`);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('later citation rejected');
    expect(records(route)).toHaveLength(before);
    expect(edges()).toEqual([]);
    expect(
      withDb((db) => db.prepare("SELECT captures FROM sessions WHERE id='writer-session'").get())
    ).toEqual({ captures: '[]' });
  }
);

it('a foreign link table refuses capture before its required session unit begins', async () => {
  withDb((db) =>
    db.exec('DROP TABLE IF EXISTS record_links; CREATE TABLE record_links(unowned TEXT)')
  );
  const result = await write(
    'learning capture',
    `d:${target} cannot bypass an incompatible citation table.`
  );
  expect(result.success).toBe(false);
  expect(result.error?.suggestion).toBeTruthy();
  expect(
    withDb((db) => db.prepare("SELECT captures FROM sessions WHERE id='writer-session'").get())
  ).toEqual({ captures: '[]' });
  expect(records('learning capture')).toHaveLength(0);
});

it.each<Route>(['record', 'decision capture', 'learning capture'])(
  '%s refuses duplicate repair without changing captures or embedding a rolled-back row',
  async (route) => {
    const content = `d:${target} remains the canonical duplicate.`;
    expect((await write(route, content)).success).toBe(true);
    withDb((db) => db.exec('DELETE FROM record_links'));
    await installFault();
    const before = withDb((db) =>
      db.prepare("SELECT captures FROM sessions WHERE id='writer-session'").get()
    );
    const count = records(route).length;
    jest.mocked(recordEmbedding).mockClear();
    expect((await write(route, content)).success).toBe(false);
    expect(records(route)).toHaveLength(count);
    expect(
      withDb((db) => db.prepare("SELECT captures FROM sessions WHERE id='writer-session'").get())
    ).toEqual(before);
    expect(recordEmbedding).not.toHaveBeenCalled();
  }
);

it('a failed duplicate learning repair rolls back its supplied evergreen change', async () => {
  const content = `d:${target} supplies an evergreen candidate.`;
  expect((await write('learning capture', content)).success).toBe(true);
  withDb((db) => db.exec('DELETE FROM record_links'));
  await installFault();
  const result = await cmosSessionCapture({
    projectRoot: project.projectRoot,
    sessionId: 'writer-session',
    category: 'learning',
    content,
    evergreen: true,
  });
  expect(result.success).toBe(false);
  expect(
    withDb((db) => db.prepare('SELECT evergreen FROM learnings WHERE content=?').get(content))
  ).toEqual({ evergreen: 0 });
});

it('a failed explicit update preserves status, supersession and review timestamp', async () => {
  const result = await write('record', `d:${target} is a decision to review.`);
  const id = (result.data as { decisionId: number }).decisionId;
  expect(
    (
      await cmosDecisionsUpdate({
        projectRoot: project.projectRoot,
        decisionId: id,
        status: 'active',
      })
    ).success
  ).toBe(true);
  await installFault();
  const before = withDb((db) =>
    db
      .prepare('SELECT status,superseded_by,last_reviewed_at FROM strategic_decisions WHERE id=?')
      .get(id)
  );
  const updated = await cmosDecisionsUpdate({
    projectRoot: project.projectRoot,
    decisionId: id,
    status: 'superseded',
    supersededBy: target,
  });
  expect(updated.success).toBe(false);
  expect(
    withDb((db) =>
      db
        .prepare('SELECT status,superseded_by,last_reviewed_at FROM strategic_decisions WHERE id=?')
        .get(id)
    )
  ).toEqual(before);
});

it('session close can retry a committed decision batch after a later lifecycle refusal', async () => {
  withDb((db) =>
    db.exec(
      "CREATE TRIGGER reject_session_close BEFORE UPDATE OF status ON sessions WHEN new.status='completed' BEGIN SELECT RAISE(FAIL,'later close failure'); END"
    )
  );
  const content = `d:${target} survives a later close retry.`;
  expect((await write('session close', content)).success).toBe(false);
  const count = records('session close').length;
  expect(edges()).toHaveLength(1);
  expect(
    withDb((db) => db.prepare("SELECT status FROM sessions WHERE id='writer-session'").get())
  ).toEqual({ status: 'active' });
  withDb((db) => db.exec('DROP TRIGGER reject_session_close; DELETE FROM record_links'));
  const retried = await write('session close', content);
  expect(retried.success).toBe(true);
  expect(retried.data).toMatchObject({ decisionsExtracted: 0 });
  expect(records('session close')).toHaveLength(count);
  expect(edges()).toHaveLength(1);
});

it('a later decision failure rolls back the entire close batch and its completion event', async () => {
  await installFault();
  const before = records('session close').length;
  const events = withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM session_events').get());
  const result = await cmosSessionComplete({
    projectRoot: project.projectRoot,
    sessionId: 'writer-session',
    summary: 'Atomic decision batch.',
    decisions: ['First decision has no citation.', `d:${target} rejects the second decision.`],
  });
  expect(result.success).toBe(false);
  expect(records('session close')).toHaveLength(before);
  expect(withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM session_events').get())).toEqual(
    events
  );
});

it('a missing table recreated in the same process is repaired without a stale negative result', async () => {
  withDb((db) =>
    db.exec(
      "DROP TABLE IF EXISTS record_links; DELETE FROM metadata WHERE key='record_links_schema'"
    )
  );
  expect((await write('record', `d:${target} recreates the link table.`)).success).toBe(true);
  expect(edges()).toHaveLength(1);
});
