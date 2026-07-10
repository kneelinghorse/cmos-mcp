// ABOUTME: s81-m04 Fork B convergence — the mission-complete guard stamps BOTH the
// ABOUTME: master_context blob AND the Layer-0 project_identity row from the metadata seed.

/**
 * s81-m04 — Fork B convergence code. Real-store FIRE tests proving:
 *   1. On mission-complete, syncProjectIdentityFromMetadata stamps the description onto
 *      BOTH the master_context blob project_identity section AND the Layer-0
 *      project_identity ROW, from the SAME metadata.project_description seed — so the two
 *      projections can no longer split-brain.
 *   2. ensureProjectIdentityRow's seed-precedence fix seeds a fresh row with a NON-EMPTY
 *      description (metadata.project_description → content.project.description → section).
 *   3. A source grep-gate confirms the guard passes ONLY {description,status,project_name}
 *      to patchProjectIdentity (never cmos_address/objectives/foundational_docs — #682).
 *
 * @module tests/tools/cmos/fork-b-convergence
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import { cmosMissionComplete } from '../../../src/tools/cmos/cmos-mission-complete';
import {
  ensureProjectIdentityRow,
  getProjectIdentity,
} from '../../../src/tools/cmos/project-identity';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

const OPEN_CORE_DESC = 'An open-core MCP server for CMOS project management operations.';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fork-b-conv-'));
}

/** Read the Layer-0 project_identity row description directly from the store. */
function readRowDescription(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT content FROM contexts WHERE id = 'project_identity'").get() as
    | { content: string }
    | undefined;
  db.close();
  return row ? (JSON.parse(row.content).description as string) : '';
}

/** Read the master_context blob's project_identity.description. */
function readBlobDescription(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT content FROM contexts WHERE id = 'master_context'").get() as
    | { content: string }
    | undefined;
  db.close();
  if (!row) return '';
  const pi = JSON.parse(row.content).project_identity;
  return pi && typeof pi.description === 'string' ? pi.description : '';
}

describe('s81-m04 Fork B convergence (mission-complete guard stamps blob + Layer-0 row)', () => {
  afterEach(() => CmosDetector.resetInstance());

  it('mission-complete stamps metadata.project_description onto BOTH the blob AND the Layer-0 row', async () => {
    const root = makeRoot();
    try {
      const dbPath = seedCmosDb(root, {
        projectName: 'CMOS-MCP Pro',
        projectId: 'cmos-mcp-pro',
        description: '', // Layer-0 row starts with an EMPTY description (the split-brain)
      });

      // Seed the canonical durability source + a sprint/mission to complete.
      const db = new Database(dbPath);
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        'project_description',
        OPEN_CORE_DESC
      );
      db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)').run(
        'sprint-x',
        'Sprint X',
        'Active'
      );
      db.prepare('INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, ?, ?)').run(
        'sx-m01',
        'sprint-x',
        'A mission',
        'In Progress'
      );
      db.close();
      CmosDetector.resetInstance();

      // Pre-condition: the Layer-0 row description is empty (split-brain reproduced).
      expect(readRowDescription(dbPath)).toBe('');

      const result = await cmosMissionComplete({ missionId: 'sx-m01', projectRoot: root });
      expect(result.success).toBe(true);

      // Convergence: BOTH projections now carry the description from the same seed.
      expect(readRowDescription(dbPath)).toBe(OPEN_CORE_DESC);
      expect(readBlobDescription(dbPath)).toBe(OPEN_CORE_DESC);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a subsequent mission-complete keeps blob and Layer-0 row converged', async () => {
    const root = makeRoot();
    try {
      const dbPath = seedCmosDb(root, { projectId: 'p', description: '' });
      const db = new Database(dbPath);
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        'project_description',
        OPEN_CORE_DESC
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
      db.prepare('INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, ?, ?)').run(
        'm2',
        's',
        'M2',
        'In Progress'
      );
      db.close();
      CmosDetector.resetInstance();

      await cmosMissionComplete({ missionId: 'm1', projectRoot: root });
      await cmosMissionComplete({ missionId: 'm2', projectRoot: root });

      expect(readRowDescription(dbPath)).toBe(OPEN_CORE_DESC);
      expect(readBlobDescription(dbPath)).toBe(OPEN_CORE_DESC);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('seed-precedence fix: a fresh project_identity row prefers metadata.project_description over an empty section', async () => {
    const root = makeRoot();
    try {
      const dbPath = seedCmosDb(root, { projectId: 'p', description: '' });
      const db = new Database(dbPath);
      // Delete the seeded row so ensureProjectIdentityRow re-seeds from scratch.
      db.prepare("DELETE FROM contexts WHERE id = 'project_identity'").run();
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
        'project_description',
        OPEN_CORE_DESC
      );
      // A description-less project_identity section in master_context (the old precedence
      // bug would seed THIS empty description, ignoring metadata).
      db.prepare(
        'INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
      ).run(
        'master_context',
        'master',
        JSON.stringify({ project_identity: { name: 'P', description: '' } }),
        new Date().toISOString()
      );
      db.close();
      CmosDetector.resetInstance();

      const clientResult = await CmosDatabaseClient.create({ dbPath });
      const client = clientResult.data!;
      ensureProjectIdentityRow(client);
      const identity = getProjectIdentity(client);
      client.close();

      expect(identity?.description).toBe(OPEN_CORE_DESC);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('seed-precedence fix: falls back to content.project.description when metadata is absent', async () => {
    const root = makeRoot();
    try {
      const dbPath = seedCmosDb(root, { projectId: 'p', description: '' });
      const db = new Database(dbPath);
      db.prepare("DELETE FROM contexts WHERE id = 'project_identity'").run();
      db.prepare("DELETE FROM metadata WHERE key = 'project_description'").run();
      // No metadata.project_description; a description-less project_identity section but a
      // NON-empty `project` section → the fix prefers the non-empty `project` description.
      db.prepare(
        'INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
      ).run(
        'master_context',
        'master',
        JSON.stringify({
          project_identity: { name: 'P', description: '' },
          project: { description: OPEN_CORE_DESC },
        }),
        new Date().toISOString()
      );
      db.close();
      CmosDetector.resetInstance();

      const clientResult = await CmosDatabaseClient.create({ dbPath });
      const client = clientResult.data!;
      ensureProjectIdentityRow(client);
      const identity = getProjectIdentity(client);
      client.close();

      expect(identity?.description).toBe(OPEN_CORE_DESC);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('grep-gate: the guard passes ONLY {description,status,project_name} to patchProjectIdentity (never cmos_address/objectives/foundational_docs — #682)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/tools/cmos/cmos-mission-complete.ts'),
      'utf8'
    );
    // Isolate the rowUpdates block feeding patchProjectIdentity in the guard.
    const m = src.match(
      /const rowUpdates: Partial<ProjectIdentityData> = \{\};([\s\S]*?)patchProjectIdentity\(client, rowUpdates\);/
    );
    expect(m).not.toBeNull();
    const block = m![1];
    const assignedKeys = [...block.matchAll(/rowUpdates\.(\w+)\s*=/g)].map((x) => x[1]).sort();
    expect(assignedKeys).toEqual(['description', 'project_name', 'status']);
    // Belt-and-suspenders: the forbidden identity keys must not appear in the block.
    for (const forbidden of [
      'cmos_address',
      'objectives',
      'foundational_docs',
      'related_projects',
    ]) {
      expect(block.includes(forbidden)).toBe(false);
    }
  });
});
