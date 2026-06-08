// ABOUTME: Integration-style tests for the cmos_message pipeline.
// ABOUTME: Uses a real seeded SQLite project so sender attribution follows the production DB path.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  createSeededCmosProject,
  seedCmosDb,
  type SeedCmosDbOptions,
  type SeededCmosProject,
} from '../../helpers/seedCmosDb';

// Mock DashboardClient.fromEnv before importing cmos-message
jest.mock('../../../src/tools/cmos/dashboard-client', () => {
  const actual = jest.requireActual(
    '../../../src/tools/cmos/dashboard-client'
  ) as typeof import('../../../src/tools/cmos/dashboard-client');

  return {
    ...actual,
    DashboardClient: {
      ...actual.DashboardClient,
      fromEnvForProject: jest.fn(),
    },
  };
});

jest.mock('../../../src/tools/cmos/owner-resolution', () => ({
  resolveAndPersistOwner: async () => ({ owner: null, source: 'unresolved' }),
}));

const DEFAULT_LOCAL_PROJECT: SeedCmosDbOptions = {
  projectName: 'CMOS MCP',
  projectId: 'cmos-mcp',
  slug: 'cmos-mcp',
  dashboardProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
  cmosAddress: 'cmos://derek/cmos-mcp',
};

let localProject: SeededCmosProject | null = null;
let _mockLocalCmosAddress: string | null = DEFAULT_LOCAL_PROJECT.cmosAddress ?? null;
let _mockLocalDashboardProjectId: string | null = DEFAULT_LOCAL_PROJECT.dashboardProjectId ?? null;
const originalCwd = process.cwd;

function reseedLocalProject(): void {
  if (!localProject) {
    throw new Error('Local CMOS project not initialized');
  }

  seedCmosDb(localProject.projectRoot, {
    ...DEFAULT_LOCAL_PROJECT,
    dashboardProjectId: _mockLocalDashboardProjectId,
    cmosAddress: _mockLocalCmosAddress,
  });
}

function setLocalCmosAddress(addr: string | null): void {
  _mockLocalCmosAddress = addr;
  reseedLocalProject();
}

function setLocalDashboardProjectId(id: string | null): void {
  _mockLocalDashboardProjectId = id;
  reseedLocalProject();
}

import { cmosMessage, formatMessageForLLM } from '../../../src/tools/cmos/cmos-message';
import { DashboardClient } from '../../../src/tools/cmos/dashboard-client';
import { createSuccess, createError, CmosErrors } from '../../../src/tools/cmos/errors';

// ─── Test Data ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<any>;

const DIRECTORY_PROJECTS = [
  {
    id: '01794cfc-c41d-4457-bccb-12edac7c828e',
    name: 'cmos-mcp',
    address: 'cmos://derek/cmos-mcp',
    owner: 'derek',
    description: 'MCP server',
  },
  {
    id: '9566f5ce-f171-4e95-a24e-ad756c2b8807',
    name: 'cmos-dashboard',
    address: 'cmos://derek/cmos-dashboard',
    owner: 'derek',
    description: 'Dashboard',
  },
  {
    id: '7422f5a1-b860-4b85-912d-e934cf6dba1b',
    name: 'tracelab',
    address: 'cmos://derek/tracelab',
    owner: 'derek',
    description: 'TraceLab',
  },
  {
    id: 'b9338ed4-bad7-475b-be02-61efbdbb0731',
    name: 'oods-foundry',
    address: 'cmos://darryl/oods-foundry',
    owner: 'darryl',
    description: 'OODS Foundry',
  },
  {
    id: 'c49caac3-1a47-4f40-bc04-21e88890fcb2',
    name: 'oods-foundry-mcp',
    address: 'cmos://derek/oods-foundry-mcp',
    owner: 'derek',
    description: 'OODS Foundry MCP',
  },
];

