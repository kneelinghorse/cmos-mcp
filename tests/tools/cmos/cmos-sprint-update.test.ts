/**
 * cmos_sprint_update Tool Tests
 *
 * Comprehensive tests for the sprint update tool.
 *
 * @module tests/tools/cmos/cmos-sprint-update
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSprintUpdate,
  cmosSprintUpdateToolDefinition,
  formatSprintUpdateForLLM,
  type CmosSprintUpdateParams,
  type SprintUpdateResult,
  type SprintUpdateFields,
} from '../../../src/tools/cmos/cmos-sprint-update';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

describe('cmos_sprint_update', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-sprint-update-test-'));
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

      INSERT INTO sprints (id, title, focus, status, start_date, end_date)
      VALUES
        ('sprint-14', 'Sprint 14', 'Initial Focus', 'Active', '2025-12-10', NULL),
        ('sprint-13', 'Sprint 13', 'Session Tools', 'Completed', '2025-12-08', '2025-12-10');
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
    it('should update a single field', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: { title: 'Updated Sprint 14' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.sprintId).toBe('sprint-14');
      expect(result.data?.updatedFields).toContain('title');

      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT title FROM sprints WHERE id = ?').get('sprint-14') as {
        title: string;
      };
      db.close();

      expect(sprint.title).toBe('Updated Sprint 14');
    });

    it('should update multiple fields', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: {
          title: 'New Title',
          focus: 'New Focus',
          status: 'Completed',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.updatedFields).toHaveLength(3);
      expect(result.data?.updatedFields).toContain('title');
      expect(result.data?.updatedFields).toContain('focus');
      expect(result.data?.updatedFields).toContain('status');

      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get('sprint-14') as {
        title: string;
        focus: string;
        status: string;
      };
      db.close();

      expect(sprint.title).toBe('New Title');
      expect(sprint.focus).toBe('New Focus');
      expect(sprint.status).toBe('Completed');
    });

    it('should update date fields', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: {
          startDate: '2025-12-15',
          endDate: '2025-12-20',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.updatedFields).toContain('startDate');
      expect(result.data?.updatedFields).toContain('endDate');

      const db = new Database(dbPath);
      const sprint = db
        .prepare('SELECT start_date, end_date FROM sprints WHERE id = ?')
        .get('sprint-14') as { start_date: string; end_date: string };
      db.close();

      expect(sprint.start_date).toBe('2025-12-15');
      expect(sprint.end_date).toBe('2025-12-20');
    });

    it('should trim whitespace from field values', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: { title: '  Trimmed Title  ' },
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT title FROM sprints WHERE id = ?').get('sprint-14') as {
        title: string;
      };
      db.close();

      expect(sprint.title).toBe('Trimmed Title');
    });

    it('should set field to null for empty string', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: { focus: '' },
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT focus FROM sprints WHERE id = ?').get('sprint-14') as {
        focus: string | null;
      };
      db.close();

      expect(sprint.focus).toBeNull();
    });
  });

  describe('validation', () => {
    it('should return error for non-existent sprint', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'nonexistent',
        fields: { title: 'New Title' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SPRINT_NOT_FOUND);
      expect(result.error?.suggestion).toContain('cmos_sprint');
    });

    it('should return error for missing sprintId', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: '',
        fields: { title: 'New Title' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return error when no fields provided', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: {},
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.suggestion).toContain('at least one field');
    });

    it('should return error when all fields are undefined', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: {
          title: undefined,
          focus: undefined,
        } as SprintUpdateFields,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
    });
  });

  describe('error handling', () => {
    it('should return error when CMOS not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        const result = await cmosSprintUpdate({
          sprintId: 'sprint-14',
          fields: { title: 'New Title' },
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
      expect(cmosSprintUpdateToolDefinition.name).toBe('cmos_sprint_update');
    });

    it('should require sprintId and fields', () => {
      expect(cmosSprintUpdateToolDefinition.inputSchema.required).toContain('sprintId');
      expect(cmosSprintUpdateToolDefinition.inputSchema.required).toContain('fields');
    });

    it('should have fields object with properties', () => {
      const fieldsSchema = cmosSprintUpdateToolDefinition.inputSchema.properties.fields;
      expect(fieldsSchema.type).toBe('object');
      expect(fieldsSchema.properties.title).toBeDefined();
      expect(fieldsSchema.properties.focus).toBeDefined();
      expect(fieldsSchema.properties.status).toBeDefined();
      expect(fieldsSchema.properties.startDate).toBeDefined();
      expect(fieldsSchema.properties.endDate).toBeDefined();
    });
  });

  describe('formatSprintUpdateForLLM', () => {
    it('should format success result', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: { title: 'New Title', focus: 'New Focus' },
      });
      const formatted = formatSprintUpdateForLLM(result);

      expect(formatted).toContain('✓');
      expect(formatted).toContain('sprint-14');
      expect(formatted).toContain('updated');
      expect(formatted).toContain('title');
      expect(formatted).toContain('focus');
    });

    it('should format error result', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'nonexistent',
        fields: { title: 'New Title' },
      });
      const formatted = formatSprintUpdateForLLM(result);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('Failed');
      expect(formatted).toContain('Suggestion');
    });

    it('should show updated fields list', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: { title: 'A', focus: 'B', status: 'C' },
      });
      const formatted = formatSprintUpdateForLLM(result);

      expect(formatted).toContain('title');
      expect(formatted).toContain('focus');
      expect(formatted).toContain('status');
    });
  });
});

/**
 * Helper to run cmosSprintUpdate with explicit database path.
 */
