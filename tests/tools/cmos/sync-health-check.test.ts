import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-db-backfill', () => ({
  cmosDbReconcile: jest.fn(),
}));

import {
  checkSyncHealth,
  formatSyncHealthForLLM,
  type SyncHealthCheckResult,
} from '../../../src/tools/cmos/sync-health-check';
import { cmosDbReconcile } from '../../../src/tools/cmos/cmos-db-backfill';

const mockReconcile = cmosDbReconcile as jest.MockedFunction<typeof cmosDbReconcile>;

describe('sync-health-check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('checkSyncHealth', () => {
    it('returns checked=false when dashboard is unreachable', async () => {
      mockReconcile.mockResolvedValueOnce({
        success: false,
        error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'Dashboard not configured' },
      });

      const result = await checkSyncHealth();
      expect(result.checked).toBe(false);
      expect(result.allMatch).toBe(false);
      expect(result.message).toContain('skipped');
    });

    it('returns allMatch=true when tables match', async () => {
      mockReconcile.mockResolvedValueOnce({
        success: true,
        data: {
          tables: [
            { table: 'missions', sqliteCount: 10, pgCount: 10, match: true, delta: 0 },
            { table: 'sessions', sqliteCount: 5, pgCount: 5, match: true, delta: 0 },
          ],
          allMatch: true,
          totalSqlite: 15,
          totalPg: 15,
          projectScoped: true,
          projectSlug: 'cmos-mcp',
          syncLogEntries: 100,
          failedEntries: 0,
          lastSyncAt: '2026-03-13T00:00:00.000Z',
        },
      });

      const result = await checkSyncHealth();
      expect(result.checked).toBe(true);
      expect(result.allMatch).toBe(true);
      expect(result.totalDelta).toBe(0);
    });

    it('detects drift and reports mismatches', async () => {
      mockReconcile.mockResolvedValueOnce({
        success: true,
        data: {
          tables: [
            { table: 'missions', sqliteCount: 10, pgCount: 8, match: false, delta: 2 },
            { table: 'sessions', sqliteCount: 5, pgCount: 5, match: true, delta: 0 },
          ],
          allMatch: false,
          totalSqlite: 15,
          totalPg: 13,
          projectScoped: true,
          projectSlug: 'cmos-mcp',
          syncLogEntries: 100,
          failedEntries: 0,
          lastSyncAt: '2026-03-13T00:00:00.000Z',
        },
      });

      const result = await checkSyncHealth();
      expect(result.checked).toBe(true);
      expect(result.allMatch).toBe(false);
      expect(result.totalDelta).toBe(2);
      expect(result.mismatchedTables).toBe(1);
      expect(result.mismatches[0].table).toBe('missions');
    });

    it('calculates totalDelta as sum of absolute deltas', async () => {
      mockReconcile.mockResolvedValueOnce({
        success: true,
        data: {
          tables: [
            { table: 'missions', sqliteCount: 10, pgCount: 15, match: false, delta: -5 },
            { table: 'sessions', sqliteCount: 8, pgCount: 5, match: false, delta: 3 },
          ],
          allMatch: false,
          totalSqlite: 18,
          totalPg: 20,
          projectScoped: true,
          projectSlug: 'cmos-mcp',
          syncLogEntries: 50,
          failedEntries: 0,
          lastSyncAt: null,
        },
      });

      const result = await checkSyncHealth();
      expect(result.totalDelta).toBe(8); // |−5| + |3| = 8
      expect(result.mismatchedTables).toBe(2);
    });
  });

  describe('formatSyncHealthForLLM', () => {
    it('formats unchecked result', () => {
      const result: SyncHealthCheckResult = {
        checked: false,
        allMatch: false,
        totalDelta: 0,
        mismatchedTables: 0,
        mismatches: [],
        message: 'Sync health check skipped: dashboard unreachable',
        warnings: [],
      };
      expect(formatSyncHealthForLLM(result)).toContain('skipped');
    });

    it('formats all-match result', () => {
      const result: SyncHealthCheckResult = {
        checked: true,
        allMatch: true,
        totalDelta: 0,
        mismatchedTables: 0,
        mismatches: [],
        message: 'Sync health: all tables match',
        warnings: [],
      };
      expect(formatSyncHealthForLLM(result)).toContain('all tables match');
    });

    it('formats drift with mismatches', () => {
      const result: SyncHealthCheckResult = {
        checked: true,
        allMatch: false,
        totalDelta: 10,
        mismatchedTables: 2,
        mismatches: [
          { table: 'missions', sqliteCount: 20, pgCount: 15, delta: 5 },
          { table: 'sessions', sqliteCount: 10, pgCount: 5, delta: 5 },
        ],
        message: 'Sync drift detected',
        warnings: [],
      };
      const formatted = formatSyncHealthForLLM(result);
      expect(formatted).toContain('drift');
      expect(formatted).toContain('missions');
      expect(formatted).toContain('sessions');
    });
  });
});
