import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-db-backfill', () => ({
  cmosDbBackfill: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/client', () => ({
  withClientAsync: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/dashboard-client', () => {
  const actual = jest.requireActual<typeof import('../../../src/tools/cmos/dashboard-client')>(
    '../../../src/tools/cmos/dashboard-client'
  );
  return {
    ...actual,
    DashboardClient: {
      fromEnv: jest.fn(),
      fromEnvForProject: jest.fn(),
    },
  };
});

jest.mock('../../../src/auth/project-key-capture', () => ({
  captureRegisterResponse: jest.fn(async () => 'captured'),
}));

import { triggerCheckpointBackfill } from '../../../src/tools/cmos/checkpoint-backfill';
import { cmosDbBackfill } from '../../../src/tools/cmos/cmos-db-backfill';
import { withClientAsync } from '../../../src/tools/cmos/client';
import { DashboardClient } from '../../../src/tools/cmos/dashboard-client';

const mockBackfill = cmosDbBackfill as jest.MockedFunction<typeof cmosDbBackfill>;
const mockWithClientAsync = withClientAsync as jest.MockedFunction<typeof withClientAsync>;
const mockFromEnvForProject = DashboardClient.fromEnvForProject as jest.MockedFunction<
  typeof DashboardClient.fromEnvForProject
>;

/** Helper: create a standard successful backfill result */
function makeBackfillResult(pushed = 0) {
  return {
    success: true as const,
    data: {
      mode: 'backfill' as const,
      dryRun: false,
      totalEvents: pushed,
      pushed,
      failed: 0,
      skipped: 0,
      breakdown: {
        sprints: 0,
        missions: 0,
        sessions: 0,
        decisions: 0,
        learnings: 0,
        dependencies: 0,
      },
      cursor: pushed > 0 ? '2026-03-13T00:00:00.000Z' : null,
      previousCursor: null,
      message: 'Backfill complete',
      deduped: 0,
    },
  };
}

/** Helper: create a standard successful file sync result */
function makeSyncResult() {
  return {
    success: true as const,
    data: {
      success: true,
      counts: { sprints: 1, missions: 2 },
      errors: [] as string[],
      durationMs: 50,
    },
  };
}

