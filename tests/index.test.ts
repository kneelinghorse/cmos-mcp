import { describe, expect, test, beforeAll } from '@jest/globals';
import path from 'path';
import {
  getToolDefinitions,
  buildMissionProtocolContext,
  executeMissionProtocolTool,
  summarizeValue,
  sanitizeArgs,
  getServerVersion,
} from '../src/index';
import * as fs from 'fs';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

const DEPRECATED_TOOL_NAMES = [
  'get_available_domains',
  'create_mission',
  'get_mission_quality_score',
  'create_mission_splits',
  'cmos_sprint_list',
  'cmos_sprint_show',
  'cmos_sprint_add',
  'cmos_sprint_update',
  'cmos_sprint_complete',
  'cmos_mission_list',
  'cmos_mission_show',
  'cmos_mission_status',
  'cmos_mission_start',
  'cmos_mission_complete',
  'cmos_mission_block',
  'cmos_mission_unblock',
  'cmos_mission_update',
  'cmos_mission_add',
  'cmos_mission_depends',
  'cmos_context_view',
  'cmos_context_update',
  'cmos_context_condense',
  'cmos_context_snapshot',
  'cmos_context_history',
  'cmos_session_start',
  'cmos_session_capture',
  'cmos_session_complete',
  'cmos_session_list',
  'cmos_decisions_list',
  'cmos_decisions_search',
  'cmos_db_health',
  'cmos_db_snapshot',
  'cmos_db_restore',
  'cmos_project_register',
  'cmos_project_list',
  'cmos_project_unregister',
  'cmos_project_validate',
  'cmos_project_init',
] as const;

