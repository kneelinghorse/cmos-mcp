// ABOUTME: Exact regression coverage for the Sprint 53 P0 mis-attribution bug.
// ABOUTME: Verifies CMOS_PROJECT_ROOT can point at cmos-mcp while Stage1 sends still attribute as Stage1.

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
      fromEnvForProject: jest.fn(),
    },
  };
});

jest.mock('../../src/tools/cmos/owner-resolution', () => ({
  resolveAndPersistOwner: async () => ({ owner: null, source: 'unresolved' }),
}));

import { executeMissionProtocolTool } from '../../src/index';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectRegistry } from '../../src/intelligence/project-registry';
import { DashboardClient } from '../../src/tools/cmos/dashboard-client';
import { createSuccess } from '../../src/tools/cmos/errors';
import { createSeededCmosProject, type SeededCmosProject } from '../helpers/seedCmosDb';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<any>;

function createMockDashboardClient() {
  const client = {
    sendMessage: jest.fn() as AnyMock,
    listMessages: jest.fn() as AnyMock,
    respondToMessage: jest.fn() as AnyMock,
    resolveAddress: jest.fn() as AnyMock,
    listDirectory: jest.fn() as AnyMock,
    getMyProjects: jest.fn() as AnyMock,
  };

  client.resolveAddress.mockResolvedValue(
    createSuccess({ resolved: true, projectName: 'oods-foundry' })
  );
  client.sendMessage.mockResolvedValue(
    createSuccess({
      id: 'msg-stage1-regression',
      type: 'question',
      summary: 'Regression send',
      status: 'pending',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );

  (
    DashboardClient.fromEnvForProject as jest.MockedFunction<
      typeof DashboardClient.fromEnvForProject
    >
  ).mockResolvedValue(
    createSuccess({
      client: client as unknown as DashboardClient,
      keySource: 'user-scoped',
      matchedProjectRoot: null,
    })
  );

  return client;
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('P0 regression: Stage1 mis-attributed as cmos-mcp', () => {
  let cmosMcpProject: SeededCmosProject;
  let stage1Project: SeededCmosProject;
  let configDir: string;
  const originalCwd = process.cwd;
  const originalEnvProjectRoot = process.env['CMOS_PROJECT_ROOT'];

  beforeEach(async () => {
    jest.clearAllMocks();
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    cmosMcpProject = await createSeededCmosProject(
      {
        projectName: 'CMOS MCP',
        projectId: 'cmos-mcp',
        slug: 'cmos-mcp',
        dashboardProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
        cmosAddress: 'cmos://derek/cmos-mcp',
      },
      'p0-regression-cmos-mcp-'
    );
    stage1Project = await createSeededCmosProject(
      {
        projectName: 'Stage1',
        projectId: 'stage1',
        slug: 'stage1',
        dashboardProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        cmosAddress: 'cmos://derek/stage1',
      },
      'p0-regression-stage1-'
    );
    configDir = await makeTempDir('p0-regression-cfg-');
    await ProjectRegistry.create({ configDir });
    process.cwd = () => stage1Project.projectRoot;
    process.env['CMOS_PROJECT_ROOT'] = cmosMcpProject.projectRoot;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    if (originalEnvProjectRoot === undefined) {
      delete process.env['CMOS_PROJECT_ROOT'];
    } else {
      process.env['CMOS_PROJECT_ROOT'] = originalEnvProjectRoot;
    }
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    await Promise.all([
      cmosMcpProject.cleanup(),
      stage1Project.cleanup(),
      fs.rm(configDir, { recursive: true, force: true }),
    ]);
  });

  it('attributes the send to Stage1 even when CMOS_PROJECT_ROOT points at cmos-mcp', async () => {
    const client = createMockDashboardClient();

    const result = await executeMissionProtocolTool(
      'cmos_message',
      {
        action: 'send',
        targetAddress: 'cmos://derek/oods-foundry',
        type: 'question',
        summary: 'Regression send',
      },
      {} as never
    );

    expect(result.isError).toBe(false);
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        senderAddress: 'cmos://derek/stage1',
      })
    );
    expect(client.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        senderProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
      })
    );
  });
});
