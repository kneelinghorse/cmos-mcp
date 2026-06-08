// ABOUTME: Integration coverage for the cwd-vs-server-install sender guard.
// ABOUTME: Verifies the server's own install root is never auto-attributed as the implicit sender.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectRegistry } from '../../src/intelligence/project-registry';
import { resolveSenderContext } from '../../src/intelligence/sender-context';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('server install root guard', () => {
  let configDir: string;

  beforeEach(async () => {
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    configDir = await makeTempDir('server-install-cfg-');
    await ProjectRegistry.create({ configDir });
  });

  afterEach(async () => {
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('fails closed when cwd equals the server install root', async () => {
    const serverInstallRoot = await makeTempDir('server-install-root-');

    try {
      await expect(
        resolveSenderContext({
          cwdOverride: serverInstallRoot,
          serverInstallRootOverride: serverInstallRoot,
          requireSenderIdentity: true,
        })
      ).rejects.toMatchObject({
        code: 'SENDER_UNRESOLVABLE',
        candidates: expect.arrayContaining([
          expect.objectContaining({
            source: 'cwd',
            accepted: false,
            rejectReason: expect.stringContaining('cwd-vs-SERVER_INSTALL_ROOT guard'),
          }),
        ]),
      });
    } finally {
      await fs.rm(serverInstallRoot, { recursive: true, force: true });
    }
  });
});