describe('Mission Protocol entry point', () => {
  test('exposes tool definitions with expected identifiers', () => {
    const definitions = getToolDefinitions();
    const names = definitions.map((def) => def.name);

    expect(names).toContain('cmos_mission');
    expect(names).toContain('cmos_mission_transition');
    expect(names).toContain('cmos_sprint');
    expect(names).toContain('cmos_context');
    expect(names).toContain('cmos_session');
    expect(names).toContain('cmos_decisions');
    expect(names).toContain('cmos_db');
    expect(names).toContain('cmos_project');
    expect(names).toContain('cmos_agent_onboard');

    for (const toolName of DEPRECATED_TOOL_NAMES) {
      expect(names).not.toContain(toolName);
    }
  });

  test('buildMissionProtocolContext creates default components', async () => {
    const context = await buildMissionProtocolContext();

    // s77-m04: the vestigial `baseDir` (templates) was removed from the context.
    expect(context.defaultModel).toBe('claude');
    expect(typeof context.tokenCounter.count).toBe('function');
  });

  test('buildMissionProtocolContext respects the defaultModel override', async () => {
    const context = await buildMissionProtocolContext({ defaultModel: 'gemini' });

    expect(context.defaultModel).toBe('gemini');
  });

  test('getServerVersion returns the package.json version (s77-m04)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
      version: string;
    };

    const version = getServerVersion();
    expect(version).toBe(pkg.version);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  describe('executeMissionProtocolTool', () => {
    let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;

    beforeAll(async () => {
      context = await buildMissionProtocolContext();
    });

    test.each(DEPRECATED_TOOL_NAMES)('rejects deprecated public tool %s', async (toolName) => {
      await expect(executeMissionProtocolTool(toolName, {}, context)).rejects.toMatchObject({
        code: ErrorCode.MethodNotFound,
      });
    });

    test('throws MCP error for unknown tool names', async () => {
      await expect(executeMissionProtocolTool('unknown_tool', {}, context)).rejects.toMatchObject({
        code: ErrorCode.MethodNotFound,
      });
      await expect(executeMissionProtocolTool('unknown_tool', {}, context)).rejects.toBeInstanceOf(
        McpError
      );
    });

    test('cmos_project(action=init) passes projectRoot literally without sender-context rewrite', async () => {
      // Regression: the dispatcher previously routed every cmos_project action
      // through resolveToolSenderContext. For init, that resolver fell back to
      // the caller's own project when the target had no CMOS DB, clobbering
      // the caller's metadata with a fresh seed.
      const fs = await import('fs');
      const os = await import('os');
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-init-dispatcher-'));
      try {
        const result = await executeMissionProtocolTool(
          'cmos_project',
          { action: 'init', projectRoot: tmpRoot, projectName: 'dispatcher-regression' },
          context
        );
        const structured = (result as { structuredContent?: { data?: { cmosDirectory?: string } } })
          .structuredContent;
        expect(structured?.data?.cmosDirectory).toBe(path.join(tmpRoot, 'cmos'));
        expect(fs.existsSync(path.join(tmpRoot, 'cmos', 'db', 'cmos.sqlite'))).toBe(true);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    test('Sprint 65 m02: project_identity.cmos_address survives planning session lifecycle + onboard', async () => {
      // Regression: pre-fix, backfillUnknownCmosAddress (called unguarded from
      // cmos_agent_onboard:455 and checkpoint-backfill:68) silently rewrote a
      // user-set cmos_address back to the metadata-derived canonical form on
      // the next observation pass. The operator attributed this to the
      // session-complete aggregation path in decision #682, but the actual
      // trigger was the next cmos_agent_onboard call — session-complete does
      // not touch project_identity. This test exercises the full lifecycle
      // (flip → session start → capture → complete → onboard) to confirm the
      // flipped address survives every step. Also asserts other identity
      // fields (foundational_docs, description) survive the same lifecycle —
      // success criterion 4.
      const fs = await import('fs');
      const os = await import('os');
      const Database = (await import('better-sqlite3')).default;
      const originalCwd = process.cwd;

      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-identity-drift-'));

      try {
        await executeMissionProtocolTool(
          'cmos_project',
          { action: 'init', projectRoot, projectName: 'identity-drift-test' },
          context
        );

        // Seed metadata.owner so backfillUnknownCmosAddress has the worst-case
        // ammo to silently re-canonicalize on the next onboard. Pre-fix, this
        // is what makes the bug bite; post-fix, the guard prevents the rewrite.
        const db = new Database(path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite'));
        db.exec(
          `INSERT OR REPLACE INTO metadata (key, value) VALUES ('owner', 'test-owner'), ('dashboard_slug', 'identity-drift-test')`
        );
        db.close();

        process.cwd = () => projectRoot;

        // Flip cmos_address to a fork-style address that differs from the
        // metadata-derived canonical form. Also flip foundational_docs and
        // description so we can assert other identity fields survive too.
        const flippedAddress = 'cmos://test-owner/identity-drift-test-fork';
        const foundationalDocsValue = [{ title: 'Fork Spec', path: 'docs/fork.md' }];
        await executeMissionProtocolTool(
          'cmos_context',
          {
            action: 'update',
            contextType: 'project_identity',
            fieldUpdates: [
              { path: 'cmos_address', value: flippedAddress },
              { path: 'foundational_docs', value: foundationalDocsValue },
              { path: 'description', value: 'Pro fork descriptor' },
            ],
          },
          context
        );

        // Run a full planning session lifecycle. Mission says planning-close
        // is the suspected trigger.
        const startResult = (await executeMissionProtocolTool(
          'cmos_session',
          { action: 'start', type: 'planning', title: 'Identity drift regression session' },
          context
        )) as { structuredContent?: { success?: boolean; data?: { sessionId?: string } } };
        const sessionId = startResult.structuredContent?.data?.sessionId;
        expect(sessionId).toBeDefined();

        await executeMissionProtocolTool(
          'cmos_session',
          {
            action: 'capture',
            sessionId,
            category: 'context',
            content: 'noop capture to exercise the aggregation path',
          },
          context
        );

        await executeMissionProtocolTool(
          'cmos_session',
          {
            action: 'complete',
            sessionId,
            summary: 'identity drift regression close',
          },
          context
        );

        // The actual bug trigger: cmos_agent_onboard calls backfillUnknownCmosAddress.
        // Pre-fix, this reverts cmos_address to 'cmos://test-owner/identity-drift-test'.
        // Post-fix, the guard preserves the flipped value.
        await executeMissionProtocolTool('cmos_agent_onboard', {}, context);

        // Inspect identity after the full lifecycle. All flipped fields must persist.
        const viewResult = (await executeMissionProtocolTool(
          'cmos_context',
          { action: 'view', contextType: 'project_identity' },
          context
        )) as {
          structuredContent?: {
            success?: boolean;
            data?: {
              projectIdentity?: {
                cmos_address?: string;
                foundational_docs?: Array<{ title: string; path: string }>;
                description?: string;
                project_name?: string;
                related_projects?: unknown[];
                tracelab_refs?: unknown[];
              };
            };
          };
        };

        const identity = viewResult.structuredContent?.data?.projectIdentity;
        expect(identity).toBeDefined();
        expect(identity?.cmos_address).toBe(flippedAddress);
        expect(identity?.foundational_docs).toEqual(foundationalDocsValue);
        expect(identity?.description).toBe('Pro fork descriptor');
        // Sanity: other identity fields the lifecycle should not touch
        expect(Array.isArray(identity?.related_projects)).toBe(true);
        expect(Array.isArray(identity?.tracelab_refs)).toBe(true);
      } finally {
        process.cwd = originalCwd;
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('Sprint 65 m01: cmos_mission(action=show) pins to CWD project, never fans out across registry', async () => {
      // Regression: pre-fix, cmos_mission(show) was in READ_ACTIONS so the
      // dispatcher fanned out across every registered project when projectRoot
      // was omitted. Mission IDs collide across projects (sNN-mNN is not
      // globally unique), so the agent received same-ID missions from unrelated
      // codebases (feedback row #1; decision #675). Post-fix, show falls
      // through to resolveToolSenderContext and pins to the caller's project
      // via cwd auto-discovery — single-result shape, not a MultiClientEntry
      // fan-out array.
      const fs = await import('fs');
      const os = await import('os');
      const Database = (await import('better-sqlite3')).default;
      const originalCwd = process.cwd;

      const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-show-cwd-'));
      const siblingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-show-sibling-'));

      try {
        // Initialize two real CMOS workspaces so both are registry-eligible
        await executeMissionProtocolTool(
          'cmos_project',
          { action: 'init', projectRoot: cwdRoot, projectName: 's65-m01-cwd' },
          context
        );
        await executeMissionProtocolTool(
          'cmos_project',
          { action: 'init', projectRoot: siblingRoot, projectName: 's65-m01-sibling' },
          context
        );

        // Insert a mission with the same ID into both DBs, with distinguishing
        // names — the fan-out bug would have returned both rows.
        const sharedMissionId = 's65-m01-regression-fixture';
        const insertMission = (root: string, name: string): void => {
          const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
          db.prepare('INSERT INTO missions (id, name, status) VALUES (?, ?, ?)').run(
            sharedMissionId,
            name,
            'Queued'
          );
          db.close();
        };
        insertMission(cwdRoot, 'from-cwd-project');
        insertMission(siblingRoot, 'from-sibling-project');

        // Pin process.cwd to the cwd workspace so cwd auto-discovery wins
        // in resolveSenderContext (explicit → mcp-roots → cwd → registry).
        process.cwd = () => cwdRoot;

        const result = (await executeMissionProtocolTool(
          'cmos_mission',
          { action: 'show', missionId: sharedMissionId },
          context
        )) as { structuredContent?: { success?: boolean; data?: unknown } };

        const structured = result.structuredContent;
        // Single-result shape: data is the mission object directly, not an
        // array of MultiClientEntry. Fan-out regression would make this an
        // Array of {resolvedFrom, success, data} entries.
        expect(structured?.success).toBe(true);
        expect(Array.isArray(structured?.data)).toBe(false);

        // And the mission resolved is the CWD project's mission specifically.
        const mission = structured?.data as { id?: string; name?: string };
        expect(mission?.id).toBe(sharedMissionId);
        expect(mission?.name).toBe('from-cwd-project');
      } finally {
        process.cwd = originalCwd;
        fs.rmSync(cwdRoot, { recursive: true, force: true });
        fs.rmSync(siblingRoot, { recursive: true, force: true });
      }
    });
  });

  describe('sanitization helpers', () => {
    test('summarizeValue truncates arrays and long strings', () => {
      const sample = summarizeValue({
        list: ['a', 'b', 'c', 'd', 'e', 'f'],
        details: 'x'.repeat(250),
      });

      expect(sample).toBe('[object]');

      const truncated = summarizeValue('0123456789'.repeat(25));
      expect((truncated as string).length).toBe(198);
      expect((truncated as string).endsWith('…')).toBe(true);

      const arraySummary = summarizeValue([1, 2, 3, 4, 5, 6]) as unknown[];
      expect(Array.isArray(arraySummary)).toBe(true);
      expect(arraySummary.length).toBe(5);
    });

    test('summarizeValue handles primitives, null, and short strings untouched', () => {
      expect(summarizeValue(null)).toBeNull();
      expect(summarizeValue(undefined)).toBeNull();
      expect(summarizeValue(42)).toBe(42);
      expect(summarizeValue('short string')).toBe('short string');
    });

    test('sanitizeArgs returns sanitized snapshot for plain objects', () => {
      const args = {
        payload: Array.from({ length: 7 }, (_, index) => index),
        hugeText: 'y'.repeat(210),
        nested: { foo: 'bar' },
      };

      const sanitized = sanitizeArgs(args)!;
      expect(Object.keys(sanitized)).toEqual(
        expect.arrayContaining(['payload', 'hugeText', 'nested'])
      );
      expect((sanitized.payload as unknown[]).length).toBe(5);
      expect((sanitized.hugeText as string).endsWith('…')).toBe(true);
      expect(sanitized.nested).toBe('[object]');
    });

    test('sanitizeArgs returns undefined for non-objects', () => {
      expect(sanitizeArgs(null)).toBeUndefined();
      expect(sanitizeArgs(42)).toBeUndefined();
    });

    test('sanitizeArgs limits entries to first ten keys', () => {
      const args = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`key${index}`, index])
      );
      const sanitized = sanitizeArgs(args)!;
      expect(Object.keys(sanitized)).toHaveLength(10);
      expect(sanitized.key0).toBe(0);
      expect(sanitized.key10).toBeUndefined();
    });
  });
});