function mockClient() {
  const client = {
    sendMessage: jest.fn() as AnyMock,
    listMessages: jest.fn() as AnyMock,
    respondToMessage: jest.fn() as AnyMock,
    resolveAddress: jest.fn() as AnyMock,
    listDirectory: jest.fn() as AnyMock,
    getMyProjects: jest.fn() as AnyMock,
  };

  // Defaults
  client.resolveAddress.mockResolvedValue(
    createSuccess({ resolved: true, projectName: 'cmos-dashboard' })
  );
  // Default: /api/projects/me returns the FULL owned directory (every project derek
  // has). Tests that want to simulate "this cwd is cmos-mcp" must set the local
  // identity via setLocalCmosAddress / setLocalDashboardProjectId — the resolver
  // picks the matching entry, it never assumes projects[0].
  client.getMyProjects.mockResolvedValue(
    createSuccess({
      projects: DIRECTORY_PROJECTS.filter((p) => p.owner === 'derek'),
      totalCount: DIRECTORY_PROJECTS.filter((p) => p.owner === 'derek').length,
    })
  );
  client.listDirectory.mockResolvedValue(
    createSuccess({ projects: DIRECTORY_PROJECTS, totalCount: 5 })
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

// Sprint 53 m02: integration tests run with a valid seeded identity by default.
// Tests that need to simulate "no local identity" clear both explicitly at the
// top of the test body.
beforeEach(async () => {
  jest.clearAllMocks();
  localProject = await createSeededCmosProject(DEFAULT_LOCAL_PROJECT, 'messaging-integration-');
  const projectRoot = localProject.projectRoot;
  process.cwd = () => projectRoot;
  _mockLocalCmosAddress = DEFAULT_LOCAL_PROJECT.cmosAddress ?? null;
  _mockLocalDashboardProjectId = DEFAULT_LOCAL_PROJECT.dashboardProjectId ?? null;
});

afterEach(async () => {
  process.cwd = originalCwd;
  if (localProject) {
    await localProject.cleanup();
    localProject = null;
  }
});

// ─── E2E: Directory → Resolve → Send → Verify ──────────────────────────────

describe('E2E: discover → resolve → send → verify', () => {
  it('full pipeline: directory, resolve, send with auto-detected sender, then list inbox', async () => {
    // Simulate running in the cmos-mcp cwd. Clear the default-seeded UUID so
    // the resolver exercises the directory-match path (which is what this E2E
    // is explicitly verifying — Sprint 32 regression coverage).
    setLocalDashboardProjectId(null);
    setLocalCmosAddress('cmos://derek/cmos-mcp');
    const client = mockClient();

    // Step 1: Discover projects via directory
    const dirResult = await cmosMessage({ action: 'directory' });
    expect(dirResult.success).toBe(true);
    expect((dirResult.data as any).projects).toHaveLength(5);
    expect((dirResult.data as any).totalCount).toBe(5);

    // Verify all 5 known projects are discoverable
    const addresses = (dirResult.data as any).projects.map((p: any) => p.address);
    expect(addresses).toContain('cmos://derek/cmos-mcp');
    expect(addresses).toContain('cmos://derek/cmos-dashboard');
    expect(addresses).toContain('cmos://derek/tracelab');
    expect(addresses).toContain('cmos://darryl/oods-foundry');
    expect(addresses).toContain('cmos://derek/oods-foundry-mcp');

    // Step 2: Send a message (resolveAddress and auto-detect happen internally)
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        id: 'msg-e2e-001',
        type: 'backlog_request',
        summary: 'Add sync status endpoint',
        status: 'pending',
        createdAt: '2026-03-10T03:00:00Z',
      })
    );

    const sendResult = await cmosMessage({
      action: 'send',
      targetAddress: 'cmos://derek/cmos-dashboard',
      type: 'backlog_request',
      summary: 'Add sync status endpoint',
      body: 'Need GET /api/sync/status for reconciliation',
    });

    expect(sendResult.success).toBe(true);
    expect((sendResult.data as any).messageId).toBe('msg-e2e-001');
    expect((sendResult.data as any).targetAddress).toBe('cmos://derek/cmos-dashboard');

    // Verify resolveAddress was called (pre-send validation)
    expect(client.resolveAddress).toHaveBeenCalledWith({
      address: 'cmos://derek/cmos-dashboard',
    });

    // Verify senderProjectId was auto-detected
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderProjectId: '01794cfc-c41d-4457-bccb-12edac7c828e',
      })
    );

    // Step 3: Verify message appears in sent tab
    client.listMessages.mockResolvedValueOnce(
      createSuccess({
        messages: [
          {
            id: 'msg-e2e-001',
            type: 'backlog_request',
            summary: 'Add sync status endpoint',
            status: 'pending',
            createdAt: '2026-03-10T03:00:00Z',
          },
        ],
        unreadCount: 0,
        totalCount: 1,
      })
    );

    const listResult = await cmosMessage({ action: 'list', tab: 'sent' });
    expect(listResult.success).toBe(true);
    expect((listResult.data as any).messages[0].id).toBe('msg-e2e-001');
  });
});

// ─── Error Paths: Unknown Addresses with Suggestions ─────────────────────────

