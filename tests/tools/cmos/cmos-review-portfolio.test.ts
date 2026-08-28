// ABOUTME: s79-m06 — the always-on cross-store portfolio section on cmos_review.
// ABOUTME: Drives the real cmosReview handler through the injectable registry seam; asserts reconciliation, degrade, and the ≤4KB budget.

/**
 * Sprint 79 m06 — cmos_review portfolio rollup.
 *
 * Uses the internal (non-schema) `registry` seam to feed a deterministic
 * multi-store graph registry into the real `cmosReview` handler (which also reads
 * a real local store for onboard/mission-status). Asserts: the s80-m06 strict
 * partition reconciles (`reachable + silent + unmigrated + unreadable === projects`),
 * rows carry `projectId`, the digest stays ≤ 4096 bytes, and the section degrades to
 * `null` for a single-project registry or when the fan-out throws.
 *
 * @module tests/tools/cmos/cmos-review-portfolio
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import { cmosReview } from '../../../src/tools/cmos/cmos-review';

describe('cmos_review portfolio section (Sprint 79 m06)', () => {
  let tmpDir: string;
  let configDir: string;
  let localRoot: string;
  let prevConfigEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm06-review-'));
    configDir = path.join(tmpDir, 'config');
    prevConfigEnv = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    // A real local CMOS store so onboard/mission-status succeed.
    localRoot = path.join(tmpDir, 'local');
    seedCmosDb(localRoot, { projectId: 'local-proj', projectName: 'Local' });
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
  });

  afterEach(() => {
    ProjectGraphRegistry.resetInstance();
    CmosDetector.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.CMOS_CONFIG_DIR;
    else process.env.CMOS_CONFIG_DIR = prevConfigEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Seed a synthetic cross-store fixture carrying firehose-shaped missions. */
  function makePortfolioStore(
    projectId: string,
    missions: Array<{ id: string; name: string; status: string; occurred_at: number }>,
    { broken = false } = {}
  ): string {
    const root = path.join(tmpDir, 'projects', projectId);
    const dbPath = path.join(root, 'cmos', 'db', 'cmos.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    if (broken) {
      db.exec('CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT);');
    } else {
      db.exec(
        `CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT, status TEXT,
           occurred_at INTEGER, origin_seq INTEGER, event_type TEXT, project_id TEXT);`
      );
      const ins = db.prepare(
        `INSERT INTO missions (id, name, status, occurred_at, origin_seq, event_type, project_id)
         VALUES (?,?,?,?,?, 'mission_added', ?)`
      );
      missions.forEach((m, i) => ins.run(m.id, m.name, m.status, m.occurred_at, i + 1, projectId));
    }
    db.close();
    return root;
  }

  /**
   * s87-m03 — REALISTIC `occurred_at` STAMPS, and the reason is a finding about this fixture.
   *
   * These missions used to carry `occurred_at: 100` / `200` — chosen as MERGE-ORDER KEYS, with no
   * intent that they be dates. They are Unix milliseconds, so they meant 1970, and nothing read
   * them as time until the drift signal became content-derived; then every store in this fixture
   * classified as 56 years silent. Production `occurred_at` is a real `Date.now()` stamp, so the
   * fixture was the thing that was unrealistic. The offsets below preserve the exact relative
   * ordering the k-way merge assertions depend on (b-cur newest, then a-ip, then a-done) while
   * being actual recent timestamps.
   */
  const STAMP_BASE = Date.now();
  const stamp = (rank: number): number => STAMP_BASE - (1000 - rank);

  async function registryWith(entries: Array<{ projectId: string; root: string }>) {
    const reg = await ProjectGraphRegistry.create({ configDir });
    for (const e of entries)
      reg.register({ project_id: e.projectId, store_path: e.root, name: e.projectId });
    return reg;
  }

  it('builds an always-on portfolio: reconciled counts, projectId attribution, ≤4KB', async () => {
    const a = makePortfolioStore('proj-a', [
      { id: 'a-ip', name: 'A active', status: 'In Progress', occurred_at: stamp(100) },
      { id: 'a-done', name: 'A done', status: 'Completed', occurred_at: stamp(90) },
    ]);
    const b = makePortfolioStore('proj-b', [
      { id: 'b-cur', name: 'B current', status: 'Current', occurred_at: stamp(200) },
    ]);
    const bad = makePortfolioStore('proj-bad', [], { broken: true });
    const registry = await registryWith([
      { projectId: 'proj-a', root: a },
      { projectId: 'proj-b', root: b },
      { projectId: 'proj-bad', root: bad },
    ]);

    const result = await cmosReview({ projectRoot: localRoot }, { registry });
    expect(result.success).toBe(true);
    const p = result.data!.portfolio;
    expect(p).not.toBeNull();
    // s80-m06 strict partition: reachable + silent + unmigrated + unreadable === projects.
    expect(p!.reachable + p!.silent + p!.unmigrated + p!.unreadable).toBe(p!.projects);
    expect(p!.projects).toBe(3);
    // proj-a + proj-b succeed and are freshly written → reachable; proj-bad's missions
    // table lacks the per-row columns → "no such column" → un-migrated.
    expect(p!.reachable).toBe(2);
    expect(p!.silent).toBe(0);
    expect(p!.unmigrated).toBe(1);
    expect(p!.unreadable).toBe(0);
    // Drift lists the un-migrated store with a backfill hint.
    expect(p!.drift).not.toBeNull();
    const badDrift = p!.drift!.stale.find((s) => s.projectId === 'proj-bad');
    expect(badDrift).toBeDefined();
    expect(badDrift!.hint).toMatch(/backfill/i);
    // Only active missions, each attributed to its source project.
    expect(p!.activeMissions.count).toBe(2);
    expect(p!.activeMissions.top.map((m) => m.id).sort()).toEqual(['a-ip', 'b-cur']);
    expect(p!.activeMissions.top.find((m) => m.id === 'a-ip')?.projectId).toBe('proj-a');
    expect(typeof p!.fanInP95Ms).toBe('number');
    // The whole digest still fits the 4KB budget with the section present.
    expect(result.data!.digestSizeBytes).toBeLessThanOrEqual(4096);
  });

  it('degrades to portfolio=null on a single-project registry', async () => {
    const only = makePortfolioStore('solo', [
      { id: 's-ip', name: 'solo active', status: 'In Progress', occurred_at: stamp(100) },
    ]);
    const registry = await registryWith([{ projectId: 'solo', root: only }]);

    const result = await cmosReview({ projectRoot: localRoot }, { registry });
    expect(result.success).toBe(true);
    expect(result.data!.portfolio).toBeNull();
  });

  it('degrades to portfolio=null (and never throws) when the fan-out throws', async () => {
    const throwingRegistry = {
      list: () => {
        throw new Error('boom');
      },
    } as unknown as ProjectGraphRegistry;

    const result = await cmosReview({ projectRoot: localRoot }, { registry: throwingRegistry });
    expect(result.success).toBe(true);
    expect(result.data!.portfolio).toBeNull();
  });
});