describe('checkpoint-backfill', () => {
  const originalUrl = process.env.CMOS_DASHBOARD_URL;
  const originalApiKey = process.env.CMOS_DASHBOARD_API_KEY;
  const originalUser = process.env.CMOS_DASHBOARD_USER;
  const originalPassword = process.env.CMOS_DASHBOARD_PASSWORD;

  let mockSyncSqliteFile: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CMOS_DASHBOARD_URL = 'http://localhost:3000';
    process.env.CMOS_DASHBOARD_USER = 'test@example.com';
    process.env.CMOS_DASHBOARD_PASSWORD = 'test-password';
    delete process.env.CMOS_DASHBOARD_API_KEY;

    mockSyncSqliteFile = jest.fn<any>().mockResolvedValue(makeSyncResult());

    // Default: fromEnvForProject returns {client, keySource, matchedProjectRoot}
    mockFromEnvForProject.mockResolvedValue({
      success: true,
      data: {
        client: { syncSqliteFile: mockSyncSqliteFile } as any,
        keySource: 'user-scoped',
        matchedProjectRoot: null,
      },
    });

    // Default: withClientAsync resolves as already registered with a slug
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/cmos/db/cmos.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered'))
            return { success: true, data: { value: 'true' } };
          if (sql.includes('dashboard_slug'))
            return { success: true, data: { value: 'test-project' } };
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    };
    restore('CMOS_DASHBOARD_URL', originalUrl);
    restore('CMOS_DASHBOARD_API_KEY', originalApiKey);
    restore('CMOS_DASHBOARD_USER', originalUser);
    restore('CMOS_DASHBOARD_PASSWORD', originalPassword);
  });

  it('should trigger file sync for session complete (force: false)', async () => {
    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/cmos/db/cmos.sqlite',
      'test-project',
      undefined
    );
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it('should trigger file sync for sprint complete (force: true)', async () => {
    await triggerCheckpointBackfill({ force: true });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/cmos/db/cmos.sqlite',
      'test-project',
      undefined
    );
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it('should not fail when file sync fails', async () => {
    mockSyncSqliteFile.mockResolvedValueOnce({
      success: false,
      error: { code: 'DASHBOARD_UNREACHABLE', message: 'Connection refused' },
    });

    // Should not throw
    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalled();
  });

  it('should not fail when file sync throws', async () => {
    mockSyncSqliteFile.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw
    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalled();
  });

  // Sprint 62 m02: URL has a baked default — the gate is now credentials-only.
  // Without auth there's nothing to push, so backfill silently skips.
  it('should skip sync when no credentials are configured', async () => {
    delete process.env.CMOS_DASHBOARD_API_KEY;
    delete process.env.CMOS_DASHBOARD_USER;
    delete process.env.CMOS_DASHBOARD_PASSWORD;

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it('should pass projectRoot to withClientAsync', async () => {
    await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockWithClientAsync).toHaveBeenCalledWith(expect.any(Function), {
      projectRoot: '/tmp/test',
    });
  });

  it('should trigger file sync when API key is configured (no user/password)', async () => {
    process.env.CMOS_DASHBOARD_API_KEY = 'cmk_test-key-123';
    delete process.env.CMOS_DASHBOARD_USER;
    delete process.env.CMOS_DASHBOARD_PASSWORD;

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalled();
  });

  it('should skip sync when URL is set but no auth is configured', async () => {
    delete process.env.CMOS_DASHBOARD_API_KEY;
    delete process.env.CMOS_DASHBOARD_USER;
    delete process.env.CMOS_DASHBOARD_PASSWORD;

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it('should fall back to event-replay backfill when no project slug', async () => {
    // Override: registered but no slug available
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/cmos/db/cmos.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered'))
            return { success: true, data: { value: 'true' } };
          if (sql.includes('dashboard_slug')) return { success: true, data: null }; // No slug
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    mockBackfill.mockResolvedValueOnce(makeBackfillResult(5));

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).toHaveBeenCalledWith({
      projectRoot: undefined,
      force: false,
      dryRun: false,
    });
  });

  it('should skip when fromEnvForProject fails', async () => {
    mockFromEnvForProject.mockResolvedValue({
      success: false,
      error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'Missing credentials' },
    });

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
  });
});

// ─── Auto-Registration Tests ────────────────────────────────────────────────

describe('checkpoint-backfill auto-registration', () => {
  const originalUrl = process.env.CMOS_DASHBOARD_URL;
  const originalApiKey = process.env.CMOS_DASHBOARD_API_KEY;
  const originalUser = process.env.CMOS_DASHBOARD_USER;
  const originalPassword = process.env.CMOS_DASHBOARD_PASSWORD;

  let mockSyncSqliteFile: jest.MockedFunction<any>;
  let mockRegister: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CMOS_DASHBOARD_URL = 'http://localhost:3000';
    process.env.CMOS_DASHBOARD_API_KEY = 'cmk_test-key';
    delete process.env.CMOS_DASHBOARD_USER;
    delete process.env.CMOS_DASHBOARD_PASSWORD;

    mockSyncSqliteFile = jest.fn<any>().mockResolvedValue({
      success: true,
      data: { success: true, counts: {}, errors: [], durationMs: 50 },
    });
    mockRegister = jest.fn<any>();

    // Default fromEnvForProject — client includes both methods; individual tests override as needed
    mockFromEnvForProject.mockResolvedValue({
      success: true,
      data: {
        client: {
          registerProject: mockRegister,
          syncSqliteFile: mockSyncSqliteFile,
          authenticatingKeyId: 'user-key-id-1',
        } as any,
        keySource: 'user-scoped',
        matchedProjectRoot: null,
      },
    });

    mockBackfill.mockResolvedValue(makeBackfillResult(0));
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    };
    restore('CMOS_DASHBOARD_URL', originalUrl);
    restore('CMOS_DASHBOARD_API_KEY', originalApiKey);
    restore('CMOS_DASHBOARD_USER', originalUser);
    restore('CMOS_DASHBOARD_PASSWORD', originalPassword);
  });

  it('should skip registration when dashboard_registered is true', async () => {
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/cmos/db/cmos.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered'))
            return { success: true, data: { value: 'true' } };
          if (sql.includes('dashboard_slug'))
            return { success: true, data: { value: 'my-project' } };
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // Registration skipped — registerProject not called
    expect(mockRegister).not.toHaveBeenCalled();
    // File sync runs using existing slug
    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/cmos/db/cmos.sqlite',
      'my-project',
      undefined
    );
  });

  it('should auto-register when dashboard_registered is not set', async () => {
    mockRegister.mockResolvedValue({
      success: true,
      data: {
        slug: 'my-project',
        projectId: 'proj-uuid',
        reregistered: false,
        backfill: { counts: { sprints: 5 } },
      },
    });

    const mockExecute = jest.fn().mockReturnValue({ success: true });

    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/cmos/db/cmos.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) {
            return { success: true, data: null }; // Not registered
          }
          if (sql.includes('project_name')) {
            return { success: true, data: { value: 'My Project' } };
          }
          return { success: true, data: null };
        }),
        execute: mockExecute,
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // Should have called registerProject
    expect(mockRegister).toHaveBeenCalledWith({
      projectName: 'My Project',
      sqlitePath: '/tmp/test/cmos/db/cmos.sqlite',
      localDbPath: '/tmp/test/cmos/db/cmos.sqlite',
      expectedSlug: 'my-project',
    });

    // Should have stored registration metadata
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('dashboard_registered'));
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('dashboard_slug'), [
      'my-project',
    ]);
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('dashboard_project_id'), [
      'proj-uuid',
    ]);

    // Should run file sync after registration
    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/cmos/db/cmos.sqlite',
      'my-project',
      'my-project'
    );
  });

  it('should pass expectedSlug into file sync when project is already registered', async () => {
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/cmos/db/cmos.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered'))
            return { success: true, data: { value: 'true' } };
          if (sql.includes('dashboard_slug'))
            return { success: true, data: { value: 'my-project' } };
          if (sql.includes('project_name')) return { success: true, data: { value: 'My Project' } };
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/cmos/db/cmos.sqlite',
      'my-project',
      'my-project'
    );
  });

  it('should not fall back to file sync when the expected slug guard rejects registration', async () => {
    mockRegister.mockResolvedValue({
      success: false,
      error: { code: 'EXPECTED_SLUG_MISMATCH', message: 'slug mismatch' },
    });

    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/cmos/db/cmos.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) return { success: true, data: null };
          if (sql.includes('project_name')) return { success: true, data: { value: 'My Project' } };
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSlug: 'my-project' })
    );
    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).toHaveBeenCalled();
  });

  it('should skip registration when project name is empty', async () => {
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/cmos/db/cmos.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) {
            return { success: true, data: null };
          }
          if (sql.includes('project_name')) {
            return { success: true, data: { value: '' } };
          }
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // Should not try to register
    expect(mockRegister).not.toHaveBeenCalled();
    // No slug — falls back to event-replay
    expect(mockBackfill).toHaveBeenCalled();
    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
  });

  it('should fall back to event-replay when registration fails', async () => {
    mockRegister.mockResolvedValue({
      success: false,
      error: { code: 'DASHBOARD_UNREACHABLE', message: 'Connection refused' },
    });

    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/cmos/db/cmos.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) {
            return { success: true, data: null };
          }
          if (sql.includes('project_name')) {
            return { success: true, data: { value: 'My Project' } };
          }
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // Registration was attempted
    expect(mockRegister).toHaveBeenCalled();
    // No slug from failed registration — falls back to event-replay
    expect(mockBackfill).toHaveBeenCalled();
    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
  });

  it('should fall back to event-replay when withClientAsync throws', async () => {
    mockWithClientAsync.mockRejectedValue(new Error('DB connection failed'));

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // checkAndRegister returned null — falls back to event-replay
    expect(mockBackfill).toHaveBeenCalled();
    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
  });

  it('should be idempotent — second checkpoint skips registration', async () => {
    mockRegister.mockResolvedValue({
      success: true,
      data: {
        slug: 'my-project',
        projectId: 'proj-uuid',
        reregistered: false,
        backfill: { counts: {} },
      },
    });

    let registered = false;
    const mockExecute = jest.fn().mockImplementation((sql: any) => {
      if (sql.includes("'dashboard_registered', 'true'")) {
        registered = true;
      }
      return { success: true };
    });

    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/cmos/db/cmos.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) {
            return {
              success: true,
              data: registered ? { value: 'true' } : null,
            };
          }
          if (sql.includes('dashboard_slug')) {
            return {
              success: true,
              data: registered ? { value: 'my-project' } : null,
            };
          }
          if (sql.includes('project_name')) {
            return { success: true, data: { value: 'My Project' } };
          }
          return { success: true, data: null };
        }),
        execute: mockExecute,
      };
      return fn(mockClient as any);
    });

    // First checkpoint — should register
    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockSyncSqliteFile).toHaveBeenCalledTimes(1);

    // Second checkpoint — should skip registration
    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRegister).toHaveBeenCalledTimes(1); // Still 1 — not called again
    expect(mockSyncSqliteFile).toHaveBeenCalledTimes(2); // Called again for sync
  });

  // Sprint 70 m04: device-code-only auth now PROCEEDS through the gate (the fix
  // for #303/#701). A resolvable user-scoped key in the CredentialStore counts as
  // sufficient even when the env vars are unset; the genuinely-unauthenticated
  // case still fails closed; and the obsolete s67-m04 silent-skip WARN is gone.
  describe('device-code checkpoint-sync gate (s70-m04)', () => {
    const { CredentialStore } = jest.requireActual<
      typeof import('../../../src/intelligence/credential-store')
    >('../../../src/intelligence/credential-store');

    const fs = jest.requireActual<typeof import('fs')>('fs');
    const os = jest.requireActual<typeof import('os')>('os');
    const path = jest.requireActual<typeof import('path')>('path');

    let configDir: string;
    let mockSync: jest.MockedFunction<any>;
    let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;

    async function seedUserScopedKey(key = 'cmk_devicecode'): Promise<void> {
      const store = CredentialStore.getInstance();
      await store.upsertUserScopedKey('keyId-1', {
        key,
        label: 'device: test',
        issuedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
    }

    beforeEach(() => {
      jest.clearAllMocks();
      // Device-code-only context: no env auth at all.
      process.env.CMOS_DASHBOARD_URL = 'http://localhost:3000';
      delete process.env.CMOS_DASHBOARD_API_KEY;
      delete process.env.CMOS_DASHBOARD_USER;
      delete process.env.CMOS_DASHBOARD_PASSWORD;

      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-devicecode-test-'));
      CredentialStore.resetInstance();
      CredentialStore.getInstance({ configDir });

      mockSync = jest.fn<any>().mockResolvedValue(makeSyncResult());
      mockFromEnvForProject.mockResolvedValue({
        success: true,
        data: {
          client: { syncSqliteFile: mockSync } as any,
          keySource: 'user-scoped',
          matchedProjectRoot: null,
        },
      });
      // Registered with a slug so the primary file-sync path runs.
      mockWithClientAsync.mockImplementation(async (fn) => {
        const mockClient = {
          path: '/tmp/test/cmos/db/cmos.sqlite',
          getOne: jest.fn().mockImplementation((sql: any) => {
            if (sql.includes('dashboard_registered'))
              return { success: true, data: { value: 'true' } };
            if (sql.includes('dashboard_slug'))
              return { success: true, data: { value: 'test-project' } };
            return { success: true, data: null };
          }),
          execute: jest.fn().mockReturnValue({ success: true }),
        };
        return fn(mockClient as any);
      });

      stderrSpy = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true) as unknown as jest.SpiedFunction<
        typeof process.stderr.write
      >;
    });

    afterEach(() => {
      stderrSpy.mockRestore();
      CredentialStore.resetInstance();
      fs.rmSync(configDir, { recursive: true, force: true });
    });

    it('PROCEEDS for device-code-only auth (resolvable user-scoped key, env unset)', async () => {
      await seedUserScopedKey();

      await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });
      expect(mockFromEnvForProject).toHaveBeenCalled();
      expect(mockSync).toHaveBeenCalledWith(
        '/tmp/test/cmos/db/cmos.sqlite',
        'test-project',
        undefined
      );
    });

    it('still fails closed when there is no credential by any path (no env, no user-scoped key)', async () => {
      // CredentialStore is empty; env is unset.
      await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });
      expect(mockFromEnvForProject).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
      expect(mockBackfill).not.toHaveBeenCalled();
    });

    it('does NOT open the gate on mere store-file presence with no resolvable key', async () => {
      // A user-scoped record whose key is empty is NOT resolvable (RISK guard:
      // do not open wider than device-code auth on file presence alone).
      await seedUserScopedKey('');

      await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });
      expect(mockFromEnvForProject).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
    });

    it('emits no silent-skip WARN on the now-supported device-code path', async () => {
      await seedUserScopedKey();

      await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });
      const warns = stderrSpy.mock.calls
        .map((args: unknown[]) => String(args[0]))
        .filter((s) => /skipped|silently/i.test(s));
      expect(warns).toHaveLength(0);
    });
  });
});
