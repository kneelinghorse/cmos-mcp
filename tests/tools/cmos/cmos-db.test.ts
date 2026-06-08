import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-db-health', () => ({
  cmosDbHealth: jest.fn(),
  formatHealthForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-db-snapshot', () => ({
  cmosDbSnapshot: jest.fn(),
  formatDbSnapshotForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-db-restore', () => ({
  cmosDbRestore: jest.fn(),
  formatDbRestoreForLLM: jest.fn(),
}));

import {
  CMOS_DB_ACTIONS,
  cmosDb,
  cmosDbToolDefinition,
  formatDbForLLM,
} from '../../../src/tools/cmos/cmos-db';
import { cmosDbHealth } from '../../../src/tools/cmos/cmos-db-health';
import { cmosDbSnapshot } from '../../../src/tools/cmos/cmos-db-snapshot';
import { cmosDbRestore } from '../../../src/tools/cmos/cmos-db-restore';

describe('cmos_db', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes health action', async () => {
    const expected = { success: true, data: { healthy: true } } as any;
    (cmosDbHealth as jest.MockedFunction<typeof cmosDbHealth>).mockResolvedValueOnce(expected);

    const result = await cmosDb({ action: 'health', projectRoot: '/tmp/test' });
    expect(cmosDbHealth).toHaveBeenCalledWith({ projectRoot: '/tmp/test' });
    expect(result).toBe(expected);
  });

  it('routes snapshot action', async () => {
    const expected = { success: true, data: { snapshots: [] } } as any;
    (cmosDbSnapshot as jest.MockedFunction<typeof cmosDbSnapshot>).mockResolvedValueOnce(expected);

    const result = await cmosDb({ action: 'snapshot', listOnly: true, maxSnapshots: 5 });
    expect(cmosDbSnapshot).toHaveBeenCalledWith({
      listOnly: true,
      maxSnapshots: 5,
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('routes restore action', async () => {
    const expected = { success: true, data: { restored: true } } as any;
    (cmosDbRestore as jest.MockedFunction<typeof cmosDbRestore>).mockResolvedValueOnce(expected);

    const result = await cmosDb({
      action: 'restore',
      snapshotId: 'snap-001',
      confirm: true,
    });
    expect(cmosDbRestore).toHaveBeenCalledWith({
      snapshotId: 'snap-001',
      confirm: true,
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('defaults snapshotId and confirm for restore', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosDbRestore as jest.MockedFunction<typeof cmosDbRestore>).mockResolvedValueOnce(expected);

    await cmosDb({ action: 'restore' });
    expect(cmosDbRestore).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: '', confirm: false })
    );
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await cmosDb({ action: 'drop' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(cmosDbToolDefinition.name).toBe('cmos_db');
    });
    it('requires action', () => {
      expect(cmosDbToolDefinition.inputSchema.required).toContain('action');
    });
    it('disallows additional properties', () => {
      expect(cmosDbToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('CMOS_DB_ACTIONS', () => {
    it('contains 9 actions', () => {
      expect(CMOS_DB_ACTIONS).toHaveLength(9);
      expect([...CMOS_DB_ACTIONS]).toEqual([
        'health',
        'snapshot',
        'restore',
        'backfill',
        'reconcile',
        'purge',
        'identify_orphans',
        'pull',
        'clone',
      ]);
    });
  });

  describe('formatDbForLLM', () => {
    it('formats INVALID_ACTION errors', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['health', 'snapshot', 'restore'],
        },
      };
      expect(formatDbForLLM(undefined, result)).toContain('Failed to execute cmos_db');
    });

    it('returns fallback for unknown action', () => {
      expect(formatDbForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Database action completed'
      );
    });
  });
});
