// ABOUTME: Exact regression coverage for the Sprint 53 P0 mis-attribution bug.
// ABOUTME: Verifies RBOOK_PROJECT_ROOT can point at cmos-mcp while Stage1 sends still attribute as Stage1.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../src/tools/rbook/dashboard-client', () => {
  const actual = jest.requireActual(
    '../../src/tools/rbook/dashboard-client'
  ) as typeof import('../../src/tools/rbook/dashboard-client');

  return {
    ...actual,
    DashboardClient: {
      ...actual.DashboardClient,
      fromEnvForProject: jest.fn(),
    },
  };
});

jest.mock('../../src/tools/rbook/owner-resolution', () => ({
  resolveAndPersistOwner: async () => ({ owner: null, source: 'unresolved' }),
}));

import { executeMissionProtocolTool } from '../../src/index';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { createSuccess } from '../../src/tools/rbook/errors';
import { createSeededRbookProject, type SeededRbookProject } from '../helpers/seedRbookDb';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

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
  let rbookMcpProject: SeededRbookProject;
  let stage1Project: SeededRbookProject;
  let configDir: string;
  const originalCwd = process.cwd;
  const originalEnvProjectRoot = process.env['RBOOK_PROJECT_ROOT'];

  beforeEach(async () => {
    jest.clearAllMocks();
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    rbookMcpProject = await createSeededRbookProject(
      {
        projectName: 'Reasonbook MCP',
        projectId: 'cmos-mcp',
        slug: 'cmos-mcp',
        dashboardProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
        rbookAddress: 'rbook://derek/cmos-mcp',
      },
      'p0-regression-cmos-mcp-'
    );
    stage1Project = await createSeededRbookProject(
      {
        projectName: 'Stage1',
        projectId: 'stage1',
        slug: 'stage1',
        dashboardProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        rbookAddress: 'rbook://derek/stage1',
      },
      'p0-regression-stage1-'
    );
    configDir = await makeTempDir('p0-regression-cfg-');
    await ProjectGraphRegistry.create({ configDir });
    process.cwd = () => stage1Project.projectRoot;
    process.env['RBOOK_PROJECT_ROOT'] = rbookMcpProject.projectRoot;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    if (originalEnvProjectRoot === undefined) {
      delete process.env['RBOOK_PROJECT_ROOT'];
    } else {
      process.env['RBOOK_PROJECT_ROOT'] = originalEnvProjectRoot;
    }
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    await Promise.all([
      rbookMcpProject.cleanup(),
      stage1Project.cleanup(),
      fs.rm(configDir, { recursive: true, force: true }),
    ]);
  });

  it('attributes the send to Stage1 even when RBOOK_PROJECT_ROOT points at cmos-mcp', async () => {
    const client = createMockDashboardClient();

    const result = await executeMissionProtocolTool(
      'rbook_message',
      {
        action: 'send',
        targetAddress: 'rbook://derek/oods-foundry',
        type: 'question',
        summary: 'Regression send',
      },
      {} as never
    );

    expect(result.isError).toBe(false);
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        senderAddress: 'rbook://derek/stage1',
      })
    );
    expect(client.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        senderProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
      })
    );
  });
});
