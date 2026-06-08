// ABOUTME: Unit tests for runStartupProjectKeyRecovery — Sprint 57 m02 startup hook.
// ABOUTME: Covers skipped/no-project, skipped/unregistered, skipped/already-present, recovered, reissue-failed.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { runStartupProjectKeyRecovery } from '../../src/auth/project-key-capture';
import { CMOS_CONFIG_DIR_ENV, CredentialStore } from '../../src/intelligence/credential-store';
import type { ProjectKeyRecord } from '../../src/intelligence/credential-store';
import type {
  DashboardClient,
  ReissueProjectKeyResult,
} from '../../src/tools/cmos/dashboard-client';
import type { CmosToolResult } from '../../src/tools/cmos/types';

function stubClient(
  options: {
    authenticatingKeyId?: string | undefined;
    reissue?: CmosToolResult<ReissueProjectKeyResult>;
  } = {}
): DashboardClient {
  const keyId = 'authenticatingKeyId' in options ? options.authenticatingKeyId : 'user-parent-1';
  return {
    authenticatingKeyId: keyId,
    reissueProjectKey: async () =>
      options.reissue ??
      ({
        success: true,
        data: {
          key: 'cmk_reissued',
          keyId: 'reissued-id',
          label: 'reissued-label',
          revokedKeyIds: [],
        },
      } as CmosToolResult<ReissueProjectKeyResult>),
  } as unknown as DashboardClient;
}

describe('runStartupProjectKeyRecovery', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-recovery-'));
    delete process.env[CMOS_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns skipped-no-project when no projectRoot is supplied', async () => {
    const result = await runStartupProjectKeyRecovery({});
    expect(result.status).toBe('skipped-no-project');
    expect(result.checked).toBe(false);
  });

  it('returns skipped-not-registered when the project has no dashboard registration', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const result = await runStartupProjectKeyRecovery({
      projectRoot: '/tmp/unregistered',
      metadataReader: async () => ({ registered: false, projectId: null }),
      clientFactory: async () => stubClient(),
      store,
    });
    expect(result.status).toBe('skipped-not-registered');
  });

  it('returns skipped-already-present when the credential store has a row for this root', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'already-present');
    const existing: ProjectKeyRecord = {
      key: 'cmk_here',
      keyId: 'here-id',
      parentKeyId: 'here-parent',
      label: 'here',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    await store.upsertProjectKey(projectRoot, existing);

    const result = await runStartupProjectKeyRecovery({
      projectRoot,
      metadataReader: async () => ({ registered: true, projectId: 'proj-id' }),
      clientFactory: async () => stubClient(),
      store,
    });
    expect(result.status).toBe('skipped-already-present');
  });

  it('returns skipped-unconfigured when no dashboard client can be built', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const result = await runStartupProjectKeyRecovery({
      projectRoot: path.join(tempDir, 'no-client'),
      metadataReader: async () => ({ registered: true, projectId: 'proj-id' }),
      clientFactory: async () => null,
      store,
    });
    expect(result.status).toBe('skipped-unconfigured');
  });

  it('returns recovered and writes a fresh project-scoped record when reissue succeeds', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'recover-me');

    const result = await runStartupProjectKeyRecovery({
      projectRoot,
      metadataReader: async () => ({ registered: true, projectId: 'proj-abc' }),
      clientFactory: async () => stubClient({ authenticatingKeyId: 'user-parent-1' }),
      store,
    });

    expect(result.status).toBe('recovered');
    const persisted = await store.getProjectKey(projectRoot);
    expect(persisted?.key).toBe('cmk_reissued');
    expect(persisted?.parentKeyId).toBe('user-parent-1');
  });

  it('returns error when reissue fails', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'error');

    const result = await runStartupProjectKeyRecovery({
      projectRoot,
      metadataReader: async () => ({ registered: true, projectId: 'proj-xyz' }),
      clientFactory: async () =>
        stubClient({
          authenticatingKeyId: 'user-parent-1',
          reissue: {
            success: false,
            error: { code: 'DASHBOARD_ERROR', message: 'upstream 500' },
          } as CmosToolResult<ReissueProjectKeyResult>,
        }),
      store,
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('upstream 500');
    expect(await store.getProjectKey(projectRoot)).toBeUndefined();
  });

  it('returns skipped-no-parent-key-id when the client has no authenticatingKeyId', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'no-parent');

    const result = await runStartupProjectKeyRecovery({
      projectRoot,
      metadataReader: async () => ({ registered: true, projectId: 'proj-p' }),
      clientFactory: async () => stubClient({ authenticatingKeyId: undefined }),
      store,
    });
    expect(result.status).toBe('skipped-no-parent-key-id');
  });
});