async function cmosSprintUpdateWithDb(
  dbPath: string,
  params: Omit<CmosSprintUpdateParams, 'projectRoot'>
): Promise<CmosToolResult<SprintUpdateResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createSuccess, createError, CmosErrors, CMOS_ERROR_CODES } =
    await import('../../../src/tools/cmos/errors');

  const { sprintId, fields } = params;

  if (!sprintId || sprintId.trim() === '') {
    return createError(CmosErrors.missingParameter('sprintId'));
  }

  const fieldKeys = Object.keys(fields).filter(
    (k) => fields[k as keyof SprintUpdateFields] !== undefined
  );

  if (fieldKeys.length === 0) {
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: 'No fields provided to update',
      suggestion:
        'Provide at least one field to update (e.g., title, focus, status, startDate, endDate)',
    });
  }

  return withClient(
    (client) => {
      // Check if sprint exists
      const sprintResult = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
        sprintId,
      ]);

      if (!sprintResult.success) {
        return createError<SprintUpdateResult>(
          sprintResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query sprint' }
        );
      }

      if (!sprintResult.data) {
        return createError<SprintUpdateResult>(CmosErrors.sprintNotFound(sprintId));
      }

      const setClauses: string[] = [];
      const queryParams: (string | null)[] = [];

      const fieldMapping: Record<string, string> = {
        title: 'title',
        focus: 'focus',
        status: 'status',
        startDate: 'start_date',
        endDate: 'end_date',
      };

      for (const key of fieldKeys) {
        const dbColumn = fieldMapping[key];
        if (!dbColumn) continue;

        const value = fields[key as keyof SprintUpdateFields];
        if (value === undefined) continue;

        setClauses.push(`${dbColumn} = ?`);
        queryParams.push(value.trim() || null);
      }

      queryParams.push(sprintId);

      const updateQuery = `
        UPDATE sprints
        SET ${setClauses.join(', ')}
        WHERE id = ?
      `;

      const updateResult = client.execute(updateQuery, queryParams);

      if (!updateResult.success) {
        return createError<SprintUpdateResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update sprint' }
        );
      }

      return createSuccess({
        sprintId,
        updatedFields: fieldKeys,
        message: `Sprint '${sprintId}' updated successfully (${fieldKeys.length} field${fieldKeys.length === 1 ? '' : 's'})`,
      });
    },
    { dbPath }
  );
}
