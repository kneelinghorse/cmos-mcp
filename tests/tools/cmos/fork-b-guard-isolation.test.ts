// ABOUTME: s81-m04 Fork B — a forced Layer-0 (patchProjectIdentity) write failure inside
// ABOUTME: the mission-complete guard must NEVER fail the mission-complete (blast radius).

/**
 * s81-m04 — the guard's Layer-0 row stamp is wrapped in an isolated try/failure. If
 * patchProjectIdentity throws (a corrupt/locked identity row), the mission-complete must
 * still succeed — a hot-path change touching EVERY sibling's mission-complete must not
 * be able to fail a completion on an identity-write hiccup.
 *
 * @module tests/tools/cmos/fork-b-guard-isolation
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Force the Layer-0 stamp to throw; keep the rest of project-identity real.
jest.mock('../../../src/tools/cmos/project-identity', () => {
  const actual = jest.requireActual('../../../src/tools/cmos/project-identity');
  return {
    ...actual,
    patchProjectIdentity: jest.fn(() => {
      throw new Error('forced Layer-0 write failure');
    }),
  };
});

import { seedCmosDb } from '../../helpers/seedCmosDb';
import { cmosMissionComplete } from '../../../src/tools/cmos/cmos-mission-complete';
import { patchProjectIdentity } from '../../../src/tools/cmos/project-identity';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('s81-m04 Fork B guard failure isolation', () => {
  afterEach(() => CmosDetector.resetInstance());

  it('a forced Layer-0 write failure does NOT fail the mission-complete (and the mission still Completes)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-b-iso-'));
    try {
      const dbPath = seedCmosDb(root, { projectId: 'p', description: '' });
      const db = new Database(dbPath);
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        'project_description',
        'A description that would be stamped if the write did not throw.'
      );
      db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)').run(
        's',
        'S',
        'Active'
      );
      db.prepare('INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, ?, ?)').run(
        'm1',
        's',
        'M1',
        'In Progress'
      );
      db.close();
      CmosDetector.resetInstance();

      const result = await cmosMissionComplete({ missionId: 'm1', projectRoot: root });

      // The guard threw internally, but the mission-complete succeeded.
      expect(patchProjectIdentity).toHaveBeenCalled();
      expect(result.success).toBe(true);

      const verify = new Database(dbPath, { readonly: true });
      const mission = verify.prepare('SELECT status FROM missions WHERE id = ?').get('m1') as {
        status: string;
      };
      verify.close();
      expect(mission.status).toBe('Completed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
