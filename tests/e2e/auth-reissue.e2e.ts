// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m06 — cmos_auth(reissue) over real MCP stdio against the BUILT dist/, both the
// ABOUTME: failure surface (row survives, honest text) and the success surface (user key on the wire).

/**
 * Sprint 86 m06 — the reissue surface, proven through the transport it ships over.
 *
 * WHY THIS EXISTS ALONGSIDE tests/auth/reissue-resolution.test.ts. A handler-only test is
 * exactly what let `statusFilter`, `expiresAt` and `agentFeedback` each ship declared-but-dead:
 * the handler was right and nothing reached it. Two of this mission's claims are only true if
 * they survive the MCP dispatch boundary and the FORMATTER:
 *
 *   - the corrected error text must reach `content[0].text` — the channel an agent actually
 *     reads. `formatAuthForLLM` dropped `error.suggestion` entirely before this mission, so
 *     every suggestion string it rewrites would otherwise have been invisible;
 *   - the local project row must survive a failed reissue, in the real process, against the
 *     real `CredentialStore` on disk — not a mocked store in-process.
 *
 * BOTH LEGS ARE OFFLINE. Leg (a) touches no network at all (the classification fails first).
 * Leg (b) binds a stub dashboard to 127.0.0.1 on an ephemeral port and points
 * CMOS_DASHBOARD_URL at it, so the assertion "the reissue POST carried the USER key" is made
 * against a real HTTP request off a real socket.
 *
 * NEVER THE OPERATOR'S CREDENTIALS. Every leg writes its own `CMOS_CONFIG_DIR` under
 * os.tmpdir(). The real `~/.config/cmos-mcp/credentials.json` holds live `cmk_` secrets at mode
 * 0600 and is never read, copied, or written by this suite.
 *
 * NO SILENT FAIL-OPEN. A missing dist/ or live store FAILS loudly; this suite never skips.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { connectStdioServer, type StdioHarness } from './stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const LIVE_DB = path.join(REPO_ROOT, 'cmos', 'db', 'cmos.sqlite');
const DASHBOARD_PROJECT_ID = 'e2e-project-uuid';

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * A scratch project whose store is a COPY of the live one, with its dashboard registration
 * metadata forced to known values. Copying gives a genuinely migrated schema; the metadata
 * override is what makes `reissue` reach its credential logic instead of bailing at
 * PROJECT_NOT_REGISTERED.
 */
