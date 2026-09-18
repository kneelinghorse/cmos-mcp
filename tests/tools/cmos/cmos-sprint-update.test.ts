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
    fs.mkdirSync(path.join(tempDir, 'cmos', 'db'), { recursive: true });
    dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');

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
      // s91-m02: the refusal names the wrapper the caller was missing, not bare field names.
      expect(result.error?.suggestion).toContain('fields');
    });

    it('refuses an unknown key inside fields by name instead of reporting it as written', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: { bogus: 'y', focus: 'x' } as unknown as SprintUpdateFields,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.field).toBe('fields.bogus');
      expect(result.error?.validValues).toContain('focus');
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT focus FROM sprints WHERE id = ?').get('sprint-14') as {
        focus: string;
      };
      db.close();
      expect(row.focus).toBe('Initial Focus');
    });

    it('refuses an all-unknown fields object instead of executing an empty UPDATE', async () => {
      const result = await cmosSprintUpdateWithDb(dbPath, {
        sprintId: 'sprint-14',
        fields: { bogus: 'y' } as unknown as SprintUpdateFields,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.field).toBe('fields.bogus');
      expect(result.error?.suggestion ?? '').not.toContain('SQL');
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
 * s91-m02: drive the REAL handler. This helper used to re-implement cmosSprintUpdate line for line,
 * so no assertion in this file could fail when src/ changed — the s91-m02 RED stayed red against a
 * fixed handler because the copy, not the handler, was under test. The fixture's store sits in the
 * standard `cmos/db/cmos.sqlite` layout so the handler resolves it from `projectRoot`.
 */
async function cmosSprintUpdateWithDb(
  dbPath: string,
  params: Omit<CmosSprintUpdateParams, 'projectRoot'>
): Promise<CmosToolResult<SprintUpdateResult>> {
  return cmosSprintUpdate({
    ...params,
    projectRoot: path.dirname(path.dirname(path.dirname(dbPath))),
  });
}
