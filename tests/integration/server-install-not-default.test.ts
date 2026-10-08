// ABOUTME: Integration coverage for s92-m01 fork 1 and critic B1: the install root resolves to its
// ABOUTME: own store by cwd, and a dormant pre-3.2.0 registry default never captures a call.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { resolveSenderContext } from '../../src/intelligence/sender-context';
import { createSeededCmosProject, type SeededCmosProject } from '../helpers/seedCmosDb';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * The owner's real topology (critic B1): every MCP entry launches this repository's dist, so the
 * install root IS a CMOS store; and the registry carries a dormant default (`forge`) written long
 * before 3.2.0. A design that defaulted every "contextless" call would have woken that default for
 * calls made from this repository. These tests pin that it does not.
 */
describe('server install root and the dormant registry default (critic B1)', () => {
  let configDir: string;
  let installRepo: SeededCmosProject;
  let forge: SeededCmosProject;
  let registry: ProjectGraphRegistry;

  beforeEach(async () => {
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    configDir = await makeTempDir('server-install-cfg-');
    registry = await ProjectGraphRegistry.create({ configDir });
    installRepo = await createSeededCmosProject(
      {
        projectName: 'CMOS-MCP Pro',
        projectId: 'cmos-mcp-pro',
        slug: 'cmos-mcp-pro',
        dashboardProjectId: '09fb9553-6413-479a-8a5c-af6a9d949ae6',
        cmosAddress: 'cmos://derek/cmos-mcp-pro',
      },
      'server-install-repo-'
    );
    forge = await createSeededCmosProject(
      {
        projectName: 'Forge',
        projectId: 'forge',
        slug: 'forge',
        dashboardProjectId: 'deadbeef-1234-4abc-89ef-0123456789ab',
        cmosAddress: 'cmos://derek/forge',
      },
      'server-install-forge-'
    );
    registry.registerStore(installRepo.projectRoot);
    registry.registerStore(forge.projectRoot);
    // The dormant default: written the pre-3.2.0 way, never confirmed.
    registry.setDefault(registry.getByStorePath(forge.projectRoot)!);
  });

  afterEach(async () => {
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    await installRepo.cleanup();
    await forge.cleanup();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('resolves a call made from the install root to the install root, never the default', async () => {
    for (const requireSenderIdentity of [false, true]) {
      const ctx = await resolveSenderContext({
        cwdOverride: installRepo.projectRoot,
        serverInstallRootOverride: installRepo.projectRoot,
        registryOverride: registry,
        serverProjectRootOverride: null,
        requireSenderIdentity,
      });
      expect(ctx.source).toBe('cwd');
      expect(ctx.projectRoot).toBe(path.resolve(installRepo.projectRoot));
    }
  });

  it('refuses a contextless call rather than waking the unconfirmed default', async () => {
    const fakeHome = await makeTempDir('server-install-home-');
    try {
      for (const cwd of ['/', fakeHome]) {
        await expect(
          resolveSenderContext({
            cwdOverride: cwd,
            homeDirOverride: fakeHome,
            serverInstallRootOverride: installRepo.projectRoot,
            registryOverride: registry,
            serverProjectRootOverride: null,
            requireSenderIdentity: false,
          })
        ).rejects.toMatchObject({
          outcome: 'contextless-no-default',
          unappliedDefault: expect.objectContaining({ name: 'Forge' }),
        });
      }
    } finally {
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });
});
