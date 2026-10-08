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
  buildResolvedToolResult,
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

  // s91-m02 Fix 2 — every published schema declares additionalProperties: false and nothing
  // enforced it, so a misplaced key was dropped silently and the call "succeeded" without it.
  it('refuses an unknown top-level key by name before sender resolution', async () => {
    const handleSpy = jest.spyOn(ErrorHandler, 'handle');
    const result = await executeMissionProtocolTool('cmos_review', { __s91_probe: 1 }, {} as never);
    const structured = result.structuredContent as StructuredError;

    expect(result.isError).toBe(true);
    expect(structured.error).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: '__s91_probe',
      providedValue: 1,
    });
    expect(structured.error.suggestion).toContain('not a parameter of cmos_review');
    expect(structured.error.validValues).toContain('projectRoot');
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('names the wrapper when an unknown top-level key belongs to a nested object', async () => {
    const result = await executeMissionProtocolTool(
      'cmos_mission',
      { action: 'update', missionId: 'x', metadata: { a: 1 } },
      {} as never
    );
    const structured = result.structuredContent as StructuredError;

    expect(structured.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'metadata' });
    expect(structured.error.suggestion).toContain('for action=update it belongs under `fields`');
  });

  it('names the array wrapper when an unknown top-level key belongs to its entries', async () => {
    const result = await executeMissionProtocolTool(
      'cmos_context',
      { action: 'update', path: 'project_name', value: 'x' },
      {} as never
    );
    const structured = result.structuredContent as StructuredError;

    expect(structured.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'path' });
    expect(structured.error.suggestion).toContain('inside each `fieldUpdates` entry');
  });

  it('checks unknown keys only after the action and projectRoot checks', async () => {
    const badAction = await executeMissionProtocolTool(
      'cmos_feedback',
      { action: 'nope', projectRoot: 12345, __s91_probe: 1 },
      {} as never
    );
    expect((badAction.structuredContent as StructuredError).error.code).toBe('INVALID_ACTION');

    const badRoot = await executeMissionProtocolTool(
      'cmos_feedback',
      { action: 'list', projectRoot: 12345, __s91_probe: 1 },
      {} as never
    );
    expect((badRoot.structuredContent as StructuredError).error.field).toBe('projectRoot');
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

  // s92-m01: the resolver now says WHY it refused. These two outcomes carry no selected store —
  // the caller named no project — so the refusal names where the caller is and how to name one.
  it('answers a read in a non-CMOS working folder with the labelled no-project refusal', async () => {
    const folder = await temporaryRoot('cmos-preflight-folder-b-');
    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [], 'CMOS_NOT_DETECTED', {
        outcome: 'no-project-here',
        workingDir: folder,
      }),
      'read'
    );

    expect(classified).toMatchObject({
      code: 'CMOS_NOT_DETECTED',
      message: `No CMOS project in '${folder}'. There is nothing to read here.`,
    });
    expect(classified.suggestion).toContain('Pass projectRoot');
    expect(classified.suggestion).toContain(
      `cmos_project(action="init", projectRoot=${JSON.stringify(folder)})`
    );
  });

  it('refuses a write in a non-CMOS working folder with the init remedy first', async () => {
    const folder = await temporaryRoot('cmos-preflight-folder-w-');
    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [], 'CMOS_NOT_DETECTED', {
        outcome: 'no-project-here',
        workingDir: folder,
      }),
      'write'
    );

    expect(classified.message).toBe(`No CMOS project in '${folder}'. Nothing was written.`);
    expect(classified.suggestion).toMatch(
      /^To keep a record for this folder, create a project: cmos_project\(action="init"/
    );
  });

  it('names the --project-root and default remedies only for a contextless call', async () => {
    const plain = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [], 'CMOS_NOT_DETECTED', {
        outcome: 'contextless-no-default',
        workingDir: '/',
      })
    );
    expect(plain.code).toBe('CMOS_NOT_DETECTED');
    expect(plain.message).toContain(
      "the server's working directory '/' carries no project context"
    );
    expect(plain.suggestion).toContain('"--project-root"');
    expect(plain.suggestion).toContain('setAsDefault set to true');

    const withUnapplied = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [], 'CMOS_NOT_DETECTED', {
        outcome: 'contextless-no-default',
        workingDir: '/',
        unappliedDefault: { projectId: 'forge', name: 'Forge', storePath: '/repos/forge' },
      })
    );
    expect(withUnapplied.message).toContain("The registry default 'Forge' was set before 3.2.0");
    expect(withUnapplied.suggestion).toContain(
      'cmos_project(action="register", projectRoot="/repos/forge", setAsDefault=true)'
    );
  });

  it('distinguishes no CMOS directory from a CMOS directory missing its database', async () => {
    const emptyRoot = await temporaryRoot('cmos-preflight-empty-');
    const cmosRoot = await temporaryRoot('cmos-preflight-no-db-');
    await fs.mkdir(path.join(cmosRoot, 'cmos', 'db'), { recursive: true });

    const noCmos = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'explicit',
          projectRoot: emptyRoot,
          accepted: false,
          rejectReason: 'no CMOS database at projectRoot',
        },
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

  it('names the enclosing project when an explicit root is a folder inside one', async () => {
    // Creating a project at the explicit subfolder would nest one project inside another, so the
    // refusal must not offer init there — it points at the enclosing project instead.
    const project = await temporaryRoot('cmos-preflight-enclosing-');
    await fs.mkdir(path.join(project, 'cmos', 'db'), { recursive: true });
    await fs.writeFile(path.join(project, 'cmos', 'db', 'cmos.sqlite'), '');
    const subfolder = path.join(project, 'src', 'feature');
    await fs.mkdir(subfolder, { recursive: true });

    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'explicit',
          projectRoot: subfolder,
          accepted: false,
          rejectReason: 'no CMOS database at projectRoot',
        },
      ])
    );

    expect(classified).toMatchObject({
      code: 'CMOS_NOT_DETECTED',
      message: `'${subfolder}' is not a CMOS project root: it is inside the CMOS project at '${project}'.`,
      suggestion: `Pass projectRoot=${JSON.stringify(project)}.`,
    });
    expect(classified.suggestion).not.toContain('init');
  });

  it('classifies the LAST candidate — the selected store — not an earlier skipped root', async () => {
    const skippedRoot = await temporaryRoot('cmos-preflight-skipped-root-');
    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'mcp-roots',
          projectRoot: skippedRoot,
          accepted: false,
          rejectReason: 'no CMOS database at projectRoot',
        },
        {
          source: 'cwd',
          projectRoot: '/tmp/cmos-preflight-selected-cwd',
          accepted: false,
          rejectReason: 'dashboard_project_id missing or not a UUID',
        },
      ])
    );

    expect(classified).toMatchObject({
      code: 'SENDER_UNRESOLVABLE',
      message: expect.stringContaining('dashboard_project_id'),
    });
  });

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
      label: 'a refused registry default',
      candidate: {
        source: 'registry-default' as const,
        projectRoot: '/tmp/cmos-preflight-default-no-identity',
        accepted: false,
        rejectReason: 'dashboard_project_id missing or not a UUID',
      },
      code: 'SENDER_UNRESOLVABLE',
      fragment: 'dashboard_project_id',
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

  it('falls back to SENDER_UNRESOLVABLE when the trace has no recognized evidence', async () => {
    const classified = await classifySenderResolutionError(
      new SenderResolutionError('unresolved', [
        {
          source: 'registry-default',
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

describe('s92-m01 resolution stamp on every success', () => {
  const textOf = (result: ReturnType<typeof buildResolvedToolResult>): string =>
    result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

  it('adds projectRoot and resolvedBy to an object payload, keeping a handler-set projectRoot', () => {
    const stamped = buildResolvedToolResult({ success: true, data: { count: 3 } }, 'body', {
      projectRoot: '/repos/a',
      resolvedBy: 'cwd',
    });
    expect(stamped.structuredContent).toEqual({
      success: true,
      data: { count: 3, projectRoot: '/repos/a', resolvedBy: 'cwd' },
    });

    const kept = buildResolvedToolResult(
      { success: true, data: { projectRoot: '/repos/new-project' } },
      'body',
      { projectRoot: '/repos/new-project', resolvedBy: 'explicit' }
    );
    expect((kept.structuredContent as { data: Record<string, unknown> }).data).toEqual({
      projectRoot: '/repos/new-project',
      resolvedBy: 'explicit',
    });
  });

  it('stamps the top level when the payload is not an object', () => {
    const stamped = buildResolvedToolResult({ success: true, data: [1, 2] }, 'body', {
      projectRoot: null,
      resolvedBy: 'none',
    });
    expect(stamped.structuredContent).toMatchObject({
      data: [1, 2],
      projectRoot: null,
      resolvedBy: 'none',
    });
  });

  it.each([
    ['mcp-roots', "the client's MCP roots"],
    ['server-project-root', "--project-root in this server's config"],
    ['registry-default', 'the registry default project'],
  ] as const)('renders one project line when resolved by %s', (resolvedBy, label) => {
    const stamped = buildResolvedToolResult({ success: true, data: {} }, 'body', {
      projectRoot: '/repos/a',
      resolvedBy,
    });
    expect(textOf(stamped)).toBe(`Project: /repos/a (resolved by ${label})\n\nbody`);
  });

  it('renders the note instead of the label when the route needs saying out loud', () => {
    const stamped = buildResolvedToolResult({ success: true, data: {} }, 'body', {
      projectRoot: '/repos/a',
      resolvedBy: 'cwd',
      note: "resolved by the server's working directory — the client's MCP roots hold no CMOS project",
    });
    expect(textOf(stamped)).toBe(
      "Project: /repos/a (resolved by the server's working directory — the client's MCP roots hold no CMOS project)\n\nbody"
    );
    // The data still says cwd: the note is for the reader, the field for the program.
    expect(stamped.structuredContent).toMatchObject({ data: { resolvedBy: 'cwd' } });
  });

  it.each(['explicit', 'cwd', 'none'] as const)(
    'renders no line when resolved by %s',
    (resolvedBy) => {
      const stamped = buildResolvedToolResult({ success: true, data: {} }, 'body', {
        projectRoot: resolvedBy === 'none' ? null : '/repos/a',
        resolvedBy,
      });
      expect(textOf(stamped)).toBe('body');
    }
  );

  it('leaves a refusal untouched', () => {
    const refusal = { success: false, error: { code: 'X', message: 'no' } };
    const stamped = buildResolvedToolResult(refusal, 'refused', {
      projectRoot: '/repos/a',
      resolvedBy: 'mcp-roots',
    });
    expect(stamped).toEqual({
      content: [{ type: 'text', text: 'refused' }],
      structuredContent: refusal,
      isError: true,
    });
  });
});
