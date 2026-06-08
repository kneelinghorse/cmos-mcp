// ABOUTME: Unit tests for project-key capture + recover — Sprint 57 m02 + Sprint 58 m03 live blocks.
// ABOUTME: Covers first-time register capture, idempotent re-register, /reissue recovery, missing parent key.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { captureRegisterResponse, recoverProjectKey } from '../../src/auth/project-key-capture';
import { CMOS_CONFIG_DIR_ENV, CredentialStore } from '../../src/intelligence/credential-store';
import type { ProjectKeyRecord } from '../../src/intelligence/credential-store';
import {
  DashboardClient,
  type RegisterProjectResult,
  type ReissueProjectKeyResult,
} from '../../src/tools/cmos/dashboard-client';
import type { CmosToolResult } from '../../src/tools/cmos/types';
import { runDeviceCodeFlow } from '../../src/auth/device-code';
import {
  describeLive,
  setUpLiveConfig,
  tearDownLiveConfig,
  type LiveDashboardConfig,
} from './live-dashboard-helper';

function successResponse(base: Partial<RegisterProjectResult> = {}): RegisterProjectResult {
  return {
    slug: 'my-project',
    projectId: 'proj-123',
    reregistered: false,
    backfill: { counts: {} },
    key: 'cmk_project_new',
    keyId: 'project-key-id-1',
    label: 'auto: registered 2026-04-17T12:00:00Z',
    ...base,
  };
}

describe('captureRegisterResponse', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-'));
    delete process.env[CMOS_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes a project-scoped record on first-time register with key fields', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'my-project');

    const status = await captureRegisterResponse({
      projectRoot,
      response: successResponse(),
      parentKeyId: 'user-key-abc',
      store,
    });

    expect(status).toBe('captured');
    const persisted = await store.getProjectKey(projectRoot);
    expect(persisted).toMatchObject({
      key: 'cmk_project_new',
      keyId: 'project-key-id-1',
      parentKeyId: 'user-key-abc',
      label: 'auto: registered 2026-04-17T12:00:00Z',
    });
    expect(persisted?.issuedAt).toBeTruthy();
    expect(persisted?.lastUsedAt).toBeTruthy();
  });

  it('is a no-op on idempotent re-register (keyRotated=false)', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'existing');

    // Seed an existing record to confirm the no-op leaves it untouched.
    const seed: ProjectKeyRecord = {
      key: 'cmk_seed',
      keyId: 'seed-id',
      parentKeyId: 'seed-parent',
      label: 'seed',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    await store.upsertProjectKey(projectRoot, seed);

    const status = await captureRegisterResponse({
      projectRoot,
      response: {
        slug: 'existing',
        projectId: 'proj-existing',
        reregistered: true,
        backfill: { counts: {} },
        keyRotated: false,
      },
      parentKeyId: 'user-key-abc',
      store,
    });

    expect(status).toBe('reregistration-noop');
    expect(await store.getProjectKey(projectRoot)).toEqual(seed);
  });

  it('returns "missing-parent-key-id" and writes nothing when the client has no authenticatingKeyId', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'orphan-attribution');

    const status = await captureRegisterResponse({
      projectRoot,
      response: successResponse(),
      parentKeyId: undefined,
      store,
    });

    expect(status).toBe('missing-parent-key-id');
    expect(await store.getProjectKey(projectRoot)).toBeUndefined();
  });

  it('returns "no-key-in-response" when the dashboard response omits key/keyId', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'no-key');

    const status = await captureRegisterResponse({
      projectRoot,
      response: {
        slug: 'x',
        projectId: 'p',
        reregistered: false,
        backfill: { counts: {} },
      },
      parentKeyId: 'user-key-abc',
      store,
    });

    expect(status).toBe('no-key-in-response');
    expect(await store.getProjectKey(projectRoot)).toBeUndefined();
  });
});

