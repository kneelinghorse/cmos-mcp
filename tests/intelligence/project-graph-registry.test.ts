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
  mintProjectId,
  PROJECT_GRAPH_SCHEMA_VERSION,
} from '../../src/intelligence/project-graph-registry';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { resolveProjectRootEnhanced } from '../../src/intelligence/project-resolution';
import { seedCmosDb } from '../helpers/seedCmosDb';
import { cmosProjectRegister } from '../../src/tools/cmos/cmos-project-register';
import { cmosReview } from '../../src/tools/cmos/cmos-review';
import { captureToolCall } from '../../src/tools/cmos/tool-call-context';

describe('ProjectGraphRegistry (Sprint 69 m05)', () => {
  let tmpDir: string;
  let configDir: string;
  let prevConfigEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-test-'));
    configDir = path.join(tmpDir, 'config');
    // Point the graph registry (and the integration handlers) at an isolated config
    // dir so it doesn't touch the developer's real registry. (s80-m02: the JSON
    // ProjectRegistry is deleted; the graph reads the legacy JSON only via
    // readLegacyJsonRegistry, which the backfill tests seed directly on disk.)
    prevConfigEnv = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    ProjectGraphRegistry.resetInstance();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    ProjectGraphRegistry.resetInstance();
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

  /**
   * Write a legacy `project-registry.json` directly into `dir` so the graph's
   * one-time backfill (via `readLegacyJsonRegistry`) can migrate pre-s80 operators.
   * Replaces the deleted JSON `ProjectRegistry.register`/`setDefault` seeding.
   */
  function seedLegacyJson(
    dir: string,
    entries: Array<{ projectRoot: string; name?: string }>,
    defaultProject?: string
  ): void {
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const projects: Record<string, unknown> = {};
    for (const e of entries) {
      const resolved = path.resolve(e.projectRoot);
      projects[resolved] = {
        projectRoot: resolved,
        name: e.name ?? path.basename(resolved),
        registeredAt: now,
        lastAccessedAt: now,
      };
    }
    const file = {
      version: 1,
      defaultProject: defaultProject ? path.resolve(defaultProject) : undefined,
      projects,
      updatedAt: now,
    };
    fs.writeFileSync(path.join(dir, 'project-registry.json'), JSON.stringify(file, null, 2));
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

  it('treats filesystem aliases of one live store as one registration', async () => {
    const root = makeStore('alias-target', 'alias-project-id');
    const alias = path.join(tmpDir, 'alias-link');
    fs.symlinkSync(root, alias, 'dir');
    const reg = await ProjectGraphRegistry.create();

    reg.registerStore(root, { requireStoredIdentity: true });
    const throughAlias = reg.registerStore(alias, { requireStoredIdentity: true });

    expect(throughAlias.project_id).toBe('alias-project-id');
    expect(throughAlias.store_path).toBe(path.resolve(alias));
    expect(reg.getByStorePath(root)).toBe('alias-project-id');
    expect(reg.getByStorePath(alias)).toBe('alias-project-id');
    expect(reg.list()).toHaveLength(1);
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

  // ── s81-m03: last_synced_at column + writer + v1→v2 migration ────────────────
  it('updateLastSynced writes last_synced_at (visible via get + list), returns false for an unknown project', async () => {
    const reg = await ProjectGraphRegistry.create({ now: () => 1000 });
    reg.register({ project_id: 'p1', store_path: '/p1', name: 'P1' });

    // Fresh row starts with a null last_synced_at.
    expect(reg.get('p1')?.last_synced_at ?? null).toBeNull();

    expect(reg.updateLastSynced('p1', 5_555)).toBe(true);
    expect(reg.get('p1')?.last_synced_at).toBe(5_555);
    // The value flows through list() (what deriveDrift consumes).
    expect(reg.list().find((r) => r.project_id === 'p1')?.last_synced_at).toBe(5_555);

    expect(reg.updateLastSynced('nope', 1)).toBe(false); // no row on this machine → no-op
  });

  it('v1→v2 migration: adds last_synced_at to a pre-existing v1 registry, idempotently, preserving rows', async () => {
    const registryPath = path.join(configDir, 'project-graph.sqlite');
    fs.mkdirSync(configDir, { recursive: true });
    // Hand-build a v1-shaped registry (NO last_synced_at column), as a 2.1.0 dist wrote.
    const v1 = new Database(registryPath);
    v1.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY, store_path TEXT NOT NULL, name TEXT NOT NULL,
        registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1, archived_at INTEGER
      );
      CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO projects (project_id, store_path, name, registered_at, last_seen_at, schema_version, archived_at)
      VALUES ('legacy', '/legacy', 'Legacy', 100, 100, 1, NULL);
    `);
    v1.close();

    // Opening through create() runs ensureSchema → ensureLastSyncedColumn (the ALTER).
    const reg = await ProjectGraphRegistry.create();
    const cols = (
      new Database(registryPath).pragma('table_info(projects)') as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('last_synced_at');

    // The pre-existing row survives and its new column reads null (no-signal).
    const legacy = reg.get('legacy');
    expect(legacy?.name).toBe('Legacy');
    expect(legacy?.last_synced_at ?? null).toBeNull();
    // The writer works on the migrated table.
    expect(reg.updateLastSynced('legacy', 7_777)).toBe(true);
    expect(reg.get('legacy')?.last_synced_at).toBe(7_777);

    // Re-opening is idempotent (the guarded ALTER no-ops; the row + value persist).
    ProjectGraphRegistry.resetInstance();
    const reg2 = await ProjectGraphRegistry.create();
    expect(reg2.get('legacy')?.last_synced_at).toBe(7_777);
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
  it('backfills from the legacy project-registry.json on first run, then does not re-scan', async () => {
    // Two known projects in the legacy JSON registry, each a real store.
    const rootA = makeStore('proj-a', 'proj-a-id');
    const rootB = makeStore('proj-b', 'proj-b-id');
    seedLegacyJson(configDir, [{ projectRoot: rootA }, { projectRoot: rootB }]);

    // First create() of the project-graph registry backfills both.
    const reg = await ProjectGraphRegistry.create();
    const ids = reg
      .list()
      .map((p) => p.project_id)
      .sort();
    expect(ids).toEqual(['proj-a-id', 'proj-b-id']);
    expect(reg.get('proj-a-id')?.store_path).toBe(rootA);

    // A THIRD project added to the legacy JSON after backfill is NOT re-scanned on
    // the next create() (marker-gated one-time backfill).
    const rootC = makeStore('proj-c', 'proj-c-id');
    seedLegacyJson(configDir, [
      { projectRoot: rootA },
      { projectRoot: rootB },
      { projectRoot: rootC },
    ]);
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

  it('cmos_project register mints and reports repair for a real identity-less SQLite store', async () => {
    const root = path.join(tmpDir, 'projects', 'registration-repair');
    seedCmosDb(root, { projectId: '', projectName: 'registration-repair' });

    const result = await cmosProjectRegister({ projectRoot: root });

    expect(result.success).toBe(true);
    expect(result.data?.metadataRepaired).toBe(true);
    const identity = readStoreIdentity(root);
    expect(identity?.project_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    const reg = await ProjectGraphRegistry.create();
    expect(reg.getByStorePath(root)).toBe(identity?.project_id);
  });

  // ── (h) integration with cmos_review (existing last_seen_at touched) ─────────
  it('cmos_review touches an existing graph row but never registers an absent one', async () => {
    const root = makeStore('reviewed', 'reviewed-id');

    // A read-classified opener must not create discovery state, even when the
    // project store already carries a durable identity.
    const review1 = (await captureToolCall('read', () => cmosReview({ projectRoot: root }))).value;
    expect(review1.success).toBe(true);
    const reg = await ProjectGraphRegistry.create();
    expect(reg.get('reviewed-id')).toBeUndefined();

    // Once an explicit registration exists, review may update its bookkeeping.
    reg.register({
      project_id: 'reviewed-id',
      store_path: root,
      name: 'reviewed',
    });
    const raw = new Database(reg.path);
    raw.prepare('UPDATE projects SET last_seen_at = ? WHERE project_id = ?').run(1, 'reviewed-id');
    raw.close();

    // A second review strictly bumps last_seen_at (touch), without adding a duplicate row.
    // The deterministic old timestamp makes deletion/no-op of the touch fail this test.
    ProjectGraphRegistry.resetInstance();
    await captureToolCall('read', () => cmosReview({ projectRoot: root }));
    const reg2 = await ProjectGraphRegistry.create();
    expect(reg2.list()).toHaveLength(1);
    expect(reg2.get('reviewed-id')!.last_seen_at).toBeGreaterThan(1);
  });

  // ── regression: explicit configDir is honored ON THE BACKFILL PATH ──────────
  // (workflow-found) The other tests isolate ONLY via CMOS_CONFIG_DIR. With the
  // env var UNSET and isolation via the explicit `configDir` option, the backfill
  // must read the legacy JSON from that SAME dir — not ~/.config — or it would
  // ingest unrelated projects into a supposedly-isolated registry.
  it('honors an explicit configDir option on the backfill path (CMOS_CONFIG_DIR unset)', async () => {
    const savedEnv = process.env.CMOS_CONFIG_DIR;
    delete process.env.CMOS_CONFIG_DIR;
    ProjectGraphRegistry.resetInstance();
    try {
      const isoConfig = path.join(tmpDir, 'iso-config');
      const root = makeStore('iso', 'iso-id');

      // Seed a legacy project-registry.json in the isolated dir with the one store.
      seedLegacyJson(isoConfig, [{ projectRoot: root }]);
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
      ProjectGraphRegistry.resetInstance();
    }
  });

  // ── Sprint 79 m01 — authority affordances ───────────────────────────────────
  describe('authority affordances (Sprint 79 m01)', () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    // ── mintProjectId ─────────────────────────────────────────────────────────
    it('mintProjectId mints a UUID into an id-less store, and never churns an existing id', () => {
      // id-less store → a UUID is minted into metadata.project_id and returned.
      const idless = path.join(tmpDir, 'projects', 'noid');
      seedCmosDb(idless, { projectId: '', projectName: 'noid' });
      expect(readStoreIdentity(idless)).toBeNull(); // no id to key on yet
      const minted = mintProjectId(idless);
      expect(minted).toMatch(UUID_RE);
      // Persisted: a re-read now resolves the freshly-minted id.
      expect(readStoreIdentity(idless)?.project_id).toBe(minted);

      // A store that already has an id (slug OR uuid) is returned untouched.
      const withSlug = makeStore('keepme', 'keepme'); // slug id
      expect(mintProjectId(withSlug)).toBe('keepme');
      expect(readStoreIdentity(withSlug)?.project_id).toBe('keepme');

      // Absent store → null (nothing to mint into).
      expect(mintProjectId(path.join(tmpDir, 'does-not-exist'))).toBeNull();
    });

    // ── getByStorePath ────────────────────────────────────────────────────────
    it('getByStorePath resolves a store path to its project_id (path-insensitive to trailing slash)', async () => {
      const reg = await ProjectGraphRegistry.create();
      reg.register({ project_id: 'p1', store_path: '/tmp/proj-one', name: 'One' });
      expect(reg.getByStorePath('/tmp/proj-one')).toBe('p1');
      expect(reg.getByStorePath('/tmp/proj-one/')).toBe('p1'); // resolved before lookup
      expect(reg.getByStorePath('/tmp/nope')).toBeNull();
    });

    // ── default project (registry_meta) ─────────────────────────────────────────
    it('setDefault requires a registered project; getDefault resolves it; clearDefault removes it', async () => {
      const reg = await ProjectGraphRegistry.create();
      expect(reg.getDefault()).toBeNull();
      // setDefault on an unknown id is refused.
      expect(reg.setDefault('ghost')).toBe(false);
      expect(reg.getDefault()).toBeNull();

      reg.register({ project_id: 'p1', store_path: '/tmp/p1', name: 'P1' });
      expect(reg.setDefault('p1')).toBe(true);
      expect(reg.getDefault()?.project_id).toBe('p1');
      expect(reg.getDefault()?.store_path).toBe('/tmp/p1');

      // The default survives a reopen (persisted in registry_meta, not memory).
      ProjectGraphRegistry.resetInstance();
      const reg2 = await ProjectGraphRegistry.create();
      expect(reg2.getDefault()?.project_id).toBe('p1');

      reg2.clearDefault();
      expect(reg2.getDefault()).toBeNull();
    });

    // ── collision guard ─────────────────────────────────────────────────────────
    it('collision guard refuses to clobber a LIVE incumbent, but updates a moved or re-touched store', async () => {
      const reg = await ProjectGraphRegistry.create();
      const rootA = path.join(tmpDir, 'stores', 'a');
      const rootB = path.join(tmpDir, 'stores', 'b');
      const rootC = path.join(tmpDir, 'stores', 'c');
      // Two DIFFERENT live stores that (wrongly) both hold 'dup-id'.
      seedCmosDb(rootA, { projectId: 'dup-id', projectName: 'A' });
      seedCmosDb(rootB, { projectId: 'dup-id', projectName: 'B' });

      reg.register({ project_id: 'dup-id', store_path: rootA, name: 'A' });
      // B claims 'dup-id' while A is still a live store holding it → REFUSED.
      const refused = reg.register({ project_id: 'dup-id', store_path: rootB, name: 'B' });
      expect(refused.store_path).toBe(path.resolve(rootA)); // incumbent unchanged
      expect(reg.get('dup-id')?.store_path).toBe(path.resolve(rootA));

      // Same-path re-touch legitimately updates (name + last_seen), no refusal.
      const retouched = reg.register({
        project_id: 'dup-id',
        store_path: rootA,
        name: 'A-renamed',
      });
      expect(retouched.name).toBe('A-renamed');

      // A MOVED store: the incumbent path no longer resolves 'dup-id' (store gone),
      // so a new path legitimately takes over the id.
      fs.rmSync(rootA, { recursive: true, force: true });
      seedCmosDb(rootC, { projectId: 'dup-id', projectName: 'C' });
      const moved = reg.register({ project_id: 'dup-id', store_path: rootC, name: 'C' });
      expect(moved.store_path).toBe(path.resolve(rootC)); // moved store wins
    });

    // ── identity backfill (separate marker) migrates recorded ids + the default ─
    it('identity backfill skips id-less JSON-known stores and migrates recorded identity + default', async () => {
      const idless = path.join(tmpDir, 'projects', 'legacy-noid');
      seedCmosDb(idless, { projectId: '', projectName: 'legacy-noid' });
      const withId = makeStore('has-id', 'has-id-uuid');

      seedLegacyJson(configDir, [{ projectRoot: idless }, { projectRoot: withId }], withId);

      // First graph create() runs the identity backfill.
      const reg = await ProjectGraphRegistry.create();

      // s88-m08: opening the registry is a compatibility READ, not explicit registration.
      // The id-less store stays untouched and cannot enter a project_id-keyed graph yet.
      expect(readStoreIdentity(idless)).toBeNull();
      expect(reg.getByStorePath(idless)).toBeNull();

      // The store that already had an id is present, id untouched.
      expect(reg.get('has-id-uuid')?.store_path).toBe(withId);

      // The legacy JSON default is migrated to the graph default.
      expect(reg.getDefault()?.project_id).toBe('has-id-uuid');

      // A fourth JSON project added later is NOT re-scanned (marker-gated).
      const late = makeStore('late', 'late-id');
      seedLegacyJson(
        configDir,
        [{ projectRoot: idless }, { projectRoot: withId }, { projectRoot: late }],
        withId
      );
      ProjectGraphRegistry.resetInstance();
      const reg2 = await ProjectGraphRegistry.create();
      expect(reg2.get('late-id')).toBeUndefined();
    });

    it('defers an identity-less legacy default and promotes it when that path is registered', async () => {
      const idless = path.join(tmpDir, 'projects', 'legacy-default-noid');
      seedCmosDb(idless, { projectId: '', projectName: 'legacy-default-noid' });
      seedLegacyJson(configDir, [{ projectRoot: idless }], idless);

      const reg = await ProjectGraphRegistry.create();
      expect(reg.getDefault()).toBeNull();

      const registered = reg.registerStore(idless, { requireStoredIdentity: true });
      expect(reg.getDefault()?.project_id).toBe(registered.project_id);
      expect(reg.getDefault()?.store_path).toBe(path.resolve(idless));

      const originalCwd = process.cwd;
      process.cwd = () => path.join(tmpDir, 'not-a-cmos-project');
      CmosDetector.resetInstance();
      try {
        const resolved = await resolveProjectRootEnhanced(undefined, { autoRegister: false });
        expect(resolved.source).toBe('registry');
        expect(resolved.projectRoot).toBe(path.resolve(idless));
      } finally {
        process.cwd = originalCwd;
        CmosDetector.resetInstance();
      }
    });

    it('read-classified registry creation defers identified legacy imports until a write context', async () => {
      const root = makeStore('legacy-identified-read', 'legacy-identified-id');
      seedLegacyJson(configDir, [{ projectRoot: root }], root);

      const readGraph = (await captureToolCall('read', () => ProjectGraphRegistry.create())).value;
      expect(readGraph.getByStorePath(root)).toBeNull();
      expect(readGraph.getDefault()).toBeNull();

      ProjectGraphRegistry.resetInstance();
      const writeGraph = (await captureToolCall('write', () => ProjectGraphRegistry.create()))
        .value;
      expect(writeGraph.getByStorePath(root)).toBe('legacy-identified-id');
      expect(writeGraph.getDefault()?.project_id).toBe('legacy-identified-id');
    });
  });

  // ── Sprint 79 m02 — authoritative writes (JSON derivation deleted in s80-m02) ─
  describe('authoritative writes (Sprint 79 m02 / s80-m02)', () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it('registerStore mints a UUID for a readable id-less store and reuses it on re-register', async () => {
      const reg = await ProjectGraphRegistry.create();
      const idless = path.join(tmpDir, 'projects', 'store-a');
      seedCmosDb(idless, { projectId: '', projectName: 'store-a' });

      const e1 = reg.registerStore(idless, { name: 'Store A' });
      expect(e1.project_id).toMatch(UUID_RE);
      expect(e1.name).toBe('Store A');
      expect(readStoreIdentity(idless)?.project_id).toBe(e1.project_id); // persisted

      // Re-register reuses the same id (stable) and updates in place — one row.
      const e2 = reg.registerStore(idless, { name: 'Store A v2' });
      expect(e2.project_id).toBe(e1.project_id);
      expect(e2.name).toBe('Store A v2');
      expect(reg.list()).toHaveLength(1);
    });

    it('registerStore falls back to a basename slug when the store DB is unreadable', async () => {
      const reg = await ProjectGraphRegistry.create();
      const root = path.join(tmpDir, 'unreadable-store');
      fs.mkdirSync(path.join(root, 'cmos', 'db'), { recursive: true });
      fs.writeFileSync(path.join(root, 'cmos', 'db', 'cmos.sqlite'), 'not a sqlite db');

      const entry = reg.registerStore(root);
      expect(entry.project_id).toBe('unreadable-store'); // slug of basename
      expect(reg.getByStorePath(root)).toBe('unreadable-store');
    });

    it('unregisterStore removes the row + clears the default when it was the default', async () => {
      const reg = await ProjectGraphRegistry.create();
      const rootA = makeStore('u-a', 'ua-id');
      reg.registerStore(rootA, { setAsDefault: true });

      const { removed, wasDefault } = reg.unregisterStore(rootA);
      expect(removed).toBe(true);
      expect(wasDefault).toBe(true);
      expect(reg.getDefault()).toBeNull();
      expect(reg.list()).toHaveLength(0);

      // Unregistering an unknown path is a no-op (removed:false).
      expect(reg.unregisterStore(path.join(tmpDir, 'never')).removed).toBe(false);
    });
  });
});
