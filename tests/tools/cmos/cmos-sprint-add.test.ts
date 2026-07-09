/**
 * cmos_sprint_add Tool Tests
 *
 * Comprehensive tests for the sprint creation tool.
 *
 * @module tests/tools/cmos/cmos-sprint-add
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSprintAdd,
  cmosSprintAddToolDefinition,
  formatSprintAddForLLM,
  type CmosSprintAddParams,
  type SprintAddResult,
} from '../../../src/tools/cmos/cmos-sprint-add';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

describe('cmos_sprint_add', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-sprint-add-test-'));
    dbPath = path.join(tempDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER
      );

      INSERT INTO sprints (id, title, status)
      VALUES ('sprint-13', 'Sprint 13', 'Completed');
    `);
    db.close();

    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic functionality', () => {
    it('should create a new sprint with required fields', async () => {
      const result = await cmosSprintAddWithDb(dbPath, {
        sprintId: 'sprint-14',
        title: 'Sprint 14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('sprint-14');
      expect(result.data?.title).toBe('Sprint 14');
      expect(result.data?.message).toContain('created successfully');

      // Verify in database
      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get('sprint-14') as {
        id: string;
        title: string;
        status: string;
      };
      db.close();

      expect(sprint.id).toBe('sprint-14');
      expect(sprint.title).toBe('Sprint 14');
      expect(sprint.status).toBe('Active'); // Default status
    });

    it('should create sprint with all optional fields', async () => {
      const result = await cmosSprintAddWithDb(dbPath, {
        sprintId: 'sprint-14',
        title: 'Sprint 14',
        focus: 'Sprint CRUD Tools',
        status: 'Planned',
        startDate: '2025-12-10',
        endDate: '2025-12-15',
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get('sprint-14') as {
        id: string;
        title: string;
        focus: string;
        status: string;
        start_date: string;
        end_date: string;
      };
      db.close();

      expect(sprint.focus).toBe('Sprint CRUD Tools');
      expect(sprint.status).toBe('Planned');
      expect(sprint.start_date).toBe('2025-12-10');
      expect(sprint.end_date).toBe('2025-12-15');
    });

    it('should trim whitespace from fields', async () => {
      const result = await cmosSprintAddWithDb(dbPath, {
        sprintId: 'sprint-14',
        title: '  Sprint 14  ',
        focus: '  Focus  ',
      });

      expect(result.success).toBe(true);
      expect(result.data?.title).toBe('Sprint 14');

      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get('sprint-14') as {
        title: string;
        focus: string;
      };
      db.close();

      expect(sprint.title).toBe('Sprint 14');
      expect(sprint.focus).toBe('Focus');
    });
  });

  describe('validation', () => {
    it('should return error for duplicate sprint ID', async () => {
      const result = await cmosSprintAddWithDb(dbPath, {
        sprintId: 'sprint-13', // Already exists
        title: 'Duplicate Sprint',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SPRINT_ID_EXISTS);
      expect(result.error?.suggestion).toContain('cmos_sprint');
    });

    it('should return error for missing sprintId', async () => {
      const result = await cmosSprintAddWithDb(dbPath, {
        sprintId: '',
        title: 'Sprint 14',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('sprintId');
    });

    it('should return error for missing title', async () => {
      const result = await cmosSprintAddWithDb(dbPath, {
        sprintId: 'sprint-14',
        title: '',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('title');
    });

    it('should return error for whitespace-only sprintId', async () => {
      const result = await cmosSprintAddWithDb(dbPath, {
        sprintId: '   ',
        title: 'Sprint 14',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('error handling', () => {
    it('should return error when CMOS not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        const result = await cmosSprintAdd({
          sprintId: 'sprint-14',
          title: 'Sprint 14',
          projectRoot: emptyDir,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosSprintAddToolDefinition.name).toBe('cmos_sprint_add');
    });

    it('should require sprintId and title', () => {
      expect(cmosSprintAddToolDefinition.inputSchema.required).toContain('sprintId');
      expect(cmosSprintAddToolDefinition.inputSchema.required).toContain('title');
    });

    it('should have optional fields', () => {
      const props = cmosSprintAddToolDefinition.inputSchema.properties;
      expect(props.focus).toBeDefined();
      expect(props.status).toBeDefined();
      expect(props.startDate).toBeDefined();
      expect(props.endDate).toBeDefined();
    });
  });

  describe('formatSprintAddForLLM', () => {
    it('should format success result', async () => {
      const result = await cmosSprintAddWithDb(dbPath, {
        sprintId: 'sprint-14',
        title: 'Sprint 14',
      });
      const formatted = formatSprintAddForLLM(result);

      expect(formatted).toContain('✓');
      expect(formatted).toContain('created successfully');
      expect(formatted).toContain('sprint-14');
      expect(formatted).toContain('Sprint 14');
    });

    it('should format error result', async () => {
      const result = await cmosSprintAddWithDb(dbPath, {
        sprintId: 'sprint-13',
        title: 'Duplicate',
      });
      const formatted = formatSprintAddForLLM(result);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('Failed');
      expect(formatted).toContain('Suggestion');
    });

    it('renders the single-current-sprint demotion warning (s77-m01)', () => {
      // index.ts surfaces only the formatted text, so a demotion warning must be
      // rendered here to reach the operator on the running server.
      const formatted = formatSprintAddForLLM({
        success: true,
        data: {
          id: 'sprint-b',
          title: 'Sprint B',
          message: "Sprint 'sprint-b' created successfully",
        },
        warnings: [
          "Demoted 1 other open sprint to 'Planned' to preserve a single current sprint: sprint-a.",
        ],
      });

      expect(formatted).toContain('Warnings:');
      expect(formatted).toContain('Demoted 1 other open sprint');
      expect(formatted).toContain('sprint-a');
    });
  });
});

/**
 * Helper to run cmosSprintAdd with explicit database path.
 */
async function cmosSprintAddWithDb(
  dbPath: string,
  params: Omit<CmosSprintAddParams, 'projectRoot'>
): Promise<CmosToolResult<SprintAddResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createSuccess, createError, CmosErrors } = await import('../../../src/tools/cmos/errors');

  const { sprintId, title, focus, status, startDate, endDate } = params;

  if (!sprintId || sprintId.trim() === '') {
    return createError(CmosErrors.missingParameter('sprintId'));
  }

  if (!title || title.trim() === '') {
    return createError(CmosErrors.missingParameter('title'));
  }

  return withClient(
    (client) => {
      // Check if sprint ID already exists
      const existingResult = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
        sprintId,
      ]);

      if (!existingResult.success) {
        return createError<SprintAddResult>(
          existingResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to check sprint' }
        );
      }

      if (existingResult.data) {
        return createError<SprintAddResult>(CmosErrors.sprintIdExists(sprintId));
      }

      // Insert new sprint
      const insertResult = client.execute(
        `INSERT INTO sprints (id, title, focus, status, start_date, end_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sprintId,
          title.trim(),
          focus?.trim() || null,
          status?.trim() || 'Active',
          startDate?.trim() || null,
          endDate?.trim() || null,
        ]
      );

      if (!insertResult.success) {
        return createError<SprintAddResult>(
          insertResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to create sprint' }
        );
      }

      return createSuccess({
        id: sprintId,
        title: title.trim(),
        message: `Sprint '${sprintId}' created successfully`,
      });
    },
    { dbPath }
  );
}
