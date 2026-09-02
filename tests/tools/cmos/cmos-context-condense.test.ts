/**
 * cmos_context_condense Tool Tests
 *
 * Tests for the context condensation tool covering all three strategies,
 * dryRun mode, deduplication logic, size calculations, and edge cases.
 *
 * @module tests/tools/cmos/cmos-context-condense
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosContextCondense,
  cmosContextCondenseToolDefinition,
  formatContextCondenseForLLM,
  type CmosContextCondenseResult,
  type CmosContextCondenseParams,
} from '../../../src/tools/cmos/cmos-context-condense';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

describe('cmos_context_condense', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-context-condense-test-'));
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE context_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL,
        session_id TEXT,
        source TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.close();

    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function seedContext(contextType: string, content: Record<string, unknown>): void {
    const sourcePath =
      contextType === 'master_context'
        ? 'context/MASTER_CONTEXT.json'
        : 'context/PROJECT_CONTEXT.json';
    const db = new Database(dbPath);
    db.exec(`
      INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at)
      VALUES ('${contextType}', '${sourcePath}', '${JSON.stringify(content).replace(/'/g, "''")}', '2024-01-01T00:00:00Z');
    `);
    db.close();
  }

  function seedSprints(sprints: Array<{ id: string; status: string }>): void {
    const db = new Database(dbPath);
    for (const s of sprints) {
      db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)').run(
        s.id,
        `Sprint ${s.id}`,
        s.status
      );
    }
    db.close();
  }

  function seedMissions(missions: Array<{ id: string; sprintId: string; status: string }>): void {
    const db = new Database(dbPath);
    for (const m of missions) {
      db.prepare('INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, ?, ?)').run(
        m.id,
        m.sprintId,
        `Mission ${m.id}`,
        m.status
      );
    }
    db.close();
  }

  function getProjectRoot(): string {
    return path.dirname(path.dirname(path.dirname(dbPath)));
  }

  async function runCondense(
    params: Partial<CmosContextCondenseParams> & {
      contextType: 'master_context' | 'project_context';
    },
    internalOptions?: { preserveNextStepProse?: boolean }
  ): Promise<CmosToolResult<CmosContextCondenseResult>> {
    CmosDetector.resetInstance();
    return cmosContextCondense(
      {
        ...params,
        projectRoot: getProjectRoot(),
      } as CmosContextCondenseParams,
      internalOptions
    );
  }

  describe('context not found', () => {
    it('should return error when context does not exist', async () => {
      const result = await runCondense({ contextType: 'master_context' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.CONTEXT_NOT_FOUND);
    });
  });

  describe('empty context', () => {
    it('should handle empty context gracefully', async () => {
      seedContext('master_context', {});

      const result = await runCondense({ contextType: 'master_context', strategy: 'auto' });

      expect(result.success).toBe(true);
      expect(result.data?.reductionPercent).toBe(0);
      expect(result.data?.sectionsCondensed).toEqual([]);
    });
  });

  describe('dryRun mode', () => {
    it('should return condensation plan without writing', async () => {
      const history = Array.from({ length: 10 }, (_, i) => ({
        session: `s${i}`,
        summary: `Session ${i}`,
      }));
      seedContext('master_context', {
        working_memory: { session_history: history },
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'auto',
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.dryRun).toBe(true);
      expect(result.data?.snapshotId).toBeNull();

      // Verify no changes were written
      const db = new Database(dbPath);
      const context = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      db.close();

      const parsed = JSON.parse(context.content);
      expect(parsed.working_memory.session_history).toHaveLength(10); // Unchanged in dryRun
    });

    it('should show what would be condensed in dryRun', async () => {
      const history = Array.from({ length: 10 }, (_, i) => ({
        session: `s${i}`,
        summary: `Session ${i}`,
      }));
      seedContext('master_context', {
        working_memory: { session_history: history },
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'auto',
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.dryRun).toBe(true);
      // Should show session_history pruning would happen
      expect(result.data?.sectionsCondensed.length).toBeGreaterThan(0);
    });

    it('should include preview details for removed content in dryRun', async () => {
      seedMissions([
        { id: 's01-m01', sprintId: 'sprint-01', status: 'Completed' },
        { id: 's01-m02', sprintId: 'sprint-01', status: 'Completed' },
      ]);

      seedContext('master_context', {
        next_steps: [
          'Start s01-m01 implementation',
          'Review s01-m02 progress',
          'General planning task',
        ],
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'conservative',
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sectionsCondensed.length).toBeGreaterThan(0);
    });
  });

  describe('conservative strategy', () => {
    it('should remove stale next_steps referencing completed missions', async () => {
      seedMissions([
        { id: 's01-m01', sprintId: 'sprint-01', status: 'Completed' },
        { id: 's02-m01', sprintId: 'sprint-02', status: 'In Progress' },
      ]);

      seedContext('master_context', {
        next_steps: [
          'Start s01-m01 implementation',
          'Review s02-m01 progress',
          'General planning task',
        ],
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'conservative',
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const context = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      db.close();

      const parsed = JSON.parse(context.content);
      expect(parsed.next_steps).not.toContain('Start s01-m01 implementation');
      expect(parsed.next_steps).toContain('Review s02-m01 progress');
      expect(parsed.next_steps).toContain('General planning task');
    });

    it('preserves next-step prose for internal callers without disabling other condensation', async () => {
      seedMissions([{ id: 's01-m01', sprintId: 'sprint-01', status: 'Completed' }]);

      const outstandingStep = 'Start s01-m01 follow-up that remains outstanding';
      const history = Array.from({ length: 10 }, (_, i) => ({ session: `s${i}` }));
      seedContext('master_context', {
        next_steps: [outstandingStep],
        working_memory: {
          next_steps: [outstandingStep],
          session_history: history,
        },
        next_session_context: {
          when_we_resume: [outstandingStep],
        },
      });

      const result = await runCondense(
        {
          contextType: 'master_context',
          strategy: 'auto',
        },
        { preserveNextStepProse: true }
      );

      expect(result.success).toBe(true);
      expect(Object.keys(cmosContextCondenseToolDefinition.inputSchema.properties)).not.toContain(
        'preserveNextStepProse'
      );

      const db = new Database(dbPath);
      const context = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      db.close();

      const parsed = JSON.parse(context.content);
      expect(parsed.next_steps).toEqual([outstandingStep]);
      expect(parsed.working_memory.next_steps).toEqual([outstandingStep]);
      expect(parsed.next_session_context.when_we_resume).toEqual([outstandingStep]);
      expect(parsed.working_memory.session_history).toHaveLength(5);
      expect(result.data?.sectionsCondensed.map((section) => section.section)).toEqual([
        'working_memory.session_history',
      ]);
    });
  });

  describe('auto strategy', () => {
    it('should prune session_history to last 5 entries', async () => {
      const history = Array.from({ length: 10 }, (_, i) => ({
        session: `s${i}`,
        summary: `Session ${i}`,
      }));

      seedContext('master_context', {
        working_memory: { session_history: history },
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'auto',
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const context = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      db.close();

      const parsed = JSON.parse(context.content);
      expect(parsed.working_memory.session_history).toHaveLength(5);
      // Should keep the latest entries
      expect(parsed.working_memory.session_history[4].session).toBe('s9');
    });
  });

  describe('aggressive strategy', () => {
    it('should limit context_notes to last 15 entries', async () => {
      seedContext('master_context', {
        context_notes: Array.from({ length: 20 }, (_, i) => `Note ${i + 1}`),
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'aggressive',
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const context = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      db.close();

      const parsed = JSON.parse(context.content);
      expect(parsed.context_notes).toHaveLength(15);
      // Should keep the latest
      expect(parsed.context_notes[14]).toBe('Note 20');
    });
  });

  describe('snapshot creation', () => {
    it('should create auto-snapshot before mutation', async () => {
      const history = Array.from({ length: 10 }, (_, i) => ({ session: `s${i}` }));
      seedContext('master_context', {
        working_memory: { session_history: history },
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'auto',
      });

      expect(result.success).toBe(true);
      expect(result.data?.snapshotId).toBeDefined();
      expect(result.data?.snapshotId).not.toBeNull();

      // Verify snapshot exists
      const db = new Database(dbPath);
      const snapshot = db
        .prepare('SELECT * FROM context_snapshots WHERE id = ?')
        .get(result.data?.snapshotId) as { source: string; context_id: string };
      db.close();

      expect(snapshot.context_id).toBe('master_context');
      expect(snapshot.source).toContain('context_condense');
    });

    it('should not create snapshot in dryRun', async () => {
      const history = Array.from({ length: 10 }, (_, i) => ({ session: `s${i}` }));
      seedContext('master_context', {
        working_memory: { session_history: history },
      });

      await runCondense({
        contextType: 'master_context',
        strategy: 'auto',
        dryRun: true,
      });

      const db = new Database(dbPath);
      const count = db.prepare('SELECT COUNT(*) as count FROM context_snapshots').get() as {
        count: number;
      };
      db.close();

      expect(count.count).toBe(0);
    });
  });

  describe('size reporting', () => {
    it('should report before/after sizes and reduction percent', async () => {
      seedContext('master_context', {
        context_notes: Array.from({ length: 20 }, (_, i) => `Note ${i}: ${'x'.repeat(100)}`),
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'aggressive',
      });

      expect(result.success).toBe(true);
      expect(result.data?.beforeSize.sizeBytes).toBeGreaterThan(0);
      expect(result.data?.afterSize.sizeBytes).toBeGreaterThan(0);
      expect(result.data?.afterSize.sizeBytes).toBeLessThanOrEqual(
        result.data!.beforeSize.sizeBytes
      );
      expect(result.data?.reductionPercent).toBeGreaterThan(0);
    });

    it('should prune session_history when above target', async () => {
      seedContext('master_context', {
        context_health: {
          size_limit_kb: 2,
          warning_threshold_percent: 75,
        },
        working_memory: {
          session_history: Array.from({ length: 10 }, (_, i) => ({
            session: `s${i}`,
            summary: `Session ${i}`,
          })),
        },
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'auto',
        targetSizePercent: 1, // unreachably small — forces all phases to run
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const context = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      db.close();

      const parsed = JSON.parse(context.content);
      // Auto strategy prunes session_history to 5
      expect(parsed.working_memory.session_history).toHaveLength(5);
    });

    it('should report when the requested target cannot be met with available rules', async () => {
      seedContext('master_context', {
        context_health: {
          size_limit_kb: 1,
          warning_threshold_percent: 75,
        },
        // Use a static object that conservative strategy cannot condense
        project_identity: { name: 'CMOS-MCP', description: 'A'.repeat(800) },
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'conservative',
        targetSizePercent: 10,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.targetMet).toBe(false);
      expect(
        result.warnings?.some((warning) => warning.includes('remains above target size'))
      ).toBe(true);
    });
  });

  describe('project_context support', () => {
    it('should condense project_context working_memory', async () => {
      seedMissions([{ id: 's01-m01', sprintId: 'sprint-01', status: 'Completed' }]);

      seedContext('project_context', {
        working_memory: {
          session_history: Array.from({ length: 10 }, (_, i) => ({ session: `s${i}` })),
          next_steps: ['Start s01-m01 work', 'Plan next sprint'],
        },
      });

      const result = await runCondense({
        contextType: 'project_context',
        strategy: 'auto',
      });

      expect(result.success).toBe(true);
      expect(result.data?.contextType).toBe('project_context');

      const db = new Database(dbPath);
      const context = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('project_context') as { content: string };
      db.close();

      const parsed = JSON.parse(context.content);
      expect(parsed.working_memory.session_history).toHaveLength(5);
      expect(parsed.working_memory.next_steps).not.toContain('Start s01-m01 work');
      expect(parsed.working_memory.next_steps).toContain('Plan next sprint');
    });
  });

  describe('edge cases', () => {
    it('should handle context with no condensable arrays', async () => {
      seedContext('master_context', {
        project: { name: 'Test' },
        version: '1.0',
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'aggressive',
      });

      expect(result.success).toBe(true);
      expect(result.data?.sectionsCondensed).toEqual([]);
    });

    it('should not touch blob sections now served from structured tables', async () => {
      // decisions_made, learnings, completed_missions, recent_sessions are no longer
      // stored in the master_context blob (Sprint 51 blob reduction). Condense leaves
      // any residual blob content for these keys untouched.
      seedContext('master_context', {
        decisions_made: ['Decision A', 'Decision B'],
        learnings: ['Learning A', 'Learning B'],
      });

      const result = await runCondense({
        contextType: 'master_context',
        strategy: 'aggressive',
      });

      expect(result.success).toBe(true);
      expect(result.data?.sectionsCondensed).toEqual([]); // nothing touched

      const db = new Database(dbPath);
      const context = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      db.close();

      const parsed = JSON.parse(context.content);
      // Untouched — condense ignores these sections
      expect(parsed.decisions_made).toHaveLength(2);
      expect(parsed.learnings).toHaveLength(2);
    });
  });

  describe('error handling', () => {
    it('should return structured phase diagnostics when condensation throws', async () => {
      seedContext('master_context', {
        __triggerCondenseFailure: true,
      });

      const originalStringify = JSON.stringify;
      const stringifySpy = jest.spyOn(JSON, 'stringify').mockImplementation(((
        value: unknown,
        replacer?: unknown,
        space?: string | number
      ) => {
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          '__triggerCondenseFailure' in value
        ) {
          throw new Error('Synthetic serialization failure');
        }
        return originalStringify(
          value,
          replacer as Parameters<typeof JSON.stringify>[1],
          space as Parameters<typeof JSON.stringify>[2]
        );
      }) as typeof JSON.stringify);

      try {
        const result = await runCondense({
          contextType: 'master_context',
          strategy: 'auto',
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CONTEXT_CONDENSATION_FAILED);
        expect(result.error?.phase).toBe('serialize_context');
        expect(result.error?.operation).toBe('JSON.stringify(updated content)');
        expect(result.error?.details).toContain('Synthetic serialization failure');
      } finally {
        stringifySpy.mockRestore();
      }
    });

    it('should return error when CMOS not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        CmosDetector.resetInstance();
        const result = await cmosContextCondense({
          contextType: 'master_context',
          projectRoot: emptyDir,
        } as CmosContextCondenseParams);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosContextCondenseToolDefinition.name).toBe('cmos_context_condense');
    });

    it('should have description', () => {
      expect(cmosContextCondenseToolDefinition.description).toBeTruthy();
    });

    it('should have valid input schema with required contextType', () => {
      expect(cmosContextCondenseToolDefinition.inputSchema.type).toBe('object');
      expect(cmosContextCondenseToolDefinition.inputSchema.required).toContain('contextType');
    });
  });

  describe('formatContextCondenseForLLM', () => {
    it('should format success result', () => {
      const result: CmosToolResult<CmosContextCondenseResult> = {
        success: true,
        data: {
          beforeSize: {
            sizeBytes: 50000,
            sizeKb: 48.83,
            limitKb: 100,
            warningThresholdPercent: 75,
            usagePercent: 48.83,
            nearLimit: false,
          },
          afterSize: {
            sizeBytes: 20000,
            sizeKb: 19.53,
            limitKb: 100,
            warningThresholdPercent: 75,
            usagePercent: 19.53,
            nearLimit: false,
          },
          reductionPercent: 60,
          targetSizeKb: 60,
          targetSizePercent: 60,
          targetMet: true,
          sectionsCondensed: [
            {
              section: 'decisions_made',
              beforeBytes: 5000,
              afterBytes: 2000,
              action: 'Deduplicated: 10 → 5 entries',
            },
          ],
          snapshotId: 42,
          strategy: 'auto',
          dryRun: false,
          contextType: 'master_context',
          message: 'Condensed master_context from 48.83KB to 19.53KB',
        },
      };

      const formatted = formatContextCondenseForLLM(result);

      expect(formatted).toContain('Context Condense');
      expect(formatted).toContain('auto');
      expect(formatted).toContain('48.83KB');
      expect(formatted).toContain('19.53KB');
      expect(formatted).toContain('60%');
      expect(formatted).toContain('#42');
      expect(formatted).toContain('decisions_made');
    });

    it('should format dryRun result', () => {
      const result: CmosToolResult<CmosContextCondenseResult> = {
        success: true,
        data: {
          beforeSize: {
            sizeBytes: 50000,
            sizeKb: 48.83,
            limitKb: 100,
            warningThresholdPercent: 75,
            usagePercent: 48.83,
            nearLimit: false,
          },
          afterSize: {
            sizeBytes: 20000,
            sizeKb: 19.53,
            limitKb: 100,
            warningThresholdPercent: 75,
            usagePercent: 19.53,
            nearLimit: false,
          },
          reductionPercent: 60,
          targetSizeKb: 60,
          targetSizePercent: 60,
          targetMet: true,
          sectionsCondensed: [],
          snapshotId: null,
          strategy: 'conservative',
          dryRun: true,
          contextType: 'master_context',
          message: 'Dry run',
        },
      };

      const formatted = formatContextCondenseForLLM(result);
      expect(formatted).toContain('DRY RUN');
    });

    it('should format error result', () => {
      const result: CmosToolResult<CmosContextCondenseResult> = {
        success: false,
        error: {
          code: 'CONTEXT_NOT_FOUND',
          message: 'Context not found',
          suggestion: 'Check context type',
          phase: 'deduplicate_text_entries',
          operation: 'deduplicateArray',
          details: "Section 'learnings' shape: array(length=3, sampleTypes=string, object)",
        },
      };

      const formatted = formatContextCondenseForLLM(result);
      expect(formatted).toContain('Failed');
      expect(formatted).toContain('Context not found');
      expect(formatted).toContain('deduplicate_text_entries');
      expect(formatted).toContain('deduplicateArray');
      expect(formatted).toContain("Section 'learnings'");
    });
  });
});
