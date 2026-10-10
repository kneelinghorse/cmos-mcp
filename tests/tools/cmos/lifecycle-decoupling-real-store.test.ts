// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Positive fires for every m05 item operate on consistent SQLite backups of the real store.
// ABOUTME: The live source is readonly; every handler root is a suite-private copy, never the origin.
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { cmosMissionAdd } from '../../../src/tools/cmos/cmos-mission-add';
import { cmosMissionUpdate } from '../../../src/tools/cmos/cmos-mission-update';
import { cmosMissionStart } from '../../../src/tools/cmos/cmos-mission-start';
import { cmosContextCondense } from '../../../src/tools/cmos/cmos-context-condense';
import { cmosNextSteps } from '../../../src/tools/cmos/cmos-next-steps';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
const PRIVATE = requiresPrivateEvidence({
  reason: 'B1.1 and historical context/lease positive fires require a private source backup.',
  paths: { liveDb: 'cmos/db/cmos.sqlite' },
});
const live = path.resolve('cmos/db/cmos.sqlite');
function sourceHashes(file = live): Record<string, string | null> {
  return Object.fromEntries(
    ['', '-wal'].map((s) => [
      s,
      fs.existsSync(file + s)
        ? crypto
            .createHash('sha256')
            .update(fs.readFileSync(file + s))
            .digest('hex')
        : null,
    ])
  );
}
function openBackupSource(file: string): Database.Database {
  const source = new Database(file, { readonly: true, fileMustExist: true });
  // SQLite's first readonly schema access can create an empty WAL sidecar. Establish
  // that connection state before hashing; retain exact main/WAL bytes until final check.
  source.pragma('schema_version');
  return source;
}
it('keeps exact source bytes stable across readonly backups and detects real WAL writes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m05-byte-oracle-'));
  const file = path.join(directory, 'source.sqlite');
  const seed = new Database(file);
  seed.pragma('journal_mode=WAL');
  seed.exec('CREATE TABLE witness(value TEXT)');
  seed.close();
  expect(fs.existsSync(file + '-wal')).toBe(false);
  const source = openBackupSource(file);
  try {
    const before = sourceHashes(file);
    await source.backup(path.join(directory, 'copy.sqlite'));
    expect(sourceHashes(file)).toEqual(before);
    const writer = new Database(file);
    try {
      writer.exec("INSERT INTO witness VALUES ('changed')");
      const after = sourceHashes(file);
      expect(after['']).toBe(before['']);
      expect(after['-wal']).not.toBe(before['-wal']);
      expect(after).not.toEqual(before);
    } finally {
      writer.close();
    }
  } finally {
    source.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
PRIVATE.describe('m05 existing-store positive fires', () => {
  let root: string, db: Database.Database, source: Database.Database;
  let before: Record<string, string | null>;
  beforeAll(() => {
    source = openBackupSource(live);
    before = sourceHashes();
  });
  afterAll(() => {
    try {
      expect(sourceHashes()).toEqual(before);
    } finally {
      source.close();
    }
  });
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m05-real-'));
    fs.mkdirSync(path.join(root, 'cmos', 'db'), { recursive: true });
    await source.backup(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
    db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
    CmosDetector.resetInstance();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('records an explicitly unscheduled mission in the actual nullable FK schema', async () => {
    const result = await cmosMissionAdd({
      missionId: 'm05-copy-free',
      name: 'Unscheduled witness',
      sprintId: null,
      projectRoot: root,
    });
    expect(result.success).toBe(true);
    expect(db.prepare("SELECT sprint_id FROM missions WHERE id='m05-copy-free'").get()).toEqual({
      sprint_id: null,
    });
  });
  it.each(['Queued', 'Deferred', 'Dropped'] as const)(
    'repairs actual B1.1 Archived to %s and retains its audit record',
    async (status) => {
      expect(db.prepare("SELECT status FROM missions WHERE id='B1.1'").get()).toEqual({
        status: 'Archived',
      });
      const result = await cmosMissionUpdate({
        missionId: 'B1.1',
        fields: { status },
        projectRoot: root,
      });
      expect(result.success).toBe(true);
      expect(db.prepare("SELECT status FROM missions WHERE id='B1.1'").get()).toEqual({ status });
      expect(
        db
          .prepare(
            "SELECT raw_event FROM session_events WHERE mission='B1.1' AND action='update' ORDER BY id DESC LIMIT 1"
          )
          .get()
      ).toEqual({ raw_event: expect.stringContaining('"previousStatus":"Archived"') });
    }
  );
  it('activates a copied Planned parent and persists its existing context shape', async () => {
    db.exec(
      "UPDATE sprints SET status='Planned' WHERE UPPER(status) IN ('ACTIVE','CURRENT','IN PROGRESS')"
    );
    const { cmosSprintAdd } = await import('../../../src/tools/cmos/cmos-sprint-add');
    expect(
      (
        await cmosSprintAdd({
          sprintId: 'm05-copy-parent',
          title: 'Copy parent',
          status: 'Planned',
          projectRoot: root,
        })
      ).success
    ).toBe(true);
    expect(
      (
        await cmosMissionAdd({
          missionId: 'm05-copy-start',
          name: 'Start witness',
          sprintId: 'm05-copy-parent',
          projectRoot: root,
        })
      ).success
    ).toBe(true);
    expect(
      (await cmosMissionStart({ missionId: 'm05-copy-start', projectRoot: root })).success
    ).toBe(true);
    const content = JSON.parse(
      (
        db.prepare("SELECT content FROM contexts WHERE id='master_context'").get() as {
          content: string;
        }
      ).content
    );
    expect(content.sprint_tracking.current_sprint.id).toBe('m05-copy-parent');
  });
  it('reports section bytes from the copied real context without persisting a dry run', async () => {
    const before = (
      db.prepare("SELECT content FROM contexts WHERE id='master_context'").get() as {
        content: string;
      }
    ).content;
    const result = await cmosContextCondense({
      contextType: 'master_context',
      dryRun: true,
      strategy: 'conservative',
      targetSizePercent: 60,
      projectRoot: root,
    });
    expect(result.success).toBe(true);
    expect(Object.keys(result.data!.remainingSectionBytes).length).toBeGreaterThan(0);
    expect(
      (
        db.prepare("SELECT content FROM contexts WHERE id='master_context'").get() as {
          content: string;
        }
      ).content
    ).toBe(before);
  });
  it('reopens a historical carried row while preserving its actual lease anchor', async () => {
    const row = db
      .prepare(
        "SELECT id,resolved_at FROM next_steps WHERE status='carried' AND resolved_at IS NOT NULL ORDER BY id LIMIT 1"
      )
      .get() as { id: number; resolved_at: string };
    expect(row).toBeDefined();
    const result = await cmosNextSteps({
      nextStepAction: 'reopen',
      nextStepIds: [row.id],
      projectRoot: root,
    });
    expect(result.data?.affected).toBe(1);
    expect(db.prepare('SELECT status,resolved_at FROM next_steps WHERE id=?').get(row.id)).toEqual({
      status: 'pending',
      resolved_at: row.resolved_at,
    });
  });
});
