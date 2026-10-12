import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-decisions-list', () => ({
  rbookDecisionsList: jest.fn(),
  formatDecisionsListForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-decisions-search', () => ({
  rbookDecisionsSearch: jest.fn(),
  formatDecisionsSearchForLLM: jest.fn(),
}));

import {
  RBOOK_DECISIONS_ACTIONS,
  rbookDecisions,
  rbookDecisionsToolDefinition,
  formatDecisionsForLLM,
} from '../../../src/tools/rbook/rbook-decisions';
import { rbookDecisionsList } from '../../../src/tools/rbook/rbook-decisions-list';
import { rbookDecisionsSearch } from '../../../src/tools/rbook/rbook-decisions-search';

describe('rbook_decisions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action', async () => {
    const expected = { success: true, data: { decisions: [] } } as any;
    (rbookDecisionsList as jest.MockedFunction<typeof rbookDecisionsList>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookDecisions({
      action: 'list',
      domain: 'general',
      sprintId: 'sprint-14',
      page: 1,
      pageSize: 10,
    });
    expect(rbookDecisionsList).toHaveBeenCalledWith({
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
    (
      rbookDecisionsSearch as jest.MockedFunction<typeof rbookDecisionsSearch>
    ).mockResolvedValueOnce(expected);

    const result = await rbookDecisions({
      action: 'search',
      query: 'consolidation',
      limit: 5,
    });
    expect(rbookDecisionsSearch).toHaveBeenCalledWith({
      query: 'consolidation',
      domain: undefined,
      sprintId: undefined,
      limit: 5,
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await rbookDecisions({ action: 'archive' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults missing query to empty string for search', async () => {
    const expected = { success: true, data: {} } as any;
    (
      rbookDecisionsSearch as jest.MockedFunction<typeof rbookDecisionsSearch>
    ).mockResolvedValueOnce(expected);

    await rbookDecisions({ action: 'search' });
    expect(rbookDecisionsSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '' }));
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(rbookDecisionsToolDefinition.name).toBe('rbook_decisions');
    });
    it('requires action', () => {
      expect(rbookDecisionsToolDefinition.inputSchema.required).toContain('action');
    });
  });

  describe('RBOOK_DECISIONS_ACTIONS', () => {
    // s91-m04: `record` is the sixth — a decision written outside a session, with supersedes.
    it('contains 7 actions', () => {
      // s92-m08: show reads one decision in full by id.
      expect(RBOOK_DECISIONS_ACTIONS).toHaveLength(7);
      expect([...RBOOK_DECISIONS_ACTIONS]).toEqual([
        'list',
        'search',
        'show',
        'update',
        'review',
        'batch_update',
        'record',
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
        'Failed to execute rbook_decisions'
      );
    });

    it('returns fallback for unknown action', () => {
      expect(formatDecisionsForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Decisions action completed'
      );
    });
  });
});
