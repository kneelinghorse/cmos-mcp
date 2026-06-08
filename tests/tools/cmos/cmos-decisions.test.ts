import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-decisions-list', () => ({
  cmosDecisionsList: jest.fn(),
  formatDecisionsListForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-decisions-search', () => ({
  cmosDecisionsSearch: jest.fn(),
  formatDecisionsSearchForLLM: jest.fn(),
}));

import {
  CMOS_DECISIONS_ACTIONS,
  cmosDecisions,
  cmosDecisionsToolDefinition,
  formatDecisionsForLLM,
} from '../../../src/tools/cmos/cmos-decisions';
import { cmosDecisionsList } from '../../../src/tools/cmos/cmos-decisions-list';
import { cmosDecisionsSearch } from '../../../src/tools/cmos/cmos-decisions-search';

describe('cmos_decisions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action', async () => {
    const expected = { success: true, data: { decisions: [] } } as any;
    (cmosDecisionsList as jest.MockedFunction<typeof cmosDecisionsList>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosDecisions({
      action: 'list',
      domain: 'general',
      sprintId: 'sprint-14',
      page: 1,
      pageSize: 10,
    });
    expect(cmosDecisionsList).toHaveBeenCalledWith({
      domain: 'general',
      sprintId: 'sprint-14',
      since: undefined,
      until: undefined,
      page: 1,
      pageSize: 10,
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('routes search action', async () => {
    const expected = { success: true, data: { results: [] } } as any;
    (cmosDecisionsSearch as jest.MockedFunction<typeof cmosDecisionsSearch>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosDecisions({
      action: 'search',
      query: 'consolidation',
      limit: 5,
    });
    expect(cmosDecisionsSearch).toHaveBeenCalledWith({
      query: 'consolidation',
      domain: undefined,
      sprintId: undefined,
      limit: 5,
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await cmosDecisions({ action: 'archive' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults missing query to empty string for search', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosDecisionsSearch as jest.MockedFunction<typeof cmosDecisionsSearch>).mockResolvedValueOnce(
      expected
    );

    await cmosDecisions({ action: 'search' });
    expect(cmosDecisionsSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '' }));
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(cmosDecisionsToolDefinition.name).toBe('cmos_decisions');
    });
    it('requires action', () => {
      expect(cmosDecisionsToolDefinition.inputSchema.required).toContain('action');
    });
  });

  describe('CMOS_DECISIONS_ACTIONS', () => {
    it('contains 5 actions', () => {
      expect(CMOS_DECISIONS_ACTIONS).toHaveLength(5);
      expect([...CMOS_DECISIONS_ACTIONS]).toEqual([
        'list',
        'search',
        'update',
        'review',
        'batch_update',
      ]);
    });
  });

  describe('formatDecisionsForLLM', () => {
    it('formats INVALID_ACTION errors', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['list', 'search'],
        },
      };
      expect(formatDecisionsForLLM(undefined, result)).toContain(
        'Failed to execute cmos_decisions'
      );
    });

    it('returns fallback for unknown action', () => {
      expect(formatDecisionsForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Decisions action completed'
      );
    });
  });
});
