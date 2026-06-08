// ABOUTME: Real-DB regression coverage for sender attribution across sibling CMOS projects.
// ABOUTME: Verifies cmos_message matches the local cmos_address to the correct dashboard project.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createSeededCmosProject, type SeededCmosProject } from '../helpers/seedCmosDb';

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

import { cmosMessage } from '../../src/tools/cmos/cmos-message';
import { DashboardClient } from '../../src/tools/cmos/dashboard-client';
import { createSuccess } from '../../src/tools/cmos/errors';

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
  client.getMyProjects.mockResolvedValue(
    createSuccess({
      projects: [
        {
          id: '96ce2349-b7e7-45b1-99e3-23277db407f5',
          name: 'parts-town',
          address: 'cmos://derek/parts-town',
          owner: 'derek',
        },
        {
          id: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
          name: 'cmos-mcp',
          address: 'cmos://derek/cmos-mcp',
          owner: 'derek',
        },
        {
          id: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
          name: 'stage1',
          address: 'cmos://derek/stage1',
          owner: 'derek',
        },
      ],
      totalCount: 3,
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

describe('multi-project attribution', () => {
  let cmosMcpProject: SeededCmosProject;
  let stage1Project: SeededCmosProject;

  beforeEach(async () => {
    jest.clearAllMocks();
    cmosMcpProject = await createSeededCmosProject(
      {
        projectName: 'CMOS MCP',
        projectId: 'cmos-mcp',
        slug: 'cmos-mcp',
        dashboardProjectId: null,
        cmosAddress: 'cmos://derek/cmos-mcp',
      },
      'multi-project-cmos-mcp-'
    );
    stage1Project = await createSeededCmosProject(
      {
        projectName: 'Stage1',
        projectId: 'stage1',
        slug: 'stage1',
        dashboardProjectId: null,
        cmosAddress: 'cmos://derek/stage1',
      },
      'multi-project-stage1-'
    );
  });

  afterEach(async () => {
    await Promise.all([cmosMcpProject.cleanup(), stage1Project.cleanup()]);
  });

  it('different real DBs resolve different senderProjectIds against the same dashboard directory', async () => {
    const client = createMockDashboardClient();
    const createdAt = new Date(Date.now() - 60_000).toISOString();

    client.sendMessage
      .mockResolvedValueOnce(
        createSuccess({
          id: 'msg-cmos-mcp',
          type: 'question',
          summary: 'First send',
          status: 'pending',
          createdAt,
        })
      )
      .mockResolvedValueOnce(
        createSuccess({
          id: 'msg-stage1',
          type: 'question',
          summary: 'Second send',
          status: 'pending',
          createdAt,
        })
      );

    await cmosMessage({
      action: 'send',
      projectRoot: cmosMcpProject.projectRoot,
      targetAddress: 'cmos://derek/oods-foundry',
      type: 'question',
      summary: 'First send',
    });
    await cmosMessage({
      action: 'send',
      projectRoot: stage1Project.projectRoot,
      targetAddress: 'cmos://derek/oods-foundry',
      type: 'question',
      summary: 'Second send',
    });

    expect(client.getMyProjects).toHaveBeenCalledTimes(2);
    expect(client.sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        senderProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
        senderAddress: 'cmos://derek/cmos-mcp',
      })
    );
    expect(client.sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        senderProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        senderAddress: 'cmos://derek/stage1',
      })
    );
  });
});
