/**
 * Sprint 69 m05 — project-graph registry tests.
 *
 * Covers the per-user SQLite registry (project_id → store metadata): the
 * register/get/unregister/list/touch/archive/unarchive API, the one-time backfill
 * from the existing ProjectRegistry + store metadata, concurrent-write safety
 * (WAL + busy_timeout), graceful first-run behavior, idempotent schema re-ensure,
 * and the cmos_project(register) + cmos_review integration touchpoints.
 *
 * @module tests/intelligence/project-graph-registry
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ProjectGraphRegistry,
  readStoreIdentity,
  PROJECT_GRAPH_SCHEMA_VERSION,
} from '../../src/intelligence/project-graph-registry';
import { ProjectRegistry } from '../../src/intelligence/project-registry';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { seedCmosDb } from '../helpers/seedCmosDb';
import { cmosProjectRegister } from '../../src/tools/cmos/cmos-project-register';
import { cmosReview } from '../../src/tools/cmos/cmos-review';

describe('ProjectGraphRegistry (Sprint 69 m05)', () => {
  let tmpDir: string;
  let configDir: string;
  let prevConfigEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-test-'));
    configDir = path.join(tmpDir, 'config');
    // Point BOTH registries (and the integration handlers) at an isolated config
    // dir so the JSON ProjectRegistry and the SQLite project-graph registry
    // resolve the same location and don't touch the developer's real registries.
    prevConfigEnv = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    ProjectGraphRegistry.resetInstance();
    ProjectRegistry.resetInstance();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    ProjectGraphRegistry.resetInstance();
    ProjectRegistry.resetInstance();
    CmosDetector.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.CMOS_CONFIG_DIR;
    else process.env.CMOS_CONFIG_DIR = prevConfigEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Seed a real CMOS store under tmpDir/projects/<name> with a known project_id. */
  function makeStore(name: string, projectId: string): string {
    const root = path.join(tmpDir, 'projects', name);
    seedCmosDb(root, { projectId, projectName: name });
    return root;
  }

  // ── (a) register / unregister / get ─────────────────────────────────────────
  it('register inserts a row, get reads it back, unregister removes it', async () => {
    const reg = await ProjectGraphRegistry.create({ now: () => 1000 });
    const entry = reg.register({ project_id: 'p1', store_path: '/tmp/p1', name: 'Proj One' });
    expect(entry.project_id).toBe('p1');
    expect(entry.name).toBe('Proj One');
    expect(entry.registered_at).toBe(1000);
    expect(entry.last_seen_at).toBe(1000);
    expect(entry.archived_at).toBeNull();
    expect(entry.schema_version).toBe(PROJECT_GRAPH_SCHEMA_VERSION);

    expect(reg.get('p1')?.name).toBe('Proj One');
    expect(reg.get('absent')).toBeUndefined();

    expect(reg.unregister('p1')).toBe(true);
    expect(reg.get('p1')).toBeUndefined();
    expect(reg.unregister('p1')).toBe(false); // already gone
  });

  it('register upserts: a second register updates store_path/name + last_seen_at, keeps registered_at', async () => {
    let clock = 1000;
    const reg = await ProjectGraphRegistry.create({ now: () => clock });
    reg.register({ project_id: 'p1', store_path: '/tmp/old', name: 'Old' });
    clock = 2000;
    const updated = reg.register({ project_id: 'p1', store_path: '/tmp/new', name: 'New' });
    expect(updated.registered_at).toBe(1000); // preserved
    expect(updated.last_seen_at).toBe(2000); // refreshed
    expect(updated.store_path).toBe('/tmp/new');
    expect(updated.name).toBe('New');
    expect(reg.list()).toHaveLength(1); // still one row
  });

  // ── (b) list with and without archived ──────────────────────────────────────
  it('list hides archived rows by default and includes them when asked, newest-first', async () => {
    let clock = 1000;
    const reg = await ProjectGraphRegistry.create({ now: () => clock });
    reg.register({ project_id: 'a', store_path: '/a', name: 'A' });
    clock = 1100;
    reg.register({ project_id: 'b', store_path: '/b', name: 'B' });
    clock = 1200;
    reg.register({ project_id: 'c', store_path: '/c', name: 'C' });
    reg.archive('b');

    const active = reg.list();
    expect(active.map((p) => p.project_id)).toEqual(['c', 'a']); // last_seen_at DESC, b hidden
    const all = reg.list({ includeArchived: true });
    expect(all.map((p) => p.project_id).sort()).toEqual(['a', 'b', 'c']);
  });

  // ── (e) archive / unarchive ─────────────────────────────────────────────────
  it('archive soft-deletes, unarchive restores, with correct return values', async () => {
    let clock = 1000;
    const reg = await ProjectGraphRegistry.create({ now: () => clock });
    reg.register({ project_id: 'p1', store_path: '/p1', name: 'P1' });

    clock = 1500;
    expect(reg.archive('p1')).toBe(true);
    expect(reg.get('p1')?.archived_at).toBe(1500);
    expect(reg.archive('p1')).toBe(false); // already archived
    expect(reg.archive('absent')).toBe(false);

    expect(reg.unarchive('p1')).toBe(true);
    expect(reg.get('p1')?.archived_at).toBeNull();
    expect(reg.unarchive('p1')).toBe(false); // already active

    // re-registering an archived project also clears archived_at
    reg.archive('p1');
    reg.register({ project_id: 'p1', store_path: '/p1', name: 'P1' });
    expect(reg.get('p1')?.archived_at).toBeNull();
  });

  // ── touch ───────────────────────────────────────────────────────────────────
  it('touch updates last_seen_at and returns false for an unknown project', async () => {
    let clock = 1000;
    const reg = await ProjectGraphRegistry.create({ now: () => clock });
    reg.register({ project_id: 'p1', store_path: '/p1', name: 'P1' });
    clock = 9999;
    expect(reg.touch('p1')).toBe(true);
    expect(reg.get('p1')?.last_seen_at).toBe(9999);
    expect(reg.touch('nope')).toBe(false);
  });

  // ── (f) registry-not-found graceful handling on first run ───────────────────
  it('first run on an absent registry creates it cleanly and reads empty', async () => {
    const registryPath = path.join(configDir, 'project-graph.sqlite');
    expect(fs.existsSync(registryPath)).toBe(false);

    const reg = await ProjectGraphRegistry.create();
    expect(fs.existsSync(registryPath)).toBe(true);
    expect(reg.list()).toEqual([]);
    expect(reg.get('anything')).toBeUndefined();
    expect(reg.touch('anything')).toBe(false);
  });

  // ── (i) idempotent schema (the registry's own schema migration) ─────────────
  it('re-opening an existing registry re-ensures the schema idempotently and preserves data', async () => {
    const reg1 = await ProjectGraphRegistry.create({ now: () => 1000 });
    reg1.register({ project_id: 'keep', store_path: '/keep', name: 'Keep' });
    ProjectGraphRegistry.resetInstance(); // closes the connection (simulates a new process)

    const reg2 = await ProjectGraphRegistry.create();
    // Data survived + schema is intact (columns present, version stamped).
    const row = reg2.get('keep');
    expect(row?.name).toBe('Keep');
    expect(row?.schema_version).toBe(PROJECT_GRAPH_SCHEMA_VERSION);
    const cols = (
      new Database(reg2.path).prepare("PRAGMA table_info('projects')").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'project_id',
        'store_path',
        'name',
        'registered_at',
        'last_seen_at',
        'schema_version',
        'archived_at',
      ])
    );
  });

  // ── readStoreIdentity ───────────────────────────────────────────────────────
  it('readStoreIdentity reads project_id + name, and returns null for absent/idless stores', () => {
    const root = makeStore('alpha', 'alpha-id');
    expect(readStoreIdentity(root)).toEqual({ project_id: 'alpha-id', name: 'alpha' });
    expect(readStoreIdentity(path.join(tmpDir, 'does-not-exist'))).toBeNull();

    // A store whose metadata.project_id is empty → null (nothing to key on).
    const idless = path.join(tmpDir, 'projects', 'idless');
    seedCmosDb(idless, { projectId: '', projectName: 'idless' });
    expect(readStoreIdentity(idless)).toBeNull();
  });

  // ── (c) one-time backfill from ProjectRegistry + store metadata ─────────────
  it('backfills from the existing ProjectRegistry on first run, then does not re-scan', async () => {
    // Two known projects in the JSON ProjectRegistry, each a real store.
    const rootA = makeStore('proj-a', 'proj-a-id');
    const rootB = makeStore('proj-b', 'proj-b-id');
    const jsonReg = await ProjectRegistry.create();
    await jsonReg.register(rootA);
    await jsonReg.register(rootB);

    // First create() of the project-graph registry backfills both.
    const reg = await ProjectGraphRegistry.create();
    const ids = reg
      .list()
      .map((p) => p.project_id)
      .sort();
    expect(ids).toEqual(['proj-a-id', 'proj-b-id']);
    expect(reg.get('proj-a-id')?.store_path).toBe(rootA);

    // A THIRD project registered in the JSON registry after backfill is NOT
    // re-scanned on the next create() (marker-gated one-time backfill).
    const rootC = makeStore('proj-c', 'proj-c-id');
    await jsonReg.register(rootC);
    ProjectGraphRegistry.resetInstance();
    const reg2 = await ProjectGraphRegistry.create();
    expect(reg2.get('proj-c-id')).toBeUndefined(); // backfill did not re-run
    expect(reg2.list()).toHaveLength(2);
  });

  // ── (d) concurrent touch from N simulated processes ─────────────────────────
  it('survives concurrent touches from N connections with no corruption or lost writes', async () => {
    const reg = await ProjectGraphRegistry.create();
    reg.register({ project_id: 'hot', store_path: '/hot', name: 'Hot' });
    const registryPath = reg.path;

    // Simulate N sibling MCP-server processes: N independent connections to the
    // same file, each WAL + busy_timeout, each issuing a touch UPDATE. With WAL +
    // busy_timeout the writes serialize without SQLITE_BUSY; each must apply.
    const N = 12;
    const connections: Database.Database[] = [];
    try {
      for (let i = 0; i < N; i++) {
        const db = new Database(registryPath);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
        connections.push(db);
      }
      let appliedChanges = 0;
      connections.forEach((db, i) => {
        const info = db
          .prepare('UPDATE projects SET last_seen_at = ? WHERE project_id = ?')
          .run(2000 + i, 'hot');
        appliedChanges += info.changes;
      });
      expect(appliedChanges).toBe(N); // every touch applied — no lost updates

      // No corruption: integrity intact, still exactly one row, last write wins.
      const check = connections[0].pragma('integrity_check', { simple: true });
      expect(check).toBe('ok');
      const count = (
        connections[0].prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }
      ).c;
      expect(count).toBe(1);
      const row = connections[0]
        .prepare('SELECT last_seen_at FROM projects WHERE project_id = ?')
        .get('hot') as { last_seen_at: number };
      expect(row.last_seen_at).toBe(2000 + (N - 1));
    } finally {
      connections.forEach((db) => db.close());
    }
  });

  // ── (g) integration with cmos_project(action='register') ────────────────────
  it('cmos_project register mirrors the project into the project-graph registry', async () => {
    const root = makeStore('regd', 'regd-id');
    const result = await cmosProjectRegister({ projectRoot: root });
    expect(result.success).toBe(true);

    const reg = await ProjectGraphRegistry.create();
    const entry = reg.get('regd-id');
    expect(entry).toBeDefined();
    expect(entry?.store_path).toBe(root);
    expect(entry?.name).toBe('regd');
  });

  // ── (h) integration with cmos_review (last_seen_at touched at session start) ─
  it('cmos_review touches/auto-registers the current project in the project-graph registry', async () => {
    const root = makeStore('reviewed', 'reviewed-id');

    // Project not yet in the graph registry — review must auto-register it.
    const review1 = await cmosReview({ projectRoot: root });
    expect(review1.success).toBe(true);
    const reg = await ProjectGraphRegistry.create();
    const first = reg.get('reviewed-id');
    expect(first).toBeDefined();
    const firstSeen = first!.last_seen_at;

    // A second review bumps last_seen_at (touch), without adding a duplicate row.
    await new Promise((r) => setTimeout(r, 5));
    ProjectGraphRegistry.resetInstance();
    await cmosReview({ projectRoot: root });
    const reg2 = await ProjectGraphRegistry.create();
    expect(reg2.list()).toHaveLength(1);
    expect(reg2.get('reviewed-id')!.last_seen_at).toBeGreaterThanOrEqual(firstSeen);
  });

  // ── regression: explicit configDir is honored ON THE BACKFILL PATH ──────────
  // (workflow-found) The other tests isolate ONLY via CMOS_CONFIG_DIR. With the
  // env var UNSET and isolation via the explicit `configDir` option, the backfill
  // must read the JSON ProjectRegistry from that SAME dir — not ~/.config — or it
  // would ingest unrelated projects into a supposedly-isolated registry.
  it('honors an explicit configDir option on the backfill path (CMOS_CONFIG_DIR unset)', async () => {
    const savedEnv = process.env.CMOS_CONFIG_DIR;
    delete process.env.CMOS_CONFIG_DIR;
    ProjectRegistry.resetInstance();
    ProjectGraphRegistry.resetInstance();
    try {
      const isoConfig = path.join(tmpDir, 'iso-config');
      const root = makeStore('iso', 'iso-id');

      // Seed a JSON ProjectRegistry in the isolated dir with the one store.
      const jsonReg = await ProjectRegistry.create({ configDir: isoConfig });
      await jsonReg.register(root);
      ProjectRegistry.resetInstance();
      ProjectGraphRegistry.resetInstance();

      // The graph registry's backfill must read the SAME isolated dir.
      const reg = await ProjectGraphRegistry.create({ configDir: isoConfig });
      const entry = reg.get('iso-id');
      expect(entry).toBeDefined();
      expect(entry?.store_path).toBe(root);
      // registryFilename override (untested elsewhere) lands at the expected path.
      ProjectGraphRegistry.resetInstance();
      const named = await ProjectGraphRegistry.create({
        configDir: isoConfig,
        registryFilename: 'custom-graph.sqlite',
      });
      expect(named.path).toBe(path.join(isoConfig, 'custom-graph.sqlite'));
    } finally {
      if (savedEnv === undefined) delete process.env.CMOS_CONFIG_DIR;
      else process.env.CMOS_CONFIG_DIR = savedEnv;
      ProjectRegistry.resetInstance();
      ProjectGraphRegistry.resetInstance();
    }
  });
});
