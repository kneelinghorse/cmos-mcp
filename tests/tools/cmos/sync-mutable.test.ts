/**
 * Sprint 71 m04 — mutable-surface engine unit tests.
 *
 * Covers the LWW key (incomingWins) exhaustively, the metadata-backed status state
 * + collab-role marker + monotonic origin_seq, and the inbound mission-status apply
 * (applied / lost-LWW / no-row) against a real seed-schema store.
 *
 * @module tests/tools/cmos/sync-mutable
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withClientAsync, type CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { createSuccess } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import {
  incomingWins,
  isCollabStore,
  readCollabRole,
  setCollabRole,
  readStatusState,
  writeStatusState,
  nextOriginSeq,
  applyInboundMissionStatus,
  applyLocalMissionStatus,
  applyInboundMutableStatus,
  applyLocalMutableStatus,
  mutableEventTypeForScope,
  buildMutableEventData,
  PROJECT_IDENTITY_ENTITY_ID,
} from '../../../src/tools/cmos/sync-mutable';
import { getProjectIdentity } from '../../../src/tools/cmos/project-identity';

// ─── incomingWins (pure LWW key) ─────────────────────────────────────────────────

describe('incomingWins (Sprint 71 m04 LWW key)', () => {
  it('a null current always loses to incoming (first edit wins)', () => {
    expect(incomingWins({ occurredAt: 100, originSeq: 1 }, null)).toBe(true);
  });

  it('newer occurredAt wins', () => {
    expect(incomingWins({ occurredAt: 200, originSeq: 1 }, { occurredAt: 100, originSeq: 9 })).toBe(
      true
    );
    expect(incomingWins({ occurredAt: 100, originSeq: 9 }, { occurredAt: 200, originSeq: 1 })).toBe(
      false
    );
  });

  it('on equal occurredAt, higher originSeq wins', () => {
    expect(incomingWins({ occurredAt: 100, originSeq: 5 }, { occurredAt: 100, originSeq: 4 })).toBe(
      true
    );
    expect(incomingWins({ occurredAt: 100, originSeq: 4 }, { occurredAt: 100, originSeq: 5 })).toBe(
      false
    );
  });

  it('on a full tie, the incoming (last arrival) wins', () => {
    expect(incomingWins({ occurredAt: 100, originSeq: 5 }, { occurredAt: 100, originSeq: 5 })).toBe(
      true
    );
  });

  it('a null occurredAt on either side falls back to last-arrival (incoming wins)', () => {
    expect(
      incomingWins({ occurredAt: null, originSeq: 1 }, { occurredAt: 100, originSeq: 1 })
    ).toBe(true);
    expect(
      incomingWins({ occurredAt: 100, originSeq: 1 }, { occurredAt: null, originSeq: 1 })
    ).toBe(true);
  });
});

// ─── Metadata-backed state + inbound apply ───────────────────────────────────────

describe('sync-mutable state + inbound apply (Sprint 71 m04)', () => {
  let tempDir: string;
  let dbPath: string;
  const seedSchema = fs.readFileSync(
    path.join(__dirname, '../../../cmos-seed/db/schema.sql'),
    'utf8'
  );

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-syncmutable-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.exec(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', 'Test Project');
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'm', '{}');
      INSERT INTO missions (id, name, status) VALUES ('m1', 'Mission 1', 'In Progress');
    `);
    db.close();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function withDb(fn: (db: CmosDatabaseClient) => void): Promise<void> {
    await withClientAsync(
      async (db) => {
        fn(db);
        return createSuccess({});
      },
      { projectRoot: tempDir }
    );
  }

  it('reads/writes the collab_role marker and gates isCollabStore on its presence', async () => {
    await withDb((db) => {
      expect(readCollabRole(db)).toBeNull();
      expect(isCollabStore(db)).toBe(false);
      setCollabRole(db, 'editor');
      expect(readCollabRole(db)).toBe('editor');
      expect(isCollabStore(db)).toBe(true);
      return {};
    });
  });

  it('round-trips status state as JSON in metadata', async () => {
    await withDb((db) => {
      expect(readStatusState(db, 'mission_active', 'm1')).toBeNull();
      writeStatusState(db, 'mission_active', 'm1', {
        status: 'Blocked',
        occurredAt: 12345,
        originSeq: 7,
        authorUserId: 'u-9',
      });
      const s = readStatusState(db, 'mission_active', 'm1');
      expect(s).toEqual({
        status: 'Blocked',
        occurredAt: 12345,
        originSeq: 7,
        authorUserId: 'u-9',
      });
      return {};
    });
  });

  it('nextOriginSeq is monotonic and persists across reads', async () => {
    await withDb((db) => {
      expect(nextOriginSeq(db)).toBe(1);
      expect(nextOriginSeq(db)).toBe(2);
      expect(nextOriginSeq(db)).toBe(3);
      return {};
    });
  });

  it('applyInboundMissionStatus applies a winning edit and records ordering state', async () => {
    await withDb((db) => {
      const outcome = applyInboundMissionStatus(db, {
        missionId: 'm1',
        status: 'Completed',
        occurredAt: 5000,
        originSeq: 2,
        authorUserId: 'u-a',
      });
      expect(outcome).toBe('applied');
      const row = db.getOne<{ status: string }>('SELECT status FROM missions WHERE id = ?', ['m1']);
      expect(row.data?.status).toBe('Completed');
      expect(readStatusState(db, 'mission_active', 'm1')?.occurredAt).toBe(5000);
      return {};
    });
  });

  it('applyInboundMissionStatus skips a losing edit (does not clobber a newer local value)', async () => {
    await withDb((db) => {
      applyLocalMissionStatus(db, 'm1', 'Blocked', 9000, 3); // newer local value
      const outcome = applyInboundMissionStatus(db, {
        missionId: 'm1',
        status: 'Completed',
        occurredAt: 5000, // older → loses
        originSeq: 2,
        authorUserId: 'u-a',
      });
      expect(outcome).toBe('skipped');
      const row = db.getOne<{ status: string }>('SELECT status FROM missions WHERE id = ?', ['m1']);
      expect(row.data?.status).toBe('Blocked'); // unchanged
      return {};
    });
  });

  it('applyInboundMissionStatus skips a non-existent mission row without recording state', async () => {
    await withDb((db) => {
      const outcome = applyInboundMissionStatus(db, {
        missionId: 'ghost',
        status: 'Completed',
        occurredAt: 5000,
        originSeq: 1,
        authorUserId: null,
      });
      expect(outcome).toBe('skipped');
      expect(readStatusState(db, 'mission_active', 'ghost')).toBeNull();
      return {};
    });
  });
});

// ─── Sprint 72 m01 — generic mutable-scope engine ────────────────────────────────

describe('generic mutable-scope engine (Sprint 72 m01)', () => {
  let tempDir: string;
  let dbPath: string;
  const seedSchema = fs.readFileSync(
    path.join(__dirname, '../../../cmos-seed/db/schema.sql'),
    'utf8'
  );

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-mutscope-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.exec(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', 'Old Name');
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'm', '{}');
      INSERT INTO missions (id, name, status) VALUES ('m1', 'Mission 1', 'In Progress');
      INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Active');
    `);
    db.close();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function withDb(fn: (db: CmosDatabaseClient) => void): Promise<void> {
    await withClientAsync(
      async (db) => {
        fn(db);
        return createSuccess({});
      },
      { projectRoot: tempDir }
    );
  }

  it('mutableEventTypeForScope is identity-preserving for mission_active + maps the new scopes', () => {
    expect(mutableEventTypeForScope('mission_active')).toBe('mission_updated');
    expect(mutableEventTypeForScope('sprint_status')).toBe('sprint_updated');
    expect(mutableEventTypeForScope('project_identity')).toBe('project_identity_updated');
  });

  it('PROJECT_IDENTITY_ENTITY_ID is the fixed "project" sentinel', () => {
    expect(PROJECT_IDENTITY_ENTITY_ID).toBe('project');
  });

  it('buildMutableEventData shapes the per-scope data envelope', () => {
    const ordering = { occurredAt: 5000, originSeq: 2, stableEventId: 'EVT', schemaVersion: 1 };

    // mission_active is byte-for-byte the Sprint 71 m04 shape.
    expect(buildMutableEventData('mission_active', 'm1', 'Completed', ordering)).toEqual({
      missionId: 'm1',
      currentStatus: 'Completed',
      occurredAt: 5000,
      originSeq: 2,
      stableEventId: 'EVT',
      schemaVersion: 1,
    });
    expect(buildMutableEventData('sprint_status', 's1', 'Completed', ordering)).toEqual({
      sprintId: 's1',
      status: 'Completed',
      occurredAt: 5000,
      originSeq: 2,
      stableEventId: 'EVT',
      schemaVersion: 1,
    });
    const proj = buildMutableEventData(
      'project_identity',
      PROJECT_IDENTITY_ENTITY_ID,
      'New Name',
      ordering
    );
    expect(proj).toEqual({
      name: 'New Name',
      occurredAt: 5000,
      originSeq: 2,
      stableEventId: 'EVT',
      schemaVersion: 1,
    });
    // project_identity carries NO entity id.
    expect('missionId' in proj).toBe(false);
    expect('sprintId' in proj).toBe(false);
  });

  it('applyInboundMutableStatus applies a sprint_status edit to sprints.status + records ordering', async () => {
    await withDb((db) => {
      const outcome = applyInboundMutableStatus(db, 'sprint_status', {
        entityId: 's1',
        value: 'Completed',
        occurredAt: 5000,
        originSeq: 2,
        authorUserId: 'u-a',
      });
      expect(outcome).toBe('applied');
      const row = db.getOne<{ status: string }>('SELECT status FROM sprints WHERE id = ?', ['s1']);
      expect(row.data?.status).toBe('Completed');
      expect(readStatusState(db, 'sprint_status', 's1')?.occurredAt).toBe(5000);
    });
  });

  it('applyInboundMutableStatus skips a losing sprint edit (no clobber of a newer local value)', async () => {
    await withDb((db) => {
      applyLocalMutableStatus(db, 'sprint_status', 's1', 'Active', 9000, 3); // newer local
      const outcome = applyInboundMutableStatus(db, 'sprint_status', {
        entityId: 's1',
        value: 'Completed',
        occurredAt: 5000, // older → loses
        originSeq: 2,
        authorUserId: 'u-a',
      });
      expect(outcome).toBe('skipped');
      const row = db.getOne<{ status: string }>('SELECT status FROM sprints WHERE id = ?', ['s1']);
      expect(row.data?.status).toBe('Active'); // unchanged
    });
  });

  it('applyInboundMutableStatus applies a project_identity name under the project sentinel', async () => {
    await withDb((db) => {
      const outcome = applyInboundMutableStatus(db, 'project_identity', {
        entityId: PROJECT_IDENTITY_ENTITY_ID,
        value: 'New Name',
        occurredAt: 7000,
        originSeq: 4,
        authorUserId: 'u-b',
      });
      expect(outcome).toBe('applied');
      expect(getProjectIdentity(db)?.project_name).toBe('New Name');
      const state = readStatusState(db, 'project_identity', PROJECT_IDENTITY_ENTITY_ID);
      expect(state?.status).toBe('New Name');
      expect(state?.occurredAt).toBe(7000);
    });
  });

  it('applyLocalMutableStatus optimistically writes the sprint row + records the fresh ordering', async () => {
    await withDb((db) => {
      const changes = applyLocalMutableStatus(
        db,
        'sprint_status',
        's1',
        'Completed',
        1234,
        5,
        null
      );
      expect(changes).toBe(1);
      const row = db.getOne<{ status: string }>('SELECT status FROM sprints WHERE id = ?', ['s1']);
      expect(row.data?.status).toBe('Completed');
      expect(readStatusState(db, 'sprint_status', 's1')).toEqual({
        status: 'Completed',
        occurredAt: 1234,
        originSeq: 5,
        authorUserId: null,
      });
    });
  });

  it('mission_active still routes through the generic engine identically (frozen path)', async () => {
    await withDb((db) => {
      const outcome = applyInboundMutableStatus(db, 'mission_active', {
        entityId: 'm1',
        value: 'Completed',
        occurredAt: 5000,
        originSeq: 2,
        authorUserId: 'u-a',
      });
      expect(outcome).toBe('applied');
      const row = db.getOne<{ status: string }>('SELECT status FROM missions WHERE id = ?', ['m1']);
      expect(row.data?.status).toBe('Completed');
      // identity-preserving metadata key: mutable_status:mission_active:<id>
      expect(readStatusState(db, 'mission_active', 'm1')?.status).toBe('Completed');
    });
  });
});