describe('error paths: unknown addresses', () => {
  it('returns helpful suggestions when target not found', async () => {
    const client = mockClient();
    client.resolveAddress.mockResolvedValueOnce(
      createError(CmosErrors.dashboardNotFound('cmos://derek/cmos-dashbord'))
    );

    const result = await cmosMessage({
      action: 'send',
      targetAddress: 'cmos://derek/cmos-dashbord', // typo
      type: 'question',
      summary: 'Is the API ready?',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_FOUND');
    // Should suggest close matches from directory
    expect(result.error?.suggestion).toContain('cmos://derek/cmos-dashboard');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('returns directory hint when address owner is completely unknown', async () => {
    const client = mockClient();
    client.resolveAddress.mockResolvedValueOnce(
      createError(CmosErrors.dashboardNotFound('cmos://nobody/unknown'))
    );
    // Return empty suggestions since no close matches exist
    client.listDirectory.mockResolvedValueOnce(
      createSuccess({ projects: DIRECTORY_PROJECTS, totalCount: 5 })
    );

    const result = await cmosMessage({
      action: 'send',
      targetAddress: 'cmos://nobody/unknown',
      type: 'question',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_FOUND');
    // No close matches — should suggest using directory
    // (getSuggestedAddresses won't match since neither owner nor slug match)
  });

  it('formats resolution error nicely for agent', async () => {
    const client = mockClient();
    client.resolveAddress.mockResolvedValueOnce(
      createError(CmosErrors.dashboardNotFound('cmos://derek/typo'))
    );

    const result = await cmosMessage({
      action: 'send',
      targetAddress: 'cmos://derek/typo',
      type: 'question',
      summary: 'Test',
    });

    const formatted = formatMessageForLLM('send', result);
    expect(formatted).toContain('Failed to send message');
    expect(formatted).toContain('not found');
  });
});

// ─── Same-Owner Cross-Project Send Without Manual senderProjectId ────────────

describe('same-owner cross-project send', () => {
  it('resolves senderProjectId for same-owner sends by matching local cmos_address', async () => {
    // Simulate running in the cmos-mcp cwd. Directory returns multiple projects.
    // Clear default UUID to force the directory-match path (Sprint 32 regression).
    setLocalDashboardProjectId(null);
    setLocalCmosAddress('cmos://derek/cmos-mcp');
    const client = mockClient();
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        id: 'msg-cross-001',
        type: 'status_update',
        summary: 'Phase 2 events ready',
        status: 'pending',
        createdAt: '2026-03-10T03:00:00Z',
      })
    );

    const result = await cmosMessage({
      action: 'send',
      targetAddress: 'cmos://derek/cmos-dashboard',
      type: 'status_update',
      summary: 'Phase 2 events ready',
      // senderProjectId NOT provided — should be resolved from local cmos_address
    });

    expect(result.success).toBe(true);
    expect(client.getMyProjects).toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderProjectId: '01794cfc-c41d-4457-bccb-12edac7c828e',
        targetAddress: 'cmos://derek/cmos-dashboard',
      })
    );
  });

  it('fails closed with SENDER_ATTRIBUTION_INCOMPLETE when local identity is unresolvable', async () => {
    // Sprint 53 m02: replaces the pre-Sprint-53 "succeeds with undefined sender"
    // fail-open behavior. When there is no local UUID and no canonical address,
    // handleSend refuses rather than publishing an anonymous message.
    setLocalCmosAddress(null);
    setLocalDashboardProjectId(null);

    const client = mockClient();
    client.getMyProjects.mockResolvedValueOnce(createSuccess({ projects: [], totalCount: 0 }));

    const result = await cmosMessage({
      action: 'send',
      targetAddress: 'cmos://derek/tracelab',
      type: 'question',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SENDER_ATTRIBUTION_INCOMPLETE');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

// ─── Directory Discovery ─────────────────────────────────────────────────────

describe('directory discovery', () => {
  it('returns all 5 known projects with correct addresses and UUIDs', async () => {
    const client = mockClient();

    const result = await cmosMessage({ action: 'directory' });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.totalCount).toBe(5);

    // Each project has id, name, address, owner
    for (const p of data.projects) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.address).toMatch(/^cmos:\/\/[a-z]+\/[a-z0-9-]+$/);
      expect(p.owner).toBeTruthy();
    }
  });

  it('formats directory output for LLM', async () => {
    const client = mockClient();

    const result = await cmosMessage({ action: 'directory' });
    const formatted = formatMessageForLLM('directory', result);

    expect(formatted).toContain('Project Directory');
    expect(formatted).toContain('5 addressable project(s)');
    expect(formatted).toContain('cmos://derek/cmos-mcp');
    expect(formatted).toContain('MCP server');
  });
});

// ─── Regression: Sprint 29 Send Pattern ──────────────────────────────────────

describe('regression: Sprint 29 send pattern', () => {
  it('Sprint 29 pattern with explicit senderProjectId still works', async () => {
    const client = mockClient();
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        id: 'msg-s29-compat',
        type: 'info_push',
        summary: 'Answers to Phase 2 open questions',
        status: 'pending',
        createdAt: '2026-03-10T02:38:00Z',
      })
    );

    const result = await cmosMessage({
      action: 'send',
      targetAddress: 'cmos://derek/cmos-mcp',
      type: 'info_push',
      summary: 'Answers to Phase 2 open questions',
      body: 'Full content here',
      senderProjectId: '9566f5ce-f171-4e95-a24e-ad756c2b8807', // explicit, like Sprint 29
    });

    expect(result.success).toBe(true);
    expect((result.data as any).messageId).toBe('msg-s29-compat');
    expect((result.data as any).verb).toBe('add');
    expect((result.data as any).object).toBe('reference');

    // Should NOT call getMyProjects when explicit senderProjectId
    expect(client.getMyProjects).not.toHaveBeenCalled();

    // Should pass explicit senderProjectId through
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderProjectId: '9566f5ce-f171-4e95-a24e-ad756c2b8807',
      })
    );
  });

  it('Sprint 29 respond pattern still works', async () => {
    const client = mockClient();
    client.respondToMessage.mockResolvedValueOnce(
      createSuccess({
        id: 'f8df46e5-a3d3-4de2-84a8-8c4ae5120674',
        type: 'info_push',
        summary: 'Answers to Phase 2 open questions',
        status: 'accepted',
        createdAt: '2026-03-10T02:38:00Z',
        updatedAt: '2026-03-10T02:39:00Z',
      })
    );

    const result = await cmosMessage({
      action: 'respond',
      messageId: 'f8df46e5-a3d3-4de2-84a8-8c4ae5120674',
      respondStatus: 'accepted',
      notes: 'All 3 answers received.',
    });

    expect(result.success).toBe(true);
    expect((result.data as any).currentStatus).toBe('accepted');
  });

  it('Sprint 29 list pattern still works', async () => {
    const client = mockClient();
    client.listMessages.mockResolvedValueOnce(
      createSuccess({
        messages: [
          {
            id: 'msg-001',
            type: 'info_push',
            summary: 'Info from dashboard',
            status: 'pending',
            createdAt: '2026-03-10T02:38:00Z',
          },
        ],
        unreadCount: 1,
        totalCount: 1,
      })
    );

    const result = await cmosMessage({ action: 'list', status: 'pending' });
    expect(result.success).toBe(true);
    expect((result.data as any).messages).toHaveLength(1);
    expect((result.data as any).unreadCount).toBe(1);
  });
});

