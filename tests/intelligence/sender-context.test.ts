// ABOUTME: Unit tests for resolveSenderContext — the single audited boundary
// ABOUTME: that attributes outbound tool calls to a local CMOS project (Sprint 53 m01).

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import os from 'os';
import path from 'path';

import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
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

  async function isolatedRegistry(): Promise<ProjectGraphRegistry> {
    const configDir = await trackTmp('sctx-cfg-');
    ProjectGraphRegistry.resetInstance();
    return ProjectGraphRegistry.create({ configDir });
  }

  beforeEach(() => {
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
  });

  afterEach(async () => {
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
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

    it('step 1: an explicit root naming a non-CMOS folder is final — never the cwd project', async () => {
      // s92-m01: projectRoot=/B called from cwd A used to fall through and write A.
      const folderB = await trackTmp('sctx-explicit-non-cmos-');
      const projectA = await trackTmp('sctx-cwd-project-a-');
      seedCmosDb(projectA, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/a' });

      const registry = await isolatedRegistry();
      let caught: SenderResolutionError | null = null;
      try {
        await resolveSenderContext({
          explicitProjectRoot: folderB,
          cwdOverride: projectA,
          registryOverride: registry,
          serverInstallRootOverride: '/some/other/install',
          requireSenderIdentity: false,
        });
      } catch (err) {
        caught = err as SenderResolutionError;
      }
      expect(caught).toBeInstanceOf(SenderResolutionError);
      expect(caught!.outcome).toBe('selected-store-rejected');
      expect(caught!.workingDir).toBe(path.resolve(folderB));
      // The cwd project was never even considered.
      expect(caught!.candidates.map((c) => c.source)).toEqual(['explicit']);
    });

    it('step 1: an explicit store without a sender identity is refused, not swapped for cwd', async () => {
      const explicitNoIdentity = await trackTmp('sctx-explicit-no-identity-');
      seedCmosDb(explicitNoIdentity, { cmosAddress: 'cmos://derek/b' });
      const cwdValid = await trackTmp('sctx-explicit-cwd-valid-');
      seedCmosDb(cwdValid, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/a' });

      const registry = await isolatedRegistry();
      await expect(
        resolveSenderContext({
          explicitProjectRoot: explicitNoIdentity,
          cwdOverride: cwdValid,
          registryOverride: registry,
          serverInstallRootOverride: '/some/other/install',
          requireSenderIdentity: true,
        })
      ).rejects.toMatchObject({
        outcome: 'selected-store-rejected',
        candidates: [
          expect.objectContaining({
            source: 'explicit',
            accepted: false,
            rejectReason: expect.stringMatching(/dashboard_project_id/),
          }),
        ],
      });
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

    it('step 2: the first MCP root holding a store is final, even when a later one is valid', async () => {
      const rootNoIdentity = await trackTmp('sctx-p2-first-store-');
      seedCmosDb(rootNoIdentity, { cmosAddress: 'cmos://derek/first' });
      const rootValid = await trackTmp('sctx-p2-later-valid-');
      seedCmosDb(rootValid, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/later' });

      const registry = await isolatedRegistry();
      await expect(
        resolveSenderContext({
          mcpRoots: [rootNoIdentity, rootValid],
          cwdOverride: '/tmp/does-not-have-cmos',
          registryOverride: registry,
          serverInstallRootOverride: '/some/other/install',
          requireSenderIdentity: true,
        })
      ).rejects.toMatchObject({
        outcome: 'selected-store-rejected',
        workingDir: path.resolve(rootNoIdentity),
      });
    });

    it('step 2: an MCP root opened on a subfolder of a project resolves to that project', async () => {
      const project = await trackTmp('sctx-p2-root-walkup-');
      seedCmosDb(project, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/rootwalk' });
      const subfolder = path.join(project, 'packages', 'web');
      fsSync.mkdirSync(subfolder, { recursive: true });

      const registry = await isolatedRegistry();
      const ctx = await resolveSenderContext({
        mcpRoots: [subfolder],
        cwdOverride: '/',
        registryOverride: registry,
        serverInstallRootOverride: '/some/other/install',
        requireSenderIdentity: false,
      });
      expect(ctx.source).toBe('mcp-roots');
      expect(ctx.projectRoot).toBe(path.resolve(project));
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

    it('step 3: a cwd inside a project resolves to that project by walking up', async () => {
      const project = await trackTmp('sctx-p3-walkup-');
      seedCmosDb(project, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/walk' });
      const nested = path.join(project, 'packages', 'web', 'src');
      fsSync.mkdirSync(nested, { recursive: true });

      const registry = await isolatedRegistry();
      const ctx = await resolveSenderContext({
        cwdOverride: nested,
        registryOverride: registry,
        serverInstallRootOverride: '/some/other/install',
      });
      expect(ctx.source).toBe('cwd');
      expect(ctx.projectRoot).toBe(path.resolve(project));
    });

    it('step 3: the walk-up stops below $HOME, so a store there cannot capture a subfolder', async () => {
      const fakeHome = await trackTmp('sctx-home-');
      seedCmosDb(fakeHome, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/home' });
      const workFolder = path.join(fakeHome, 'work', 'new-thing');
      fsSync.mkdirSync(workFolder, { recursive: true });

      const registry = await isolatedRegistry();
      await expect(
        resolveSenderContext({
          cwdOverride: workFolder,
          homeDirOverride: fakeHome,
          registryOverride: registry,
          serverInstallRootOverride: '/some/other/install',
          requireSenderIdentity: false,
        })
      ).rejects.toMatchObject({ outcome: 'no-project-here', workingDir: workFolder });

      // …while a cwd OF $HOME still resolves to a store initialised there.
      const atHome = await resolveSenderContext({
        cwdOverride: fakeHome,
        homeDirOverride: fakeHome,
        registryOverride: registry,
        serverInstallRootOverride: '/some/other/install',
        requireSenderIdentity: false,
      });
      expect(atHome.projectRoot).toBe(path.resolve(fakeHome));
    });

    it('never auto-picks the sole registered project (the clean-room singleton scenario)', async () => {
      // learning #387: with exactly one registered project A, a call from uninitialised folder B
      // used to resolve to A by the registry-singleton step and write there.
      const projectA = await trackTmp('sctx-singleton-a-');
      seedCmosDb(projectA, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/a' });
      const registry = await isolatedRegistry();
      registry.registerStore(projectA);

      const folderB = await trackTmp('sctx-singleton-folder-b-');
      for (const requireSenderIdentity of [true, false]) {
        await expect(
          resolveSenderContext({
            cwdOverride: folderB,
            registryOverride: registry,
            serverInstallRootOverride: '/some/other/install',
            requireSenderIdentity,
          })
        ).rejects.toMatchObject({
          outcome: 'no-project-here',
          workingDir: path.resolve(folderB),
        });
      }
    });

    it('refuses with a trace when roots and cwd hold no store and the cwd is a real folder', async () => {
      const cwdEmpty = await trackTmp('sctx-fail-cwd-');
      const rootBad = await trackTmp('sctx-fail-root-');
      const registry = await isolatedRegistry();

      let caught: SenderResolutionError | null = null;
      try {
        await resolveSenderContext({
          mcpRoots: [rootBad],
          cwdOverride: cwdEmpty,
          registryOverride: registry,
          serverInstallRootOverride: '/some/other/install',
        });
      } catch (err) {
        caught = err as SenderResolutionError;
      }
      expect(caught).toBeInstanceOf(SenderResolutionError);
      expect(caught!.outcome).toBe('no-project-here');
      // The folder the client advertised is the one named, not the server's cwd.
      expect(caught!.workingDir).toBe(path.resolve(rootBad));
      expect(caught!.candidates.map((c) => c.source)).toEqual(['mcp-roots', 'cwd']);
      for (const c of caught!.candidates) {
        expect(c.accepted).toBe(false);
        expect(c.rejectReason).toBeTruthy();
      }
    });
  });

  // ─── contextless calls: the only ones a default may serve ────────────────

  describe('contextless defaults', () => {
    async function twoProjects(): Promise<{
      registry: ProjectGraphRegistry;
      a: string;
      b: string;
    }> {
      const a = await trackTmp('sctx-default-a-');
      seedCmosDb(a, { dashboardProjectId: VALID_UUID, cmosAddress: 'cmos://derek/a', slug: 'a' });
      const b = await trackTmp('sctx-default-b-');
      seedCmosDb(b, { dashboardProjectId: OTHER_UUID, cmosAddress: 'cmos://derek/b', slug: 'b' });
      const registry = await isolatedRegistry();
      registry.registerStore(a);
      registry.registerStore(b);
      return { registry, a, b };
    }

    it.each([
      ['the filesystem root', (_home: string, _install: string) => '/'],
      ['$HOME', (home: string) => home],
      ['the server install root', (_home: string, install: string) => install],
    ])('a cwd of %s with no roots uses --project-root', async (_label, pickCwd) => {
      const { registry, b } = await twoProjects();
      const fakeHome = await trackTmp('sctx-ctxless-home-');
      const install = await trackTmp('sctx-ctxless-install-');
      const ctx = await resolveSenderContext({
        cwdOverride: pickCwd(fakeHome, install),
        homeDirOverride: fakeHome,
        serverInstallRootOverride: install,
        serverProjectRootOverride: b,
        registryOverride: registry,
        requireSenderIdentity: false,
      });
      expect(ctx.source).toBe('server-project-root');
      expect(ctx.projectRoot).toBe(path.resolve(b));
    });

    it('uses a registry default only after it was confirmed with setAsDefault', async () => {
      const { registry, a } = await twoProjects();
      const fakeHome = await trackTmp('sctx-confirm-home-');
      const opts = {
        cwdOverride: fakeHome,
        homeDirOverride: fakeHome,
        serverInstallRootOverride: '/some/other/install',
        serverProjectRootOverride: null,
        registryOverride: registry,
        requireSenderIdentity: false,
      };

      // A default written the pre-3.2.0 way (no confirmation) is visible but not applied.
      registry.setDefault(registry.getByStorePath(a)!);
      await expect(resolveSenderContext(opts)).rejects.toMatchObject({
        outcome: 'contextless-no-default',
        unappliedDefault: expect.objectContaining({ storePath: path.resolve(a) }),
      });

      registry.registerStore(a, { setAsDefault: true });
      const ctx = await resolveSenderContext(opts);
      expect(ctx.source).toBe('registry-default');
      expect(ctx.projectRoot).toBe(path.resolve(a));
    });

    it('never uses a default — confirmed or --project-root — from a real working folder', async () => {
      const { registry, a, b } = await twoProjects();
      registry.registerStore(a, { setAsDefault: true });
      const folder = await trackTmp('sctx-real-folder-');
      await expect(
        resolveSenderContext({
          cwdOverride: folder,
          serverInstallRootOverride: '/some/other/install',
          serverProjectRootOverride: b,
          registryOverride: registry,
          requireSenderIdentity: false,
        })
      ).rejects.toMatchObject({ outcome: 'no-project-here', workingDir: path.resolve(folder) });
    });

    it('is not contextless once the client advertises roots', async () => {
      const { registry, a } = await twoProjects();
      registry.registerStore(a, { setAsDefault: true });
      const advertised = await trackTmp('sctx-advertised-root-');
      await expect(
        resolveSenderContext({
          mcpRoots: [advertised],
          cwdOverride: '/',
          serverInstallRootOverride: '/some/other/install',
          serverProjectRootOverride: null,
          registryOverride: registry,
          requireSenderIdentity: false,
        })
      ).rejects.toMatchObject({ outcome: 'no-project-here', workingDir: path.resolve(advertised) });
    });

    it('refuses a --project-root that holds no CMOS store instead of moving on', async () => {
      const { registry, a } = await twoProjects();
      registry.registerStore(a, { setAsDefault: true });
      const notAStore = await trackTmp('sctx-bad-project-root-');
      await expect(
        resolveSenderContext({
          cwdOverride: '/',
          serverInstallRootOverride: '/some/other/install',
          serverProjectRootOverride: notAStore,
          registryOverride: registry,
          requireSenderIdentity: false,
        })
      ).rejects.toMatchObject({
        outcome: 'selected-store-rejected',
        workingDir: path.resolve(notAStore),
      });
    });
  });

  // ─── the server install root is no longer a guard (s92-m01 fork 1) ────────

  describe('server install root', () => {
    it('resolves by cwd when cwd is the install root and it holds a store, even for a send', async () => {
      const installRoot = await trackTmp('sctx-install-');
      seedCmosDb(installRoot, {
        dashboardProjectId: VALID_UUID,
        cmosAddress: 'cmos://derek/cmos-mcp',
      });
      const registry = await isolatedRegistry();

      const ctx = await resolveSenderContext({
        cwdOverride: installRoot,
        serverInstallRootOverride: installRoot,
        registryOverride: registry,
        requireSenderIdentity: true,
      });
      expect(ctx.source).toBe('cwd');
      expect(ctx.projectRoot).toBe(path.resolve(installRoot));
    });

    it('treats a store-less install root as contextless', async () => {
      const installRoot = await trackTmp('sctx-install-empty-');
      const registry = await isolatedRegistry();
      await expect(
        resolveSenderContext({
          cwdOverride: installRoot,
          serverInstallRootOverride: installRoot,
          serverProjectRootOverride: null,
          registryOverride: registry,
          requireSenderIdentity: false,
        })
      ).rejects.toMatchObject({ outcome: 'contextless-no-default' });
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
