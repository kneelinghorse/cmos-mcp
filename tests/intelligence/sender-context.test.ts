// ABOUTME: Unit tests for resolveSenderContext — the single audited boundary
// ABOUTME: that attributes outbound tool calls to a local CMOS project (Sprint 53 m01).

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import os from 'os';
import path from 'path';

import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectRegistry } from '../../src/intelligence/project-registry';
import {
  SenderResolutionError,
  resolveSenderContext,
  validateProject,
  type SenderContext,
} from '../../src/intelligence/sender-context';

const VALID_UUID = '09fb9553-6413-479a-8a5c-af6a9d949ae6';
const OTHER_UUID = 'deadbeef-1234-4abc-89ef-0123456789ab';

interface SeedOptions {
  dashboardProjectId?: string | null;
  cmosAddress?: string | null;
  owner?: string | null;
  slug?: string | null;
  projectName?: string;
}

async function makeTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function seedCmosDb(root: string, opts: SeedOptions = {}): string {
  const dbDir = path.join(root, 'cmos', 'db');
  fsSync.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
  if (fsSync.existsSync(dbPath)) fsSync.unlinkSync(dbPath);

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT, content TEXT, updated_at TEXT);
  `);

  const insMeta = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  if (opts.dashboardProjectId !== undefined && opts.dashboardProjectId !== null) {
    insMeta.run('dashboard_project_id', opts.dashboardProjectId);
  }
  if (opts.owner) insMeta.run('owner', opts.owner);
  if (opts.slug) insMeta.run('dashboard_slug', opts.slug);
  insMeta.run('project_name', opts.projectName ?? opts.slug ?? 'test-project');
  insMeta.run('project_id', opts.slug ?? 'test-project');

  const now = new Date().toISOString();
  const identity = {
    project_id: opts.slug ?? 'test-project',
    project_name: opts.projectName ?? 'Test Project',
    cmos_address: opts.cmosAddress ?? '',
    platform: 'aquex.ai',
    domain: '',
    project_type: 'build',
    tier: 'build',
    status: 'active_development',
    description: '',
    objectives: [],
    related_projects: [],
    foundational_docs: [],
    tracelab_refs: [],
    type_fields: {},
    identity_contract_version: 'v1',
    created_at: now,
    updated_at: now,
  };
  db.prepare('INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)').run(
    'project_identity',
    'cmos/contexts/project-identity.json',
    JSON.stringify(identity),
    now
  );

  db.close();
  return dbPath;
}

async function makeEmptyDir(prefix: string): Promise<string> {
  return makeTmp(prefix);
}

describe('sender-context', () => {
  const tmpDirs: string[] = [];

  async function trackTmp(prefix: string): Promise<string> {
    const p = await makeTmp(prefix);
    tmpDirs.push(p);
    return p;
  }

  async function isolatedRegistry(): Promise<ProjectRegistry> {
    const configDir = await trackTmp('sctx-cfg-');
    ProjectRegistry.resetInstance();
    return ProjectRegistry.create({ configDir });
  }

  beforeEach(() => {
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
  });

  afterEach(async () => {
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => void 0);
    }
  });

  // ─── validateProject ──────────────────────────────────────────────────────

  describe('validateProject', () => {
    it('rejects a directory without a CMOS database', async () => {
      const root = await trackTmp('sctx-no-db-');
      const result = await validateProject(root);
      expect(result.hasDatabase).toBe(false);
      expect(result.hasValidSenderIdentity).toBe(false);
      expect(result.rejectReason).toMatch(/no CMOS database/i);
    });

    it('rejects a DB missing dashboard_project_id UUID', async () => {
      const root = await trackTmp('sctx-no-uuid-');
      seedCmosDb(root, { cmosAddress: 'cmos://derek/thing' });
      const result = await validateProject(root);
      expect(result.hasDatabase).toBe(true);
      expect(result.dashboardProjectId).toBeNull();
      expect(result.hasValidSenderIdentity).toBe(false);
      expect(result.rejectReason).toMatch(/dashboard_project_id/i);
    });

    it('rejects a DB with a non-UUID dashboard_project_id value', async () => {
      const root = await trackTmp('sctx-bad-uuid-');
      seedCmosDb(root, { dashboardProjectId: 'not-a-uuid', cmosAddress: 'cmos://derek/thing' });
      const result = await validateProject(root);
      expect(result.dashboardProjectId).toBe('not-a-uuid');
      expect(result.hasValidSenderIdentity).toBe(false);
      expect(result.rejectReason).toMatch(/dashboard_project_id/i);
    });

    it('rejects an empty cmos_address when UUID is present', async () => {
      const root = await trackTmp('sctx-empty-addr-');
      seedCmosDb(root, { dashboardProjectId: VALID_UUID, cmosAddress: '' });
      const result = await validateProject(root);
      expect(result.hasValidSenderIdentity).toBe(false);
      expect(result.rejectReason).toMatch(/cmos_address/i);
    });

    it('heals cmos://unknown/* when owner metadata is present', async () => {
      const root = await trackTmp('sctx-heal-');
      seedCmosDb(root, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://unknown/my-slug',
        owner: 'derek',
        slug: 'my-slug',
      });
      const result = await validateProject(root);
      expect(result.hasValidSenderIdentity).toBe(true);
      expect(result.cmosAddress).toBe('cmos://derek/my-slug');
      expect(result.healed).toBeDefined();
      expect(result.healed?.previous).toBe('cmos://unknown/my-slug');
      expect(result.healed?.next).toBe('cmos://derek/my-slug');
    });

    it('stays invalid when cmos://unknown/* has no owner to heal with', async () => {
      const root = await trackTmp('sctx-no-owner-');
      seedCmosDb(root, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://unknown/orphan',
      });
      const result = await validateProject(root);
      expect(result.hasValidSenderIdentity).toBe(false);
      expect(result.healed).toBeUndefined();
      expect(result.rejectReason).toMatch(/cmos_address/i);
    });

    it('accepts a DB with UUID and canonical cmos_address', async () => {
      const root = await trackTmp('sctx-valid-');
      seedCmosDb(root, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://derek/demo',
      });
      const result = await validateProject(root);
      expect(result.hasDatabase).toBe(true);
      expect(result.dashboardProjectId).toBe(VALID_UUID);
      expect(result.cmosAddress).toBe('cmos://derek/demo');
      expect(result.hasValidSenderIdentity).toBe(true);
      expect(result.healed).toBeUndefined();
    });

    it('honors heal=false and does not rewrite stale addresses', async () => {
      const root = await trackTmp('sctx-noheal-');
      seedCmosDb(root, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://unknown/my-slug',
        owner: 'derek',
        slug: 'my-slug',
      });
      const result = await validateProject(root, { heal: false });
      expect(result.hasValidSenderIdentity).toBe(false);
      expect(result.healed).toBeUndefined();
    });
  });

  // ─── resolveSenderContext: precedence chain ──────────────────────────────

  describe('resolveSenderContext — precedence chain', () => {
    it('step 1: explicit projectRoot wins when valid', async () => {
      const root = await trackTmp('sctx-p1-explicit-');
      seedCmosDb(root, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/explicit' });

      const registry = await isolatedRegistry();
      const ctx = await resolveSenderContext({
        explicitProjectRoot: root,
        mcpRoots: [],
        cwdOverride: '/does/not/exist',
        registryOverride: registry,
        serverInstallRootOverride: '/some/other/install',
      });
      expect(ctx.source).toBe('explicit');
      expect(ctx.projectRoot).toBe(path.resolve(root));
      expect(ctx.dashboardProjectId).toBe(VALID_UUID);
      expect(ctx.cmosAddress).toBe('cmos://derek/explicit');
    });

    it('step 1 falls through when explicit root is invalid', async () => {
      const invalidRoot = await trackTmp('sctx-invalid-explicit-');
      const cwdRoot = await trackTmp('sctx-cwd-valid-');
      seedCmosDb(cwdRoot, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/cwd' });

      const registry = await isolatedRegistry();
      const ctx = await resolveSenderContext({
        explicitProjectRoot: invalidRoot,
        cwdOverride: cwdRoot,
        registryOverride: registry,
        serverInstallRootOverride: '/some/other/install',
      });
      expect(ctx.source).toBe('cwd');
      const explicitCandidate = ctx.candidates.find((c) => c.source === 'explicit');
      expect(explicitCandidate?.accepted).toBe(false);
      expect(explicitCandidate?.rejectReason).toBeDefined();
    });

    it('step 2: mcp-roots chosen when explicit absent', async () => {
      const rootA = await trackTmp('sctx-p2-invalid-');
      const rootB = await trackTmp('sctx-p2-valid-');
      seedCmosDb(rootB, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://derek/roots-win',
      });

      const registry = await isolatedRegistry();
      const ctx = await resolveSenderContext({
        mcpRoots: [rootA, rootB],
        cwdOverride: '/tmp/does-not-have-cmos',
        registryOverride: registry,
        serverInstallRootOverride: '/some/other/install',
      });
      expect(ctx.source).toBe('mcp-roots');
      expect(ctx.projectRoot).toBe(path.resolve(rootB));
      expect(ctx.cmosAddress).toBe('cmos://derek/roots-win');
      expect(ctx.candidates.filter((c) => c.source === 'mcp-roots').length).toBeGreaterThanOrEqual(
        2
      );
    });

    it('step 3: cwd used when explicit + mcp-roots empty/invalid', async () => {
      const cwdRoot = await trackTmp('sctx-p3-cwd-');
      seedCmosDb(cwdRoot, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/cwd3' });

      const registry = await isolatedRegistry();
      const ctx = await resolveSenderContext({
        cwdOverride: cwdRoot,
        registryOverride: registry,
        serverInstallRootOverride: '/some/other/install',
      });
      expect(ctx.source).toBe('cwd');
      expect(ctx.projectRoot).toBe(path.resolve(cwdRoot));
    });

    it('step 4: registry singleton used when above all fall through', async () => {
      const registered = await trackTmp('sctx-p4-registry-');
      seedCmosDb(registered, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://derek/singleton',
      });

      const registry = await isolatedRegistry();
      await registry.register(registered);

      const cwdEmpty = await trackTmp('sctx-p4-empty-cwd-');
      const ctx = await resolveSenderContext({
        cwdOverride: cwdEmpty,
        registryOverride: registry,
        serverInstallRootOverride: '/some/other/install',
      });
      expect(ctx.source).toBe('registry-singleton');
      expect(ctx.projectRoot).toBe(path.resolve(registered));
      expect(ctx.cmosAddress).toBe('cmos://derek/singleton');
    });

    it('step 4: refuses registry auto-pick when size > 1', async () => {
      const rootA = await trackTmp('sctx-reg-a-');
      const rootB = await trackTmp('sctx-reg-b-');
      seedCmosDb(rootA, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://derek/a',
        slug: 'a',
      });
      seedCmosDb(rootB, {
        dashboardProjectId: OTHER_UUID,
        cmosAddress: 'cmos://derek/b',
        slug: 'b',
      });

      const registry = await isolatedRegistry();
      await registry.register(rootA);
      await registry.register(rootB);

      const cwdEmpty = await trackTmp('sctx-reg-multi-cwd-');
      await expect(
        resolveSenderContext({
          cwdOverride: cwdEmpty,
          registryOverride: registry,
          serverInstallRootOverride: '/some/other/install',
        })
      ).rejects.toBeInstanceOf(SenderResolutionError);
    });

    it('step 5: throws SenderResolutionError with full candidate trace', async () => {
      const cwdEmpty = await trackTmp('sctx-fail-cwd-');
      const explicitBad = await trackTmp('sctx-fail-explicit-');
      const rootBad = await trackTmp('sctx-fail-root-');
      const registry = await isolatedRegistry();

      let caught: SenderResolutionError | null = null;
      try {
        await resolveSenderContext({
          explicitProjectRoot: explicitBad,
          mcpRoots: [rootBad],
          cwdOverride: cwdEmpty,
          registryOverride: registry,
          serverInstallRootOverride: '/some/other/install',
        });
      } catch (err) {
        caught = err as SenderResolutionError;
      }
      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(SenderResolutionError);
      expect(caught!.code).toBe('SENDER_UNRESOLVABLE');
      const sources = caught!.candidates.map((c) => c.source);
      expect(sources).toEqual(
        expect.arrayContaining(['explicit', 'mcp-roots', 'cwd', 'registry-singleton'])
      );
      for (const c of caught!.candidates) {
        expect(c.accepted).toBe(false);
        expect(c.rejectReason).toBeTruthy();
      }
    });
  });

  // ─── cwd-vs-SERVER_INSTALL_ROOT guard ─────────────────────────────────────

  describe('cwd-vs-SERVER_INSTALL_ROOT guard', () => {
    it('rejects cwd when cwd === SERVER_INSTALL_ROOT and requireSenderIdentity=true', async () => {
      const installRoot = await trackTmp('sctx-install-');
      seedCmosDb(installRoot, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://derek/cmos-mcp',
      });
      const registry = await isolatedRegistry();

      let caught: SenderResolutionError | null = null;
      try {
        await resolveSenderContext({
          cwdOverride: installRoot,
          serverInstallRootOverride: installRoot,
          registryOverride: registry,
          requireSenderIdentity: true,
        });
      } catch (err) {
        caught = err as SenderResolutionError;
      }
      expect(caught).toBeInstanceOf(SenderResolutionError);
      const cwdCandidate = caught!.candidates.find((c) => c.source === 'cwd');
      expect(cwdCandidate?.accepted).toBe(false);
      expect(cwdCandidate?.rejectReason).toMatch(/SERVER_INSTALL_ROOT/);
    });

    it('allows cwd === SERVER_INSTALL_ROOT when explicit root was passed (self-work case)', async () => {
      const installRoot = await trackTmp('sctx-install-explicit-');
      seedCmosDb(installRoot, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://derek/cmos-mcp',
      });
      const registry = await isolatedRegistry();

      const ctx = await resolveSenderContext({
        explicitProjectRoot: installRoot,
        cwdOverride: installRoot,
        serverInstallRootOverride: installRoot,
        registryOverride: registry,
      });
      expect(ctx.source).toBe('explicit');
      expect(ctx.projectRoot).toBe(path.resolve(installRoot));
    });

    it('allows cwd === SERVER_INSTALL_ROOT when requireSenderIdentity=false', async () => {
      const installRoot = await trackTmp('sctx-install-nonreq-');
      seedCmosDb(installRoot, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://derek/cmos-mcp',
      });
      const registry = await isolatedRegistry();

      const ctx = await resolveSenderContext({
        cwdOverride: installRoot,
        serverInstallRootOverride: installRoot,
        registryOverride: registry,
        requireSenderIdentity: false,
      });
      expect(ctx.source).toBe('cwd');
      expect(ctx.projectRoot).toBe(path.resolve(installRoot));
    });
  });

  // ─── requireSenderIdentity=false relaxes validation ───────────────────────

  describe('requireSenderIdentity=false', () => {
    it('accepts a DB that lacks identity metadata when requireSenderIdentity=false', async () => {
      const cwdRoot = await trackTmp('sctx-nonreq-cwd-');
      seedCmosDb(cwdRoot, { cmosAddress: '' });
      const registry = await isolatedRegistry();

      const ctx: SenderContext = await resolveSenderContext({
        cwdOverride: cwdRoot,
        registryOverride: registry,
        serverInstallRootOverride: '/some/other/install',
        requireSenderIdentity: false,
      });
      expect(ctx.source).toBe('cwd');
      expect(ctx.dashboardProjectId).toBeNull();
      expect(ctx.cmosAddress).toBeNull();
    });

    it('still fails closed when nothing has a database, even with requireSenderIdentity=false', async () => {
      const cwdRoot = await trackTmp('sctx-nonreq-nodb-');
      const registry = await isolatedRegistry();

      await expect(
        resolveSenderContext({
          cwdOverride: cwdRoot,
          registryOverride: registry,
          serverInstallRootOverride: '/some/other/install',
          requireSenderIdentity: false,
        })
      ).rejects.toBeInstanceOf(SenderResolutionError);
    });
  });

  // ─── SERVER_INSTALL_ROOT export ───────────────────────────────────────────

  describe('SERVER_INSTALL_ROOT', () => {
    it('is an absolute path', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SERVER_INSTALL_ROOT } = require('../../src/intelligence/sender-context');
      expect(path.isAbsolute(SERVER_INSTALL_ROOT)).toBe(true);
    });
  });
});

// Silence unused-import lint in case makeEmptyDir is not used
void makeEmptyDir;