function scratchProject(prefix: string): string {
  const projectRoot = mkTmp(prefix);
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${LIVE_DB}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dbDir, `cmos.sqlite${suffix}`));
  }
  const db = new Database(path.join(dbDir, 'cmos.sqlite'));
  db.prepare(
    `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_registered', 'true')`
  ).run();
  db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`).run(
    DASHBOARD_PROJECT_ID
  );
  db.close();
  return projectRoot;
}

interface SeedOptions {
  userScopedKeys?: Record<string, { key: string }>;
  projectKeys?: Record<string, { key: string; keyId: string; parentKeyId: string }>;
}

/** Write a credentials.json into a fresh scratch config dir, at the real file's mode. */
function scratchConfigDir(prefix: string, seed: SeedOptions): string {
  const configDir = mkTmp(prefix);
  const now = new Date().toISOString();
  const file = {
    version: 1,
    userScopedKeys: Object.fromEntries(
      Object.entries(seed.userScopedKeys ?? {}).map(([keyId, v]) => [
        keyId,
        { key: v.key, label: `e2e ${keyId}`, issuedAt: now, lastUsedAt: now },
      ])
    ),
    projectKeys: Object.fromEntries(
      Object.entries(seed.projectKeys ?? {}).map(([root, v]) => [
        path.resolve(root),
        {
          key: v.key,
          keyId: v.keyId,
          parentKeyId: v.parentKeyId,
          label: `e2e project ${v.keyId}`,
          issuedAt: now,
          lastUsedAt: now,
        },
      ])
    ),
    updatedAt: now,
  };
  fs.writeFileSync(path.join(configDir, 'credentials.json'), JSON.stringify(file, null, 2), {
    mode: 0o600,
  });
  return configDir;
}

function readCredentials(configDir: string): {
  userScopedKeys: Record<string, unknown>;
  projectKeys: Record<string, { key: string; keyId: string; parentKeyId: string }>;
} {
  return JSON.parse(fs.readFileSync(path.join(configDir, 'credentials.json'), 'utf8'));
}

describe('cmos_auth(reissue) over stdio against the built dist (s86-m06)', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY}. This suite drives the BUILT server; run ` +
          `\`npm run build\` first. It must not skip — a skipped transport test proves nothing.`
      );
    }
    if (!fs.existsSync(LIVE_DB)) {
      throw new Error(`live store not found at ${LIVE_DB}; the scratch project cannot be built.`);
    }
  });

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  // ─── leg (a): the failure surface ─────────────────────────────────────────

  it('names the empty credential store and LEAVES THE PROJECT ROW INTACT', async () => {
    const projectRoot = scratchProject('cmos-m06-fail-');
    const configDir = scratchConfigDir('cmos-m06-fail-cfg-', {
      // A project row is present, and there is NO user-scoped key — the exact state the
      // operator is in when they reach for reissue, and the one that used to destroy the row.
      projectKeys: {
        [projectRoot]: { key: 'cmk_project_dead', keyId: 'p-dead', parentKeyId: 'u' },
      },
    });

    let harness: StdioHarness | undefined;
    try {
      harness = await connectStdioServer({
        serverPath: DIST_ENTRY,
        cwd: projectRoot,
        env: {
          ...(process.env as Record<string, string>),
          CMOS_PROJECT_ROOT: projectRoot,
          CMOS_CONFIG_DIR: configDir,
          CMOS_DASHBOARD_URL: 'http://127.0.0.1:9/unreachable-on-purpose',
          // Strip the legacy arms so resolution cannot fall through to them.
          CMOS_DASHBOARD_API_KEY: '',
          CMOS_DASHBOARD_USER: '',
          CMOS_DASHBOARD_PASSWORD: '',
        },
        clientName: 'cmos-m06-reissue-failure',
      });

      const res = await harness.callTool('cmos_auth', { action: 'reissue', projectRoot });
      const text = harness.textOf(res);

      // The rendered text — not the structured envelope — carries the cause AND the fix.
      expect(text).toContain('credential store');
      expect(text).toContain(path.join(configDir, 'credentials.json'));
      expect(text).toContain('Suggestion:');
      expect(text).toContain('cmos_auth(action="login_init")');

      // The false cause is gone from the channel the agent reads.
      expect(text).not.toContain('device code flow must be run');

      // Defect D1: the operator asked for a repair and must not be left with no row.
      const after = readCredentials(configDir);
      expect(after.projectKeys[path.resolve(projectRoot)]).toBeDefined();
      expect(after.projectKeys[path.resolve(projectRoot)]?.key).toBe('cmk_project_dead');
      expect(after.projectKeys[path.resolve(projectRoot)]?.keyId).toBe('p-dead');
    } finally {
      if (harness) await harness.close();
    }
  }, 120000);

  // ─── leg (b): the success surface, against a real socket ──────────────────

  it('sends the USER-scoped key on the reissue POST and persists the fresh row', async () => {
    const projectRoot = scratchProject('cmos-m06-ok-');
    const configDir = scratchConfigDir('cmos-m06-ok-cfg-', {
      userScopedKeys: { 'user-live-1': { key: 'cmk_user_live' } },
      // A present-but-revoked project row: the state that used to short-circuit resolution.
      projectKeys: {
        [projectRoot]: { key: 'cmk_project_revoked', keyId: 'p-dead', parentKeyId: 'user-live-1' },
      },
    });

    const seen: Array<{ method: string; url: string; authorization: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
      });
      // The stub behaves like the dashboard: the revoked project key is rejected.
      if (req.headers.authorization !== 'Bearer cmk_user_live') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'revoked' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            key: 'cmk_project_fresh',
            keyId: 'p-fresh',
            label: 'reissued by e2e',
            revokedKeyIds: ['p-dead'],
          },
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    let harness: StdioHarness | undefined;
    try {
      harness = await connectStdioServer({
        serverPath: DIST_ENTRY,
        cwd: projectRoot,
        env: {
          ...(process.env as Record<string, string>),
          CMOS_PROJECT_ROOT: projectRoot,
          CMOS_CONFIG_DIR: configDir,
          CMOS_DASHBOARD_URL: `http://127.0.0.1:${port}`,
          CMOS_DASHBOARD_API_KEY: '',
          CMOS_DASHBOARD_USER: '',
          CMOS_DASHBOARD_PASSWORD: '',
        },
        clientName: 'cmos-m06-reissue-success',
      });

      const res = await harness.callTool('cmos_auth', { action: 'reissue', projectRoot });
      const text = harness.textOf(res);
      expect(text).toContain('Reissued project key');
      // The revoked list reaches the RENDERED answer, not only structuredContent.
      expect(text).toContain('revoked 1 prior key(s): p-dead');

      // The wire credential — asserted off a real socket, not a mocked fetch.
      const reissuePosts = seen.filter(
        (r) => r.method === 'POST' && r.url.includes('/keys/reissue')
      );
      expect(reissuePosts).toHaveLength(1);
      expect(reissuePosts[0]?.authorization).toBe('Bearer cmk_user_live');
      expect(seen.filter((r) => r.authorization.includes('cmk_project_revoked'))).toHaveLength(0);

      // The fresh row landed on disk, attributed to the user key that authorized the mint.
      const after = readCredentials(configDir);
      const row = after.projectKeys[path.resolve(projectRoot)];
      expect(row?.key).toBe('cmk_project_fresh');
      expect(row?.keyId).toBe('p-fresh');
      expect(row?.parentKeyId).toBe('user-live-1');

      // And the answer reports what the dashboard actually revoked (defect D3).
      const data = harness.dataOf(res) as { revokedKeyIds?: string[] };
      expect(data?.revokedKeyIds).toEqual(['p-dead']);
    } finally {
      if (harness) await harness.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120000);
});
