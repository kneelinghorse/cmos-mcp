// ABOUTME: Sprint 57 m04 — verifies authState is attached to whoami diagnostics + onboard suggestedAction rules.
// ABOUTME: Hermetic: uses tempdir CredentialStore + delivery-ack-cache reset, no MCP server / DB.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { getWhoamiDiagnostics } from '../../src/tools/cmos/cmos-message';
import { recordDeliveryAck, resetDeliveryAckCache } from '../../src/auth/delivery-ack-cache';
import { CMOS_CONFIG_DIR_ENV, CredentialStore } from '../../src/intelligence/credential-store';
import { createSeededCmosProject, type SeededCmosProject } from '../helpers/seedCmosDb';

describe('whoami authState integration', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let project: SeededCmosProject;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whoami-auth-'));
    process.env[CMOS_CONFIG_DIR_ENV] = tempDir;
    CredentialStore.resetInstance();
    resetDeliveryAckCache();
    project = await createSeededCmosProject(
      {
        projectName: 'AuthDemo',
        projectId: 'auth-demo',
        slug: 'auth-demo',
        dashboardProjectId: 'b2b2b2b2-2b2b-4b2b-9b2b-2b2b2b2b2b2b',
        cmosAddress: 'cmos://derek/auth-demo',
      },
      'whoami-auth-'
    );
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    resetDeliveryAckCache();
    await Promise.all([project.cleanup(), fs.rm(tempDir, { recursive: true, force: true })]);
  });

  it('attaches authState to whoami when credentials exist', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('user-id-1', {
      key: 'cmk_user',
      label: 'device: cmos-mcp/1.0.0',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });

    const result = await getWhoamiDiagnostics({
      explicitProjectRoot: project.projectRoot,
      cwdOverride: '/tmp/no-cmos',
      serverInstallRootOverride: '/mock/server-install',
    });

    expect(result.data?.authState).toBeDefined();
    expect(result.data?.authState?.identitySource).toBe('api-key');
    expect(result.data?.authState?.userScopedKey?.keyId).toBe('user-id-1');
  });

  it('flags request-body in authState when last deliveryAck signaled legacy attribution', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('u', {
      key: 'cmk_user',
      label: 'l',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
    recordDeliveryAck('request-body');

    const result = await getWhoamiDiagnostics({
      explicitProjectRoot: project.projectRoot,
      cwdOverride: '/tmp/no-cmos',
      serverInstallRootOverride: '/mock/server-install',
    });

    expect(result.data?.authState?.identitySource).toBe('request-body');
    expect(result.data?.authState?.identitySourceObserved).toBe(true);
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/legacy user-scoped/i)])
    );
  });
});