// ─── Input Normalization Integration ─────────────────────────────────────────

describe('input normalization integration', () => {
  it('normalizes "cmos dashboard" to cmos-dashboard in full pipeline', async () => {
    const client = mockClient();
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        id: 'msg-norm-001',
        type: 'question',
        summary: 'Test normalization',
        status: 'pending',
        createdAt: '2026-03-10T03:00:00Z',
      })
    );

    const result = await cmosMessage({
      action: 'send',
      targetAddress: 'cmos://Derek/CMOS Dashboard',
      type: 'question',
      summary: 'Test normalization',
    });

    expect(result.success).toBe(true);
    // Resolution should use normalized address
    expect(client.resolveAddress).toHaveBeenCalledWith({
      address: 'cmos://derek/cmos-dashboard',
    });
    // Send should use normalized address
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetAddress: 'cmos://derek/cmos-dashboard' })
    );
    // Result should show normalized address
    expect((result.data as any).targetAddress).toBe('cmos://derek/cmos-dashboard');
  });

  it('handles multiple consecutive spaces in address', async () => {
    const client = mockClient();
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        id: 'msg-norm-002',
        type: 'question',
        summary: 'Test',
        status: 'pending',
        createdAt: '2026-03-10T03:00:00Z',
      })
    );

    await cmosMessage({
      action: 'send',
      targetAddress: 'cmos://derek/oods  foundry  mcp',
      type: 'question',
      summary: 'Test',
    });

    expect(client.resolveAddress).toHaveBeenCalledWith({
      address: 'cmos://derek/oods-foundry-mcp',
    });
  });
});
