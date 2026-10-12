import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-learnings-list', () => ({
  rbookLearningsList: jest.fn(),
  formatLearningsListForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-learnings-search', () => ({
  rbookLearningsSearch: jest.fn(),
  formatLearningsSearchForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-learnings-update', () => ({
  rbookLearningsUpdate: jest.fn(),
  formatLearningsUpdateForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-learnings-reaffirm', () => ({
  rbookLearningsReaffirm: jest.fn(),
  formatLearningsReaffirmForLLM: jest.fn(),
}));

import {
  RBOOK_LEARNINGS_ACTIONS,
  rbookLearnings,
  rbookLearningsToolDefinition,
  formatLearningsForLLM,
} from '../../../src/tools/rbook/rbook-learnings';
import { rbookLearningsList } from '../../../src/tools/rbook/rbook-learnings-list';
import { rbookLearningsSearch } from '../../../src/tools/rbook/rbook-learnings-search';
import { rbookLearningsUpdate } from '../../../src/tools/rbook/rbook-learnings-update';
import { rbookLearningsReaffirm } from '../../../src/tools/rbook/rbook-learnings-reaffirm';

describe('rbook_learnings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action', async () => {
    const expected = { success: true, data: { learnings: [] } } as any;
    (rbookLearningsList as jest.MockedFunction<typeof rbookLearningsList>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookLearnings({
      action: 'list',
      category: 'technical',
      sprintId: 'sprint-38',
      page: 1,
      pageSize: 10,
    });
    expect(rbookLearningsList).toHaveBeenCalledWith({
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
    (rbookLearningsList as jest.MockedFunction<typeof rbookLearningsList>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookLearnings({
      action: 'list',
      status: 'active',
    });
    expect(rbookLearningsList).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    expect(result).toBe(expected);
  });

  it('routes search action', async () => {
    const expected = { success: true, data: { results: [] } } as any;
    (
      rbookLearningsSearch as jest.MockedFunction<typeof rbookLearningsSearch>
    ).mockResolvedValueOnce(expected);

    const result = await rbookLearnings({
      action: 'search',
      query: 'sync pipeline',
      limit: 5,
    });
    expect(rbookLearningsSearch).toHaveBeenCalledWith({
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
    (
      rbookLearningsUpdate as jest.MockedFunction<typeof rbookLearningsUpdate>
    ).mockResolvedValueOnce(expected);

    const result = await rbookLearnings({
      action: 'update',
      learningId: 42,
      status: 'archived',
    });
    expect(rbookLearningsUpdate).toHaveBeenCalledWith({
      learningId: 42,
      status: 'archived',
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await rbookLearnings({ action: 'delete' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults missing query to empty string for search', async () => {
    const expected = { success: true, data: {} } as any;
    (
      rbookLearningsSearch as jest.MockedFunction<typeof rbookLearningsSearch>
    ).mockResolvedValueOnce(expected);

    await rbookLearnings({ action: 'search' });
    expect(rbookLearningsSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '' }));
  });

  it('defaults missing learningId to 0 for update', async () => {
    const expected = { success: true, data: {} } as any;
    (
      rbookLearningsUpdate as jest.MockedFunction<typeof rbookLearningsUpdate>
    ).mockResolvedValueOnce(expected);

    await rbookLearnings({ action: 'update', status: 'archived' });
    expect(rbookLearningsUpdate).toHaveBeenCalledWith(expect.objectContaining({ learningId: 0 }));
  });

  it('routes reaffirm action', async () => {
    const expected = {
      success: true,
      data: { learningId: 7, status: 'active', reaffirmedAt: '2026-04-15T00:00:00Z' },
    } as any;
    (
      rbookLearningsReaffirm as jest.MockedFunction<typeof rbookLearningsReaffirm>
    ).mockResolvedValueOnce(expected);

    const result = await rbookLearnings({ action: 'reaffirm', learningId: 7 });
    expect(rbookLearningsReaffirm).toHaveBeenCalledWith({ learningId: 7, projectRoot: undefined });
    expect(result).toBe(expected);
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(rbookLearningsToolDefinition.name).toBe('rbook_learnings');
    });

    it('requires action', () => {
      expect(rbookLearningsToolDefinition.inputSchema.required).toContain('action');
    });

    it('has all action enums', () => {
      expect(rbookLearningsToolDefinition.inputSchema.properties.action.enum).toEqual([
        'list',
        'search',
        'show',
        'update',
        'reaffirm',
      ]);
    });

    it('publishes NO category enum — the column has no CHECK, so a closed set would be a lie', () => {
      // s86-m04 (fork f04, fleet-resolved): this assertion is INVERTED from what it was. The
      // published enum claimed an enforcement the server does not perform — `learnings.category`
      // is `TEXT` with no CHECK constraint — and the fleet already carries an out-of-set value
      // ('voice', 1 row in Writing-and-Strategy). Widening to include 'voice' would have enshrined
      // one store's accident as a fleet contract; the four canonical values are guidance instead.
      const category = rbookLearningsToolDefinition.inputSchema.properties.category as {
        type: string;
        description: string;
        enum?: string[];
      };
      expect(category.enum).toBeUndefined();
      expect(category.type).toBe('string');
      expect(category.description).toContain('technical | process | agent-behavior | tooling');
    });

    it('has status enum, INCLUDING the value the server writes', () => {
      // s86-m04 (fork f04, fleet-resolved): 'stale' was missing. staleness-detection.ts writes it,
      // and 246 such rows exist across 7 of 18 registered stores — so the published 3-member enum
      // forbade callers from naming a value Reasonbook itself had been writing for sprints.
      expect(rbookLearningsToolDefinition.inputSchema.properties.status.enum).toEqual([
        'active',
        'archived',
        'superseded',
        'stale',
      ]);
    });

    it('disallows additional properties', () => {
      expect(rbookLearningsToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('RBOOK_LEARNINGS_ACTIONS', () => {
    it('contains 5 actions', () => {
      // s92-m08: show reads one learning in full by id.
      expect(RBOOK_LEARNINGS_ACTIONS).toHaveLength(5);
      expect([...RBOOK_LEARNINGS_ACTIONS]).toEqual([
        'list',
        'search',
        'show',
        'update',
        'reaffirm',
      ]);
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
        'Failed to execute rbook_learnings'
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
      ).toContain('Failed to execute rbook_learnings');
    });
  });
});
