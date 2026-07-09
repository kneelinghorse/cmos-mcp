// ABOUTME: s79-m05 — cmos_mission(status)/cmos_learnings(list) acrossProjects handlers.
// ABOUTME: Verifies the graph-backed portfolio envelope, projectId attribution, per-store errors, and strict-schema landing.

/**
 * Sprint 79 m05 — `acrossProjects=true` on `cmos_mission` and `cmos_learnings`.
 *
 * Exercises the two new handlers through the injectable registry seam over a
 * synthetic multi-store fixture: active-missions (§5.4 query b) and
 * learnings-tagged-X (§5.4 query c). Asserts the metadata envelope is identical to
 * `cmos_decisions(acrossProjects)` (domain-named payload), rows carry `projectId`,
 * per-store failures surface on `errors[]` (never silently dropped), and the
 * `acrossProjects` param is accepted by BOTH the zod schema AND the JSON inputSchema.
 *
 * @module tests/tools/cmos/across-projects-handlers
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { missionStatusAcrossProjects } from '../../../src/tools/cmos/cmos-mission-status';
import { cmosLearningsListAcrossProjects } from '../../../src/tools/cmos/cmos-learnings-list';
import { cmosMissionSchema, cmosMissionToolDefinition } from '../../../src/tools/cmos/cmos-mission';
import {
  cmosLearningsSchema,
  cmosLearningsToolDefinition,
} from '../../../src/tools/cmos/cmos-learnings';

interface MissionSeed {
  id: string;
  name: string;
  status: string;
  occurred_at: number;
  origin_seq: number;
}
interface LearningSeed {
  id: number;
  content: string;
  category: string | null;
  occurred_at: number;
  origin_seq: number;
}

describe('acrossProjects handlers (Sprint 79 m05)', () => {
  let tmpDir: string;
  let configDir: string;
  let prevConfigEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm05-handlers-'));
    configDir = path.join(tmpDir, 'config');
    prevConfigEnv = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    ProjectGraphRegistry.resetInstance();
  });

  afterEach(() => {
    ProjectGraphRegistry.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.CMOS_CONFIG_DIR;
    else process.env.CMOS_CONFIG_DIR = prevConfigEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Seed a synthetic store carrying the firehose per-row columns. */
  function makeStore(
    projectId: string,
    seed: { missions?: MissionSeed[]; learnings?: LearningSeed[]; broken?: boolean } = {}
  ): string {
    const root = path.join(tmpDir, 'projects', projectId);
    const dbPath = path.join(root, 'cmos', 'db', 'cmos.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    if (seed.broken) {
      // An un-migrated/foreign store: the missions table lacks the cross-store
      // columns, so a portfolio query fails on it — must surface in errors[].
      db.exec('CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT);');
    } else {
      db.exec(`
        CREATE TABLE missions (
          id TEXT PRIMARY KEY, name TEXT, status TEXT,
          occurred_at INTEGER, origin_seq INTEGER, event_type TEXT, project_id TEXT
        );
        CREATE TABLE learnings (
          id INTEGER PRIMARY KEY, content TEXT, category TEXT,
          occurred_at INTEGER, origin_seq INTEGER, event_type TEXT, project_id TEXT
        );
      `);
      const insM = db.prepare(
        `INSERT INTO missions (id, name, status, occurred_at, origin_seq, event_type, project_id)
         VALUES (@id, @name, @status, @occurred_at, @origin_seq, 'mission_added', @project_id)`
      );
      for (const m of seed.missions ?? []) insM.run({ ...m, project_id: projectId });
      const insL = db.prepare(
        `INSERT INTO learnings (id, content, category, occurred_at, origin_seq, event_type, project_id)
         VALUES (@id, @content, @category, @occurred_at, @origin_seq, 'learning_captured', @project_id)`
      );
      for (const l of seed.learnings ?? []) insL.run({ ...l, project_id: projectId });
    }
    db.close();
    return root;
  }

  async function registryWith(roots: Array<{ projectId: string; root: string }>) {
    const reg = await ProjectGraphRegistry.create({ configDir });
    for (const { projectId, root } of roots) {
      reg.register({ project_id: projectId, store_path: root, name: projectId });
    }
    return reg;
  }

  // ── cmos_mission(status, acrossProjects) ────────────────────────────────────
  it('missionStatusAcrossProjects merges ACTIVE missions across stores with projectId + envelope', async () => {
    const a = makeStore('proj-a', {
      missions: [
        {
          id: 'a-ip',
          name: 'A in progress',
          status: 'In Progress',
          occurred_at: 100,
          origin_seq: 1,
        },
        { id: 'a-done', name: 'A done', status: 'Completed', occurred_at: 90, origin_seq: 2 },
      ],
    });
    const b = makeStore('proj-b', {
      missions: [
        { id: 'b-cur', name: 'B current', status: 'Current', occurred_at: 200, origin_seq: 1 },
      ],
    });
    const registry = await registryWith([
      { projectId: 'proj-a', root: a },
      { projectId: 'proj-b', root: b },
    ]);

    const result = await missionStatusAcrossProjects({ registry });
    expect(result.success).toBe(true);
    const data = result.data!;
    // Only active (In Progress/Current) — the Completed row is excluded.
    expect(data.missions.map((m) => m.id).sort()).toEqual(['a-ip', 'b-cur']);
    // Newest-first merge (b-cur occurred_at 200 before a-ip 100).
    expect(data.missions[0].id).toBe('b-cur');
    expect(data.missions.find((m) => m.id === 'a-ip')?.projectId).toBe('proj-a');
    // The metadata envelope mirrors cmos_decisions(acrossProjects).
    expect(data.acrossProjects).toBe(true);
    expect(data.errors).toEqual([]);
    expect(data.crossStoreMetadata.storesQueried).toBe(2);
    expect(data.crossStoreMetadata.storesFailed).toBe(0);
    expect(data.totalCount).toBe(2);
  });

  it('missionStatusAcrossProjects surfaces a per-store failure in errors[] (never silently partial)', async () => {
    const good = makeStore('good', {
      missions: [
        { id: 'g1', name: 'Good', status: 'In Progress', occurred_at: 100, origin_seq: 1 },
      ],
    });
    const bad = makeStore('bad', { broken: true });
    const registry = await registryWith([
      { projectId: 'good', root: good },
      { projectId: 'bad', root: bad },
    ]);

    const result = await missionStatusAcrossProjects({ registry });
    expect(result.success).toBe(true);
    const data = result.data!;
    expect(data.missions.map((m) => m.id)).toEqual(['g1']); // the good store's row survives
    expect(data.errors.length).toBe(1);
    expect(data.errors[0].projectId).toBe('bad');
    expect(data.crossStoreMetadata.storesFailed).toBe(1);
  });

  // ── cmos_learnings(list, acrossProjects) ────────────────────────────────────
  it('cmosLearningsListAcrossProjects returns learnings tagged the category across stores', async () => {
    const a = makeStore('proj-a', {
      learnings: [
        { id: 1, content: 'A technical', category: 'technical', occurred_at: 100, origin_seq: 1 },
        { id: 2, content: 'A process', category: 'process', occurred_at: 110, origin_seq: 2 },
      ],
    });
    const b = makeStore('proj-b', {
      learnings: [
        { id: 1, content: 'B technical', category: 'technical', occurred_at: 200, origin_seq: 1 },
      ],
    });
    const registry = await registryWith([
      { projectId: 'proj-a', root: a },
      { projectId: 'proj-b', root: b },
    ]);

    const result = await cmosLearningsListAcrossProjects({ category: 'technical', registry });
    expect(result.success).toBe(true);
    const data = result.data!;
    // Only the 'technical' rows, newest-first, each attributed.
    expect(data.learnings.map((l) => l.content)).toEqual(['B technical', 'A technical']);
    expect(data.learnings[0].projectId).toBe('proj-b');
    expect(data.acrossProjects).toBe(true);
    expect(data.errors).toEqual([]);
    expect(data.crossStoreMetadata!.storesQueried).toBe(2);
  });

  it('cmosLearningsListAcrossProjects requires category (the tag)', async () => {
    const registry = await registryWith([]);
    const result = await cmosLearningsListAcrossProjects({ registry });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });

  // ── strict-schema landing on BOTH surfaces (critic fix) ─────────────────────
  it('acrossProjects is accepted by BOTH the zod schema AND the JSON inputSchema (mission + learnings)', () => {
    // Zod .strict() — rejects unknown keys, so this proves the key is declared.
    expect(cmosMissionSchema.safeParse({ action: 'status', acrossProjects: true }).success).toBe(
      true
    );
    expect(
      cmosLearningsSchema.safeParse({ action: 'list', acrossProjects: true, category: 'technical' })
        .success
    ).toBe(true);
    // JSON inputSchema (additionalProperties:false at the MCP boundary).
    expect(
      (cmosMissionToolDefinition.inputSchema.properties as Record<string, unknown>).acrossProjects
    ).toBeDefined();
    expect(
      (cmosLearningsToolDefinition.inputSchema.properties as Record<string, unknown>).acrossProjects
    ).toBeDefined();
  });
});
