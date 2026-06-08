import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-learnings-list', () => ({
  cmosLearningsList: jest.fn(),
  formatLearningsListForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-learnings-search', () => ({
  cmosLearningsSearch: jest.fn(),
  formatLearningsSearchForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-learnings-update', () => ({
  cmosLearningsUpdate: jest.fn(),
  formatLearningsUpdateForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-learnings-reaffirm', () => ({
  cmosLearningsReaffirm: jest.fn(),
  formatLearningsReaffirmForLLM: jest.fn(),
}));

import {
  CMOS_LEARNINGS_ACTIONS,
  cmosLearnings,
  cmosLearningsToolDefinition,
  formatLearningsForLLM,
} from '../../../src/tools/cmos/cmos-learnings';
import { cmosLearningsList } from '../../../src/tools/cmos/cmos-learnings-list';
import { cmosLearningsSearch } from '../../../src/tools/cmos/cmos-learnings-search';
import { cmosLearningsUpdate } from '../../../src/tools/cmos/cmos-learnings-update';
import { cmosLearningsReaffirm } from '../../../src/tools/cmos/cmos-learnings-reaffirm';

describe('cmos_learnings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action', async () => {
    const expected = { success: true, data: { learnings: [] } } as any;
    (cmosLearningsList as jest.MockedFunction<typeof cmosLearningsList>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosLearnings({
      action: 'list',
      category: 'technical',
      sprintId: 'sprint-38',
      page: 1,
      pageSize: 10,
    });
    expect(cmosLearningsList).toHaveBeenCalledWith({
      category: 'technical',
      sprintId: 'sprint-38',
      status: undefined,
      since: undefined,
      until: undefined,
      page: 1,
      pageSize: 10,
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('routes list action with status filter', async () => {
    const expected = { success: true, data: { learnings: [] } } as any;
    (cmosLearningsList as jest.MockedFunction<typeof cmosLearningsList>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosLearnings({
      action: 'list',
      status: 'active',
    });
    expect(cmosLearningsList).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    expect(result).toBe(expected);
  });

  it('routes search action', async () => {
    const expected = { success: true, data: { results: [] } } as any;
    (cmosLearningsSearch as jest.MockedFunction<typeof cmosLearningsSearch>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosLearnings({
      action: 'search',
      query: 'sync pipeline',
      limit: 5,
    });
    expect(cmosLearningsSearch).toHaveBeenCalledWith({
      query: 'sync pipeline',
      category: undefined,
      sprintId: undefined,
      limit: 5,
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('routes update action', async () => {
    const expected = { success: true, data: { learningId: 42 } } as any;
    (cmosLearningsUpdate as jest.MockedFunction<typeof cmosLearningsUpdate>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosLearnings({
      action: 'update',
      learningId: 42,
      status: 'archived',
    });
    expect(cmosLearningsUpdate).toHaveBeenCalledWith({
      learningId: 42,
      status: 'archived',
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await cmosLearnings({ action: 'delete' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults missing query to empty string for search', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosLearningsSearch as jest.MockedFunction<typeof cmosLearningsSearch>).mockResolvedValueOnce(
      expected
    );

    await cmosLearnings({ action: 'search' });
    expect(cmosLearningsSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '' }));
  });

  it('defaults missing learningId to 0 for update', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosLearningsUpdate as jest.MockedFunction<typeof cmosLearningsUpdate>).mockResolvedValueOnce(
      expected
    );

    await cmosLearnings({ action: 'update', status: 'archived' });
    expect(cmosLearningsUpdate).toHaveBeenCalledWith(expect.objectContaining({ learningId: 0 }));
  });

  it('routes reaffirm action', async () => {
    const expected = {
      success: true,
      data: { learningId: 7, status: 'active', reaffirmedAt: '2026-04-15T00:00:00Z' },
    } as any;
    (
      cmosLearningsReaffirm as jest.MockedFunction<typeof cmosLearningsReaffirm>
    ).mockResolvedValueOnce(expected);

    const result = await cmosLearnings({ action: 'reaffirm', learningId: 7 });
    expect(cmosLearningsReaffirm).toHaveBeenCalledWith({ learningId: 7, projectRoot: undefined });
    expect(result).toBe(expected);
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(cmosLearningsToolDefinition.name).toBe('cmos_learnings');
    });

    it('requires action', () => {
      expect(cmosLearningsToolDefinition.inputSchema.required).toContain('action');
    });

    it('has all action enums', () => {
      expect(cmosLearningsToolDefinition.inputSchema.properties.action.enum).toEqual([
        'list',
        'search',
        'update',
        'reaffirm',
      ]);
    });

    it('has category enum', () => {
      expect(cmosLearningsToolDefinition.inputSchema.properties.category.enum).toEqual([
        'technical',
        'process',
        'agent-behavior',
        'tooling',
      ]);
    });

    it('has status enum', () => {
      expect(cmosLearningsToolDefinition.inputSchema.properties.status.enum).toEqual([
        'active',
        'archived',
        'superseded',
      ]);
    });

    it('disallows additional properties', () => {
      expect(cmosLearningsToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('CMOS_LEARNINGS_ACTIONS', () => {
    it('contains 4 actions', () => {
      expect(CMOS_LEARNINGS_ACTIONS).toHaveLength(4);
      expect([...CMOS_LEARNINGS_ACTIONS]).toEqual(['list', 'search', 'update', 'reaffirm']);
    });
  });

  describe('formatLearningsForLLM', () => {
    it('formats INVALID_ACTION errors', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['list', 'search', 'update'],
        },
      };
      expect(formatLearningsForLLM(undefined, result)).toContain(
        'Failed to execute cmos_learnings'
      );
    });

    it('includes available actions in error output', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['list', 'search', 'update'],
        },
      };
      const output = formatLearningsForLLM(undefined, result);
      expect(output).toContain('list, search, update');
    });

    it('returns fallback for unknown action', () => {
      expect(formatLearningsForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Learnings action completed'
      );
    });

    it('returns error fallback for failed unknown action', () => {
      expect(
        formatLearningsForLLM('unknown', { success: false, error: { code: 'X', message: 'Y' } })
      ).toContain('Failed to execute cmos_learnings');
    });
  });
});
