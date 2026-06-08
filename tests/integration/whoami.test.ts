// ABOUTME: Real-DB integration coverage for cmos_message(action="whoami") diagnostics.
// ABOUTME: Verifies candidate traces include rejected and accepted roots in precedence order.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { formatMessageForLLM, getWhoamiDiagnostics } from '../../src/tools/cmos/cmos-message';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { createSeededCmosProject, type SeededCmosProject } from '../helpers/seedCmosDb';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('whoami diagnostics', () => {
  let stage1Project: SeededCmosProject;
  let invalidRoot: string;

  beforeEach(async () => {
    CmosDetector.resetInstance();
    invalidRoot = await makeTempDir('whoami-invalid-');
    stage1Project = await createSeededCmosProject(
      {
        projectName: 'Stage1',
        projectId: 'stage1',
        slug: 'stage1',
        dashboardProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        cmosAddress: 'cmos://derek/stage1',
      },
      'whoami-stage1-'
    );
  });

  afterEach(async () => {
    CmosDetector.resetInstance();
    await Promise.all([
      fs.rm(invalidRoot, { recursive: true, force: true }),
      stage1Project.cleanup(),
    ]);
  });

  it('returns a full candidate trace showing rejected explicit root and accepted MCP root', async () => {
    const result = await getWhoamiDiagnostics({
      explicitProjectRoot: invalidRoot,
      mcpRoots: [stage1Project.projectRoot],
      cwdOverride: '/tmp/no-cmos-here',
      serverInstallRootOverride: '/mock/server-install',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      resolved: {
        projectRoot: path.resolve(stage1Project.projectRoot),
        source: 'mcp-roots',
        dashboardProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        cmosAddress: 'cmos://derek/stage1',
      },
    });
    expect(result.data?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'explicit',
          accepted: false,
          rejectReason: expect.stringMatching(/no CMOS database/i),
        }),
        expect.objectContaining({
          source: 'mcp-roots',
          accepted: true,
          projectRoot: path.resolve(stage1Project.projectRoot),
        }),
      ])
    );

    const formatted = formatMessageForLLM('whoami', result);
    expect(formatted).toContain('Candidate trace:');
    expect(formatted).toContain('✗ explicit');
    expect(formatted).toContain('✓ mcp-roots');
  });
});
