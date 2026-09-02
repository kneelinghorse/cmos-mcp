// ABOUTME: Integration coverage for fail-closed sender resolution at the dispatcher boundary.
// ABOUTME: Verifies unresolved cmos_message sends never create a dashboard client or HTTP side effects.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../src/tools/cmos/dashboard-client', () => {
  const actual = jest.requireActual(
    '../../src/tools/cmos/dashboard-client'
  ) as typeof import('../../src/tools/cmos/dashboard-client');

  return {
    ...actual,
    DashboardClient: {
      ...actual.DashboardClient,
      fromEnv: jest.fn(),
    },
  };
});

import { executeMissionProtocolTool } from '../../src/index';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { DashboardClient } from '../../src/tools/cmos/dashboard-client';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('dispatcher fail-closed behavior', () => {
  let emptyWorkspace: string;
  let configDir: string;
  const originalCwd = process.cwd;

  beforeEach(async () => {
    jest.clearAllMocks();
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    emptyWorkspace = await makeTempDir('fail-closed-empty-');
    configDir = await makeTempDir('fail-closed-cfg-');
    await ProjectGraphRegistry.create({ configDir });
    process.cwd = () => emptyWorkspace;
    delete process.env['CMOS_PROJECT_ROOT'];
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    await Promise.all([
      fs.rm(emptyWorkspace, { recursive: true, force: true }),
      fs.rm(configDir, { recursive: true, force: true }),
    ]);
  });

  it('returns a classified refusal before any dashboard HTTP client is created', async () => {
    const result = await executeMissionProtocolTool(
      'cmos_message',
      {
        action: 'send',
        targetAddress: 'cmos://derek/cmos-dashboard',
        type: 'question',
        summary: 'Should never send',
      },
      {} as never
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      error: { code: 'CMOS_NOT_DETECTED' },
    });
    expect(JSON.stringify(result)).not.toContain('correlationId');

    expect(DashboardClient.fromEnv).not.toHaveBeenCalled();
  });
});
