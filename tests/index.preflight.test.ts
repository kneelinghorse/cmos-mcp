// ABOUTME: Focused coverage for the dispatcher preflight and sender-resolution refusal boundary.
// ABOUTME: Pins precedence, evidence classification, and correlation-free known-error envelopes.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  PREFLIGHT_PARAMS,
  buildKnownToolErrorResult,
  classifySenderResolutionError,
  executeMissionProtocolTool,
} from '../src/index';
import { ErrorHandler } from '../src/errors/handler';
import { CmosDetector } from '../src/intelligence/cmos-detector';
import { SenderResolutionError } from '../src/intelligence/sender-context';
import { CmosErrors } from '../src/tools/cmos';

type StructuredError = {
  success: false;
  error: {
    code: string;
    message: string;
    suggestion?: string;
    field?: string;
    providedValue?: unknown;
    validValues?: string[];
  };
};

describe('mission-protocol dispatcher preflight', () => {
  const originalRole = process.env['CMOS_AGENT_ROLE'];

  beforeEach(() => {
    delete process.env['CMOS_AGENT_ROLE'];
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (originalRole === undefined) delete process.env['CMOS_AGENT_ROLE'];
    else process.env['CMOS_AGENT_ROLE'] = originalRole;
    CmosDetector.resetInstance();
    jest.restoreAllMocks();
  });

  it('keeps the unconditional boundary scope to projectRoot', () => {
    expect(PREFLIGHT_PARAMS).toEqual(['projectRoot']);
  });

  it('builds known refusals without invoking ErrorHandler or minting a correlation id', () => {
    const handleSpy = jest.spyOn(ErrorHandler, 'handle');
    const error = CmosErrors.invalidParameter('projectRoot', 12345, ['a JSON string']);

    const result = buildKnownToolErrorResult(error);
    const structured = result.structuredContent as StructuredError;
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(result.isError).toBe(true);
    expect(structured).toEqual({ success: false, error });
    expect(text).toContain('Tool execution error [INVALID_PARAMETER]');
    expect(text).toContain('Suggestion: Valid values: a JSON string');
    expect(text).not.toContain('correlationId');
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('refuses a wrong-typed projectRoot before sender resolution', async () => {
    const handleSpy = jest.spyOn(ErrorHandler, 'handle');
    const result = await executeMissionProtocolTool(
      'cmos_review',
      { projectRoot: 12345 },
      {} as never
    );
    const structured = result.structuredContent as StructuredError;

    expect(structured.error).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: 'projectRoot',
      providedValue: 12345,
      validValues: ['a JSON string'],
    });
    expect(JSON.stringify(result)).not.toContain('correlationId');
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('gives every published action enum precedence over projectRoot validation', async () => {
    const result = await executeMissionProtocolTool(
      'cmos_feedback',
      { action: 'not-an-action', projectRoot: 12345 },
      {} as never
    );
    const structured = result.structuredContent as StructuredError;

    expect(structured.error).toMatchObject({
      code: 'INVALID_ACTION',
      field: 'action',
      providedValue: 'not-an-action',
      validValues: ['list', 'triage', 'resolve', 'archive'],
    });
  });

  it('gives INVALID_ACTION precedence over the review-role guard without incident reporting', async () => {
    process.env['CMOS_AGENT_ROLE'] = 'review';
    const handleSpy = jest.spyOn(ErrorHandler, 'handle');

    const result = await executeMissionProtocolTool(
      'cmos_feedback',
      { action: 'not-an-action', projectRoot: 12345 },
      {} as never
    );
    const structured = result.structuredContent as StructuredError;

    expect(structured.error).toMatchObject({
      code: 'INVALID_ACTION',
      field: 'action',
      providedValue: 'not-an-action',
    });
    expect(JSON.stringify(result)).not.toContain('correlationId');
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('does not preflight unknown tools, preserving the direct MethodNotFound contract', async () => {
    await expect(
      executeMissionProtocolTool(
        'unknown_tool',
        { action: 'not-an-action', projectRoot: 12345 },
        {} as never
      )
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    await expect(
      executeMissionProtocolTool('unknown_tool', { projectRoot: 12345 }, {} as never)
    ).rejects.toBeInstanceOf(McpError);
  });

  it('gives an unknown tool MethodNotFound precedence over the review-role guard', async () => {
    process.env['CMOS_AGENT_ROLE'] = 'review';
    const handleSpy = jest.spyOn(ErrorHandler, 'handle');

    await expect(
      executeMissionProtocolTool(
        'unknown_tool',
        { action: 'not-an-action', projectRoot: 12345 },
        {} as never
      )
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('still blocks a valid write after schema preflight under the review role', async () => {
    process.env['CMOS_AGENT_ROLE'] = 'review';
    const handleSpy = jest.spyOn(ErrorHandler, 'handle');
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await executeMissionProtocolTool(
      'cmos_mission_transition',
      { action: 'start', missionId: 's90-review-guard-control' },
      {} as never
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        success: false,
        error: {
          code: 'TOOL_EXECUTION_ERROR',
          message: expect.stringContaining('[read-only-agent-guard] BLOCKED'),
        },
      },
    });
    expect(handleSpy).toHaveBeenCalledTimes(1);
  });
});

describe('SenderResolutionError evidence classifier', () => {
  const temporaryRoots: string[] = [];

  async function temporaryRoot(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    CmosDetector.resetInstance();
    await Promise.all(
      temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  it('distinguishes no CMOS directory from a CMOS directory missing its database', async () => {
    const emptyRoot = await temporaryRoot('cmos-preflight-empty-');
    const cmosRoot = await temporaryRoot('cmos-preflight-no-db-');
    await fs.mkdir(path.join(cmosRoot, 'cmos', 'db'), { recursive: true });

    const noCmos = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'cwd',
          projectRoot: emptyRoot,
          accepted: false,
          rejectReason: 'no CMOS database at projectRoot',
        },
        { source: 'registry-singleton', accepted: false, rejectReason: 'registry is empty' },
      ])
    );
    const noDatabase = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'explicit',
          projectRoot: cmosRoot,
          accepted: false,
          rejectReason: 'no CMOS database at projectRoot',
        },
      ])
    );

    expect(noCmos).toMatchObject({ code: 'CMOS_NOT_DETECTED' });
    expect(noDatabase).toMatchObject({
      code: 'DB_NOT_FOUND',
      message: `CMOS database not found at '${path.join(cmosRoot, 'cmos', 'db', 'cmos.sqlite')}'`,
    });
  });

  it('prefers a concrete registry missing-database failure over a generic empty cwd', async () => {
    const cwdRoot = await temporaryRoot('cmos-preflight-registry-cwd-');
    const registryRoot = await temporaryRoot('cmos-preflight-registry-no-db-');
    await fs.mkdir(path.join(registryRoot, 'cmos', 'db'), { recursive: true });

    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'cwd',
          projectRoot: cwdRoot,
          accepted: false,
          rejectReason: 'no CMOS database at projectRoot',
        },
        {
          source: 'registry-singleton',
          projectRoot: registryRoot,
          accepted: false,
          rejectReason: 'no CMOS database at projectRoot',
        },
      ])
    );

    expect(classified).toMatchObject({
      code: 'DB_NOT_FOUND',
      message: `CMOS database not found at '${path.join(registryRoot, 'cmos', 'db', 'cmos.sqlite')}'`,
    });
  });

  it.each([
    {
      label: 'database failure',
      registryRoot: '/tmp/cmos-preflight-registry-db-fault',
      rejectReason: 'DB read error: SQLITE_CANTOPEN',
      code: 'DB_CONNECTION_FAILED',
      fragment: 'SQLITE_CANTOPEN',
    },
    {
      label: 'identity failure',
      registryRoot: '/tmp/cmos-preflight-registry-no-identity',
      rejectReason: 'dashboard_project_id missing or not a UUID',
      code: 'SENDER_UNRESOLVABLE',
      fragment: 'dashboard_project_id',
    },
  ])(
    'prefers a concrete registry $label over a generic empty cwd',
    async ({ registryRoot, rejectReason, code, fragment }) => {
      const cwdRoot = await temporaryRoot('cmos-preflight-registry-mixed-cwd-');
      const classified = await classifySenderResolutionError(
        new SenderResolutionError('unresolved', [
          {
            source: 'cwd',
            projectRoot: cwdRoot,
            accepted: false,
            rejectReason: 'no CMOS database at projectRoot',
          },
          {
            source: 'registry-singleton',
            projectRoot: registryRoot,
            accepted: false,
            rejectReason,
          },
        ])
      );

      expect(classified).toMatchObject({
        code,
        message: expect.stringContaining(fragment),
      });
    }
  );

  it('turns a failed missing-database re-observation into a known sender refusal', async () => {
    const root = await temporaryRoot('cmos-preflight-reobserve-fault-');
    jest
      .spyOn(CmosDetector.getInstance(), 'detect')
      .mockRejectedValueOnce(new Error('EACCES while checking cmos directory'));

    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'explicit',
          projectRoot: root,
          accepted: false,
          rejectReason: 'no CMOS database at projectRoot',
        },
      ])
    );

    expect(classified).toMatchObject({
      code: 'SENDER_UNRESOLVABLE',
      message: expect.stringContaining('EACCES while checking cmos directory'),
      suggestion: expect.stringContaining('Pass projectRoot explicitly'),
    });
  });

  it.each([
    {
      label: 'database open/read failure',
      candidate: {
        source: 'explicit' as const,
        projectRoot: '/tmp/cmos-preflight-db-fault',
        accepted: false,
        rejectReason: 'DB read error: SQLITE_CANTOPEN',
      },
      code: 'DB_CONNECTION_FAILED',
      fragment: 'SQLITE_CANTOPEN',
    },
    {
      label: 'database open failure without a driver detail',
      candidate: {
        source: 'explicit' as const,
        projectRoot: '/tmp/cmos-preflight-db-open-fault',
        accepted: false,
        rejectReason: 'failed to open CMOS database',
      },
      code: 'DB_CONNECTION_FAILED',
      fragment: 'failed to open CMOS database',
    },
    {
      label: 'missing sender identity',
      candidate: {
        source: 'explicit' as const,
        projectRoot: '/tmp/cmos-preflight-no-identity',
        accepted: false,
        rejectReason: 'dashboard_project_id missing or not a UUID',
      },
      code: 'SENDER_UNRESOLVABLE',
      fragment: 'dashboard_project_id',
    },
    {
      label: 'empty or stale cmos address',
      candidate: {
        source: 'explicit' as const,
        projectRoot: '/tmp/cmos-preflight-stale-address',
        accepted: false,
        rejectReason: 'project_identity.cmos_address is empty or cmos://unknown/*',
      },
      code: 'SENDER_UNRESOLVABLE',
      fragment: 'project_identity.cmos_address',
    },
    {
      label: 'server-install guard',
      candidate: {
        source: 'cwd' as const,
        projectRoot: '/tmp/cmos-preflight-install',
        accepted: false,
        rejectReason: 'cwd-vs-SERVER_INSTALL_ROOT guard: implicit sender rejected',
      },
      code: 'SENDER_UNRESOLVABLE',
      fragment: 'SERVER_INSTALL_ROOT',
    },
    {
      label: 'registry ambiguity',
      candidate: {
        source: 'registry-singleton' as const,
        accepted: false,
        rejectReason: 'registry has 2 projects; auto-pick only allowed when size === 1',
      },
      code: 'SENDER_UNRESOLVABLE',
      fragment: 'registry has 2 projects',
    },
  ])('maps $label from recorded evidence', async ({ candidate, code, fragment }) => {
    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [candidate])
    );

    expect(classified).toMatchObject({
      code,
      message: expect.stringContaining(fragment),
    });
    if (code === 'DB_CONNECTION_FAILED') {
      expect(classified.suggestion).toContain('Check file permissions');
    } else {
      expect(classified.suggestion).toContain('Pass projectRoot explicitly');
    }
  });

  it('treats multiple rejected MCP roots as attribution ambiguity', async () => {
    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'mcp-roots',
          projectRoot: '/tmp/cmos-preflight-mcp-a',
          accepted: false,
          rejectReason: 'dashboard_project_id missing or not a UUID',
        },
        {
          source: 'mcp-roots',
          projectRoot: '/tmp/cmos-preflight-mcp-b',
          accepted: false,
          rejectReason: 'project_identity.cmos_address is empty or cmos://unknown/*',
        },
      ])
    );

    expect(classified).toMatchObject({
      code: 'SENDER_UNRESOLVABLE',
      message: expect.stringContaining('multiple MCP roots'),
    });
  });

  it('uses an explicit missing store before a later registry ambiguity', async () => {
    const explicitRoot = await temporaryRoot('cmos-preflight-explicit-priority-');
    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'explicit',
          projectRoot: explicitRoot,
          accepted: false,
          rejectReason: 'no CMOS database at projectRoot',
        },
        {
          source: 'registry-singleton',
          accepted: false,
          rejectReason: 'registry has 4 projects; auto-pick only allowed when size === 1',
        },
      ])
    );

    expect(classified.code).toBe('CMOS_NOT_DETECTED');
  });

  it('falls back to SENDER_UNRESOLVABLE when the trace has no recognized evidence', async () => {
    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'registry-singleton',
          accepted: false,
          rejectReason: 'an unfamiliar resolver condition',
        },
      ])
    );

    expect(classified).toMatchObject({
      code: 'SENDER_UNRESOLVABLE',
      message: expect.stringContaining('an unfamiliar resolver condition'),
      suggestion: expect.stringContaining('Pass projectRoot explicitly'),
    });
  });
});
