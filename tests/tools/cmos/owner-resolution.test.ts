// ABOUTME: Tests for resolveAndPersistOwner — async seed of metadata.owner from the
// authenticated dashboard identity. Guards Sprint 52 m01: no more cmos://unknown/*.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { resolveAndPersistOwner } from '../../../src/tools/cmos/owner-resolution';
import { DashboardClient } from '../../../src/tools/cmos/dashboard-client';
import { createSuccess, createError, CmosErrors } from '../../../src/tools/cmos/errors';

function makeTempClient(): Promise<{ tempDir: string; client: CmosDatabaseClient }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-owner-resolution-test-'));
  const cmosDbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDbDir, { recursive: true });
  const dbPath = path.join(cmosDbDir, 'cmos.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT, content TEXT, updated_at TEXT);
  `);
  db.close();

  return CmosDatabaseClient.create({ dbPath }).then((result) => {
    if (!result.success || !result.data) throw new Error('open failed');
    return { tempDir, client: result.data };
  });
}

function cleanup(tempDir: string, client: CmosDatabaseClient): void {
  client.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function readMeta(client: CmosDatabaseClient, key: string): string | null {
  const r = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  return r.success && r.data ? r.data.value : null;
}

// Build a DashboardClient stub exposing only the methods resolveAndPersistOwner uses.
function stubDashboardClient(opts: {
  username: string | null;
  projectsOwner?: string | null;
  projectsCmosAddress?: string | null;
  projectsId?: string | null;
  projectsSlug?: string | null;
  projects?: Array<Record<string, unknown>>;
  authFailure?: boolean;
}): DashboardClient {
  const stub = Object.create(DashboardClient.prototype) as DashboardClient & {
    _username: string | null;
  };
  (stub as unknown as { cachedIdentity: unknown }).cachedIdentity =
    opts.username === null
      ? null
      : { userId: 'u-stub', email: 'stub@example.test', username: opts.username };
  // Override getMyProjects to either fail or return a stubbed directory
  (stub as unknown as { getMyProjects: () => Promise<unknown> }).getMyProjects = async () => {
    if (opts.authFailure) {
      return createError(CmosErrors.dashboardAuthFailed('https://stub.example'));
    }
    const projects =
      opts.projects ??
      (opts.projectsOwner || opts.projectsCmosAddress
        ? [
            {
              id: opts.projectsId ?? 'p1',
              name: 'Stub',
              ...(opts.projectsCmosAddress
                ? { cmosAddress: opts.projectsCmosAddress }
                : { address: 'cmos://x/y' }),
              ...(opts.projectsOwner ? { owner: opts.projectsOwner } : {}),
              ...(opts.projectsSlug ? { slug: opts.projectsSlug } : {}),
            },
          ]
        : []);
    return createSuccess({
      projects,
      totalCount: projects.length,
    });
  };
  return stub;
}

describe('resolveAndPersistOwner', () => {
  it('short-circuits on existing metadata.owner', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      client.execute(`INSERT INTO metadata (key, value) VALUES ('owner', 'derek')`);
      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({ username: 'impostor' })
      );
      expect(result.owner).toBe('derek');
      expect(result.source).toBe('metadata');
      expect(readMeta(client, 'owner')).toBe('derek');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('persists the dashboard username to metadata.owner + dashboard_username', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({ username: 'derek' })
      );
      expect(result.owner).toBe('derek');
      expect(result.source).toBe('dashboard');
      expect(readMeta(client, 'owner')).toBe('derek');
      expect(readMeta(client, 'dashboard_username')).toBe('derek');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('falls back to projects[0].owner when cachedIdentity.username is null (API-key auth)', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({ username: null, projectsOwner: 'derek' })
      );
      expect(result.owner).toBe('derek');
      expect(result.source).toBe('dashboard');
      expect(readMeta(client, 'owner')).toBe('derek');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('parses owner from projects[0].cmosAddress when the owner field is absent', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: null,
          projectsCmosAddress: 'cmos://derek/stage1',
        })
      );
      expect(result.owner).toBe('derek');
      expect(result.source).toBe('dashboard');
      expect(readMeta(client, 'owner')).toBe('derek');
      expect(readMeta(client, 'dashboard_username')).toBe('derek');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('refreshes metadata.dashboard_slug from the matching dashboard project row', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`, [
        'ddb34d24-30e3-4eb3-b13c-20b106a75970',
      ]);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'stage1-2')`);

      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: null,
          projectsId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
          projectsSlug: 'stage1',
          projectsCmosAddress: 'cmos://derek/stage1',
        })
      );

      expect(result.owner).toBe('derek');
      expect(readMeta(client, 'dashboard_slug')).toBe('stage1');
      expect(readMeta(client, 'owner')).toBe('derek');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('does not short-circuit when owner exists but project_identity is still cmos://unknown/*', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      client.execute(`INSERT INTO metadata (key, value) VALUES ('owner', 'derek')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`, [
        'ddb34d24-30e3-4eb3-b13c-20b106a75970',
      ]);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'stage1-2')`);
      client.execute(
        `INSERT INTO contexts (id, source_path, content, updated_at)
         VALUES ('project_identity', 'cmos/contexts/project-identity.json', ?, datetime('now'))`,
        [JSON.stringify({ cmos_address: 'cmos://unknown/stage1-2' })]
      );

      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: null,
          projectsId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
          projectsSlug: 'stage1',
          projectsCmosAddress: 'cmos://derek/stage1',
        })
      );

      expect(result.owner).toBe('derek');
      expect(result.source).toBe('dashboard');
      expect(readMeta(client, 'dashboard_slug')).toBe('stage1');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('repairs stale dashboard_project_id by matching the local project slug/name', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`, [
        '09fb9553-6413-479a-8a5c-af6a9d949ae6',
      ]);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'stage1-2')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_id', 'stage1')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_name', 'Stage1')`);

      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: null,
          projectsId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
          projectsSlug: 'stage1',
          projectsCmosAddress: 'cmos://derek/stage1',
        })
      );

      expect(result.owner).toBe('derek');
      expect(readMeta(client, 'dashboard_project_id')).toBe('ddb34d24-30e3-4eb3-b13c-20b106a75970');
      expect(readMeta(client, 'dashboard_slug')).toBe('stage1');
      expect(readMeta(client, 'owner')).toBe('derek');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('prefers local slug/name hints over a stale canonical cmos_address', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`, [
        '09fb9553-6413-479a-8a5c-af6a9d949ae6',
      ]);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'stage1-2')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_id', 'stage1')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_name', 'Stage1')`);
      client.execute(
        `INSERT INTO contexts (id, source_path, content, updated_at)
         VALUES ('project_identity', 'cmos/contexts/project-identity.json', ?, datetime('now'))`,
        [JSON.stringify({ cmos_address: 'cmos://derek/parts-town' })]
      );

      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: null,
          projectsId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
          projectsSlug: 'stage1',
          projectsCmosAddress: 'cmos://derek/stage1',
        })
      );

      expect(result.owner).toBe('derek');
      expect(readMeta(client, 'dashboard_project_id')).toBe('ddb34d24-30e3-4eb3-b13c-20b106a75970');
      expect(readMeta(client, 'dashboard_slug')).toBe('stage1');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('overrides a conflicting dashboard_project_id when its project slug disagrees with local hints', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`, [
        '96ce2349-b7e7-45b1-99e3-23277db407f5',
      ]);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'parts-town')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_id', 'stage1')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_name', 'Stage1')`);

      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: null,
          projects: [
            {
              id: '96ce2349-b7e7-45b1-99e3-23277db407f5',
              name: 'Parts Town',
              slug: 'parts-town',
              cmosAddress: 'cmos://derek/parts-town',
            },
            {
              id: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
              name: 'stage1',
              slug: 'stage1',
              cmosAddress: 'cmos://derek/stage1',
            },
          ],
        })
      );

      expect(result.owner).toBe('derek');
      expect(readMeta(client, 'dashboard_project_id')).toBe('ddb34d24-30e3-4eb3-b13c-20b106a75970');
      expect(readMeta(client, 'dashboard_slug')).toBe('stage1');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('s81-m02: does NOT mis-adopt an unrelated project slug/id in a multi-project account with no matching hint', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      // Local store carries hints that match NONE of the account's projects.
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_id', 'orphan-local')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_name', 'Orphan Local')`);

      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: 'derek',
          projects: [
            { id: 'p1', name: 'Alpha', slug: 'alpha', cmosAddress: 'cmos://derek/alpha' },
            { id: 'p2', name: 'Beta', slug: 'beta', cmosAddress: 'cmos://derek/beta' },
          ],
        })
      );

      // Owner still resolves from the authenticated identity (no regression)...
      expect(result.owner).toBe('derek');
      expect(readMeta(client, 'owner')).toBe('derek');
      // ...but the arbitrary projects[0] slug/id are NOT persisted back to local metadata.
      expect(readMeta(client, 'dashboard_slug')).toBeNull();
      expect(readMeta(client, 'dashboard_project_id')).toBeNull();
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('s81-m02: single-project account still adopts its sole project (unambiguous fallback preserved)', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: null,
          projects: [{ id: 'p-solo', name: 'Solo', slug: 'solo', owner: 'derek' }],
        })
      );

      expect(result.owner).toBe('derek');
      expect(readMeta(client, 'dashboard_slug')).toBe('solo');
      expect(readMeta(client, 'dashboard_project_id')).toBe('p-solo');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('s81-m02: reports incumbentConfirmed=true for a TRUSTED match (local project_id slug matches the incumbent row)', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', 'id1')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'stage1')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_id', 'stage1')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_name', 'Stage1')`);

      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: 'derek',
          projects: [
            { id: 'other', name: 'Other', slug: 'other', owner: 'derek' },
            { id: 'id1', name: 'Stage1', slug: 'stage1', owner: 'derek' },
          ],
        })
      );

      // byId('id1') matches and its slug 'stage1' is in trustedSlugs (from project_id) → confirmed.
      expect(result.incumbentConfirmed).toBe(true);
      expect(readMeta(client, 'dashboard_slug')).toBe('stage1');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('s81-m02: reports incumbentConfirmed=false for a WEAK match (only the local dashboard_slug hint matches — a wrong slug reaffirms itself)', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      // Local identity (project_id/name) matches NO project; dashboard_slug points at a
      // sibling. The sibling matches only via the dashboard_slug hint (weak tier).
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_id', 'orphan')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('project_name', 'Orphan')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'sibling')`);

      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({
          username: 'derek',
          projects: [
            { id: 'ida', name: 'Alpha', slug: 'alpha', owner: 'derek' },
            { id: 'idb', name: 'Sibling', slug: 'sibling', owner: 'derek' },
          ],
        })
      );

      // Owner still resolves, but the incumbent is NOT confirmed — the push must not relax
      // its guard on a self-referential dashboard_slug-hint match.
      expect(result.owner).toBe('derek');
      expect(result.incumbentConfirmed).toBe(false);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('returns unresolved when dashboard auth fails', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({ username: null, authFailure: true })
      );
      expect(result.owner).toBeNull();
      expect(result.source).toBe('unresolved');
      expect(readMeta(client, 'owner')).toBeNull();
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('falls back to existing metadata.owner when dashboard refresh is unavailable', async () => {
    const { tempDir, client } = await makeTempClient();
    try {
      client.execute(`INSERT INTO metadata (key, value) VALUES ('owner', 'derek')`);
      client.execute(`INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`, [
        'ddb34d24-30e3-4eb3-b13c-20b106a75970',
      ]);

      const result = await resolveAndPersistOwner(
        client,
        stubDashboardClient({ username: null, authFailure: true })
      );

      expect(result.owner).toBe('derek');
      expect(result.source).toBe('metadata');
      expect(readMeta(client, 'owner')).toBe('derek');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('returns unresolved when no dashboard is configured (no env, no override)', async () => {
    const { tempDir, client } = await makeTempClient();
    const savedUrl = process.env.CMOS_DASHBOARD_URL;
    const savedKey = process.env.CMOS_DASHBOARD_API_KEY;
    const savedUser = process.env.CMOS_DASHBOARD_USER;
    const savedPw = process.env.CMOS_DASHBOARD_PASSWORD;
    delete process.env.CMOS_DASHBOARD_URL;
    delete process.env.CMOS_DASHBOARD_API_KEY;
    delete process.env.CMOS_DASHBOARD_USER;
    delete process.env.CMOS_DASHBOARD_PASSWORD;
    try {
      const result = await resolveAndPersistOwner(client);
      expect(result.owner).toBeNull();
      expect(result.source).toBe('unresolved');
      expect(readMeta(client, 'owner')).toBeNull();
    } finally {
      if (savedUrl !== undefined) process.env.CMOS_DASHBOARD_URL = savedUrl;
      if (savedKey !== undefined) process.env.CMOS_DASHBOARD_API_KEY = savedKey;
      if (savedUser !== undefined) process.env.CMOS_DASHBOARD_USER = savedUser;
      if (savedPw !== undefined) process.env.CMOS_DASHBOARD_PASSWORD = savedPw;
      cleanup(tempDir, client);
    }
  });
});
