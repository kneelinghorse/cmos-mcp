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
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

const DEPRECATED_TOOL_NAMES = [
  'get_available_domains',
  'create_mission',
  'get_mission_quality_score',
  'create_mission_splits',
  'rbook_sprint_list',
  'rbook_sprint_show',
  'rbook_sprint_add',
  'rbook_sprint_update',
  'rbook_sprint_complete',
  'rbook_mission_list',
  'rbook_mission_show',
  'rbook_mission_status',
  'rbook_mission_start',
  'rbook_mission_complete',
  'rbook_mission_block',
  'rbook_mission_unblock',
  'rbook_mission_update',
  'rbook_mission_add',
  'rbook_mission_depends',
  'rbook_context_view',
  'rbook_context_update',
  'rbook_context_condense',
  'rbook_context_snapshot',
  'rbook_context_history',
  'rbook_session_start',
  'rbook_session_capture',
  'rbook_session_complete',
  'rbook_session_list',
  'rbook_decisions_list',
  'rbook_decisions_search',
  'rbook_db_health',
  'rbook_db_snapshot',
  'rbook_db_restore',
  'rbook_project_register',
  'rbook_project_list',
  'rbook_project_unregister',
  'rbook_project_validate',
  'rbook_project_init',
] as const;

describe('Mission Protocol entry point', () => {
  test('exposes tool definitions with expected identifiers', () => {
    const definitions = getToolDefinitions();
    const names = definitions.map((def) => def.name);

    expect(names).toContain('rbook_mission');
    expect(names).toContain('rbook_mission_transition');
    expect(names).toContain('rbook_sprint');
    expect(names).toContain('rbook_context');
    expect(names).toContain('rbook_session');
    expect(names).toContain('rbook_decisions');
    expect(names).toContain('rbook_db');
    expect(names).toContain('rbook_project');
    expect(names).toContain('rbook_agent_onboard');

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
        code: ProtocolErrorCode.MethodNotFound,
      });
    });

    test('throws MCP error for unknown tool names', async () => {
      await expect(executeMissionProtocolTool('unknown_tool', {}, context)).rejects.toMatchObject({
        code: ProtocolErrorCode.MethodNotFound,
      });
      await expect(executeMissionProtocolTool('unknown_tool', {}, context)).rejects.toBeInstanceOf(
        ProtocolError
      );
    });

    test('rbook_project(action=init) passes projectRoot literally without sender-context rewrite', async () => {
      // Regression: the dispatcher previously routed every rbook_project action
      // through resolveToolSenderContext. For init, that resolver fell back to
      // the caller's own project when the target had no Reasonbook DB, clobbering
      // the caller's metadata with a fresh seed.
      const fs = await import('fs');
      const os = await import('os');
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-init-dispatcher-'));
      try {
        const result = await executeMissionProtocolTool(
          'rbook_project',
          { action: 'init', projectRoot: tmpRoot, projectName: 'dispatcher-regression' },
          context
        );
        const structured = (
          result as { structuredContent?: { data?: { rbookDirectory?: string } } }
        ).structuredContent;
        expect(structured?.data?.rbookDirectory).toBe(path.join(tmpRoot, 'rbook'));
        expect(fs.existsSync(path.join(tmpRoot, 'rbook', 'db', 'rbook.sqlite'))).toBe(true);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    test('Sprint 65 m02: project_identity.rbook_address survives planning session lifecycle + onboard', async () => {
      // Regression: pre-fix, backfillUnknownRbookAddress (called unguarded from
      // rbook_agent_onboard:455 and checkpoint-backfill:68) silently rewrote a
      // user-set rbook_address back to the metadata-derived canonical form on
      // the next observation pass. The operator attributed this to the
      // session-complete aggregation path in decision #682, but the actual
      // trigger was the next rbook_agent_onboard call — session-complete does
      // not touch project_identity. This test exercises the full lifecycle
      // (flip → session start → capture → complete → onboard) to confirm the
      // flipped address survives every step. Also asserts other identity
      // fields (foundational_docs, description) survive the same lifecycle —
      // success criterion 4.
      const fs = await import('fs');
      const os = await import('os');
      const Database = (await import('better-sqlite3')).default;
      const originalCwd = process.cwd;

      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-identity-drift-'));

      try {
        await executeMissionProtocolTool(
          'rbook_project',
          { action: 'init', projectRoot, projectName: 'identity-drift-test' },
          context
        );

        // Seed metadata.owner so backfillUnknownRbookAddress has the worst-case
        // ammo to silently re-canonicalize on the next onboard. Pre-fix, this
        // is what makes the bug bite; post-fix, the guard prevents the rewrite.
        const db = new Database(path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite'));
        db.exec(
          `INSERT OR REPLACE INTO metadata (key, value) VALUES ('owner', 'test-owner'), ('dashboard_slug', 'identity-drift-test')`
        );
        db.close();

        process.cwd = () => projectRoot;

        // Flip rbook_address to a fork-style address that differs from the
        // metadata-derived canonical form. Also flip foundational_docs and
        // description so we can assert other identity fields survive too.
        const flippedAddress = 'rbook://test-owner/identity-drift-test-fork';
        const foundationalDocsValue = [{ title: 'Fork Spec', path: 'docs/fork.md' }];
        await executeMissionProtocolTool(
          'rbook_context',
          {
            action: 'update',
            contextType: 'project_identity',
            fieldUpdates: [
              { path: 'rbook_address', value: flippedAddress },
              { path: 'foundational_docs', value: foundationalDocsValue },
              { path: 'description', value: 'Pro fork descriptor' },
            ],
          },
          context
        );

        // Run a full planning session lifecycle. Mission says planning-close
        // is the suspected trigger.
        const startResult = (await executeMissionProtocolTool(
          'rbook_session',
          { action: 'start', type: 'planning', title: 'Identity drift regression session' },
          context
        )) as { structuredContent?: { success?: boolean; data?: { sessionId?: string } } };
        const sessionId = startResult.structuredContent?.data?.sessionId;
        expect(sessionId).toBeDefined();

        await executeMissionProtocolTool(
          'rbook_session',
          {
            action: 'capture',
            sessionId,
            category: 'context',
            content: 'noop capture to exercise the aggregation path',
          },
          context
        );

        await executeMissionProtocolTool(
          'rbook_session',
          {
            action: 'complete',
            sessionId,
            summary: 'identity drift regression close',
          },
          context
        );

        // The actual bug trigger: rbook_agent_onboard calls backfillUnknownRbookAddress.
        // Pre-fix, this reverts rbook_address to 'rbook://test-owner/identity-drift-test'.
        // Post-fix, the guard preserves the flipped value.
        await executeMissionProtocolTool('rbook_agent_onboard', {}, context);

        // Inspect identity after the full lifecycle. All flipped fields must persist.
        const viewResult = (await executeMissionProtocolTool(
          'rbook_context',
          { action: 'view', contextType: 'project_identity' },
          context
        )) as {
          structuredContent?: {
            success?: boolean;
            data?: {
              projectIdentity?: {
                rbook_address?: string;
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
        expect(identity?.rbook_address).toBe(flippedAddress);
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

    test('Sprint 65 m01: rbook_mission(action=show) pins to CWD project, never fans out across registry', async () => {
      // Regression: pre-fix, rbook_mission(show) was in READ_ACTIONS so the
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

      const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-show-cwd-'));
      const siblingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-show-sibling-'));

      try {
        // Initialize two real Reasonbook workspaces so both are registry-eligible
        await executeMissionProtocolTool(
          'rbook_project',
          { action: 'init', projectRoot: cwdRoot, projectName: 's65-m01-cwd' },
          context
        );
        await executeMissionProtocolTool(
          'rbook_project',
          { action: 'init', projectRoot: siblingRoot, projectName: 's65-m01-sibling' },
          context
        );

        // Insert a mission with the same ID into both DBs, with distinguishing
        // names — the fan-out bug would have returned both rows.
        const sharedMissionId = 's65-m01-regression-fixture';
        const insertMission = (root: string, name: string): void => {
          const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
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
          'rbook_mission',
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