describe('recoverProjectKey', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recover-'));
    delete process.env[CMOS_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function mockClient(
    options: {
      reissue?: CmosToolResult<ReissueProjectKeyResult>;
      authenticatingKeyId?: string;
    } = {}
  ): DashboardClient {
    const stub = {
      authenticatingKeyId: options.authenticatingKeyId,
      reissueProjectKey: async (_projectId: string) => {
        if (!options.reissue) {
          return {
            success: true,
            data: {
              key: 'cmk_reissued',
              keyId: 'reissued-key-id',
              label: 'reissued',
              revokedKeyIds: ['orphan-key-id'],
            },
          } as CmosToolResult<ReissueProjectKeyResult>;
        }
        return options.reissue;
      },
    };
    return stub as unknown as DashboardClient;
  }

  it('calls /reissue and writes the returned key when no local project key exists', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'missing');
    const client = mockClient({ authenticatingKeyId: 'user-parent-1' });

    const result = await recoverProjectKey({
      projectRoot,
      projectId: 'dashboard-project-id-1',
      client,
      store,
    });

    expect(result.kind).toBe('recovered');
    const persisted = await store.getProjectKey(projectRoot);
    expect(persisted?.key).toBe('cmk_reissued');
    expect(persisted?.parentKeyId).toBe('user-parent-1');
  });

  it('is a no-op when a project key already exists locally', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'already-present');

    const existing: ProjectKeyRecord = {
      key: 'cmk_existing',
      keyId: 'existing-id',
      parentKeyId: 'user-parent-1',
      label: 'existing',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    await store.upsertProjectKey(projectRoot, existing);

    const client = mockClient({ authenticatingKeyId: 'user-parent-1' });
    const result = await recoverProjectKey({
      projectRoot,
      projectId: 'dashboard-project-id-1',
      client,
      store,
    });

    expect(result.kind).toBe('no-op-already-present');
    expect(await store.getProjectKey(projectRoot)).toEqual(existing);
  });

  it('returns missing-parent-key-id when the client has no authenticatingKeyId', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'orphan');
    const client = mockClient({ authenticatingKeyId: undefined });

    const result = await recoverProjectKey({
      projectRoot,
      projectId: 'p',
      client,
      store,
    });

    expect(result.kind).toBe('missing-parent-key-id');
    expect(await store.getProjectKey(projectRoot)).toBeUndefined();
  });

  it('surfaces reissue-failed when the dashboard returns an error', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'rq');
    const client = mockClient({
      authenticatingKeyId: 'user-parent-1',
      reissue: {
        success: false,
        error: { code: 'DASHBOARD_ERROR', message: 'upstream 500' },
      } as CmosToolResult<ReissueProjectKeyResult>,
    });

    const result = await recoverProjectKey({
      projectRoot,
      projectId: 'p',
      client,
      store,
    });

    expect(result.kind).toBe('reissue-failed');
    if (result.kind === 'reissue-failed') {
      expect(result.error).toContain('upstream 500');
    }
    expect(await store.getProjectKey(projectRoot)).toBeUndefined();
  });
});

// ─── Live dashboard (Sprint 58 m03) ───────────────────────────────────────
//
// Requires:
//   CMOS_LIVE_DASHBOARD=1
//   CMOS_DASHBOARD_URL=https://cmos.aquex.ai
//   CMOS_LIVE_PROJECT_ID=<existing registered project UUID on the dashboard>
//
// Exercises `/api/projects/:id/keys/reissue` end-to-end via `recoverProjectKey`.
// Must run after a successful device-code login in the same tmpdir so the
// dashboard client has a real user-scoped credential to authenticate with.
//
// Register auto-issue (`captureRegisterResponse` against a fresh registration)
// is NOT covered by this block: registration requires uploading a SQLite file
// and the dashboard rejects second-time registrations with a different shape.
// The reissue path exercises the same response envelope `{key, keyId, label}`
// so contract drift in captureRegisterResponse surfaces here as well.

describeLive('project key capture — live dashboard', () => {
  let config: LiveDashboardConfig;
  let store: CredentialStore;

  beforeEach(async () => {
    config = await setUpLiveConfig('project-key-capture');
    CredentialStore.resetInstance();
    store = await CredentialStore.create({ configDir: config.tempConfigDir });
  });

  afterEach(async () => {
    CredentialStore.resetInstance();
    await tearDownLiveConfig(config);
  });

  it(
    'reissues a real project-scoped key and persists it locally',
    async () => {
      const projectId = process.env.CMOS_LIVE_PROJECT_ID;
      if (!projectId) {
        throw new Error(
          'CMOS_LIVE_PROJECT_ID is required for the project-key-capture live block ' +
            '(set it to the UUID of an existing registered dashboard project).'
        );
      }

      // Mint a user-scoped key first — recoverProjectKey needs an authenticated client.
      const userToken = await runDeviceCodeFlow({
        baseUrl: config.baseUrl,
        credentialStore: store,
      });
      expect(userToken.keyId).toBeTruthy();

      const clientResult = await DashboardClient.fromEnvForProject(undefined, {
        baseUrl: config.baseUrl,
        credentialStore: store,
      });
      expect(clientResult.success).toBe(true);
      if (!clientResult.success || !clientResult.data) return;

      const projectRoot = path.join(config.tempConfigDir, 'live-project');
      const result = await recoverProjectKey({
        projectRoot,
        projectId,
        client: clientResult.data.client,
        store,
      });

      // Surface the actual dashboard error on failure — we need it to tell
      // contract drift apart from transient failures or ownership issues.
      if (result.kind !== 'recovered') {
        // eslint-disable-next-line no-console
        console.error(
          `[live] reissue did not recover: kind=${result.kind}` +
            ('error' in result ? ` error=${result.error}` : '')
        );
      }

      expect(result.kind).toBe('recovered');
      if (result.kind === 'recovered') {
        expect(result.record.key).toMatch(/^cmk_/);
        expect(result.record.keyId).toBeTruthy();
        expect(result.record.parentKeyId).toBe(userToken.keyId);
      }

      const persisted = await store.getProjectKey(projectRoot);
      expect(persisted?.key).toMatch(/^cmk_/);
    },
    10 * 60 * 1000
  );
});
