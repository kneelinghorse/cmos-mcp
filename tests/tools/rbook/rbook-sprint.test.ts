import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-sprint-list', () => ({
  rbookSprintList: jest.fn(),
  formatSprintListForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-sprint-show', () => ({
  rbookSprintShow: jest.fn(),
  formatSprintShowForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-sprint-add', () => ({
  rbookSprintAdd: jest.fn(),
  formatSprintAddForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-sprint-update', () => ({
  rbookSprintUpdate: jest.fn(),
  formatSprintUpdateForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-sprint-complete', () => ({
  rbookSprintComplete: jest.fn(),
  formatSprintCompleteForLLM: jest.fn(),
}));

import {
  RBOOK_SPRINT_ACTIONS,
  rbookSprint,
  rbookSprintSchema,
  rbookSprintToolDefinition,
  formatSprintForLLM,
} from '../../../src/tools/rbook/rbook-sprint';
import {
  rbookSprintList,
  formatSprintListForLLM,
} from '../../../src/tools/rbook/rbook-sprint-list';
import {
  rbookSprintShow,
  formatSprintShowForLLM,
} from '../../../src/tools/rbook/rbook-sprint-show';
import { rbookSprintAdd, formatSprintAddForLLM } from '../../../src/tools/rbook/rbook-sprint-add';
import {
  rbookSprintUpdate,
  formatSprintUpdateForLLM,
} from '../../../src/tools/rbook/rbook-sprint-update';
import {
  rbookSprintComplete,
  formatSprintCompleteForLLM,
} from '../../../src/tools/rbook/rbook-sprint-complete';

describe('rbook_sprint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action to the existing sprint list handler', async () => {
    const expected = { success: true, data: { sprints: [], totalCount: 0 } } as any;
    (rbookSprintList as jest.MockedFunction<typeof rbookSprintList>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookSprint({
      action: 'list',
      status: 'Active',
      limit: 5,
      projectRoot: '/tmp/project',
    });

    expect(rbookSprintList).toHaveBeenCalledWith({
      status: 'Active',
      limit: 5,
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes show action to the existing sprint show handler', async () => {
    const expected = { success: true, data: { id: 'sprint-1' } } as any;
    (rbookSprintShow as jest.MockedFunction<typeof rbookSprintShow>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookSprint({
      action: 'show',
      sprintId: 'sprint-1',
      projectRoot: '/tmp/project',
    });

    expect(rbookSprintShow).toHaveBeenCalledWith({
      sprintId: 'sprint-1',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes add action to the existing sprint add handler', async () => {
    const expected = { success: true, data: { id: 'sprint-2' } } as any;
    (rbookSprintAdd as jest.MockedFunction<typeof rbookSprintAdd>).mockResolvedValueOnce(expected);

    const result = await rbookSprint({
      action: 'add',
      sprintId: 'sprint-2',
      title: 'Sprint Two',
      focus: 'Cleanup',
      status: 'Planned',
      startDate: '2026-03-08',
      endDate: '2026-03-15',
      projectRoot: '/tmp/project',
    });

    expect(rbookSprintAdd).toHaveBeenCalledWith({
      sprintId: 'sprint-2',
      title: 'Sprint Two',
      focus: 'Cleanup',
      status: 'Planned',
      startDate: '2026-03-08',
      endDate: '2026-03-15',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes update action to the existing sprint update handler', async () => {
    const expected = { success: true, data: { sprintId: 'sprint-3' } } as any;
    (rbookSprintUpdate as jest.MockedFunction<typeof rbookSprintUpdate>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookSprint({
      action: 'update',
      sprintId: 'sprint-3',
      fields: { title: 'Updated Sprint' },
      projectRoot: '/tmp/project',
    });

    expect(rbookSprintUpdate).toHaveBeenCalledWith({
      sprintId: 'sprint-3',
      fields: { title: 'Updated Sprint' },
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes complete action to the existing sprint complete handler', async () => {
    const expected = { success: true, data: { sprintId: 'sprint-4' } } as any;
    (rbookSprintComplete as jest.MockedFunction<typeof rbookSprintComplete>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookSprint({
      action: 'complete',
      sprintId: 'sprint-4',
      summary: 'Closed out the sprint',
      condensation: 'auto',
      targetSizePercent: 55,
      projectRoot: '/tmp/project',
    });

    expect(rbookSprintComplete).toHaveBeenCalledWith({
      sprintId: 'sprint-4',
      summary: 'Closed out the sprint',
      condensation: 'auto',
      targetSizePercent: 55,
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('forwards forceComplete through the complete route (Sprint 70 m02)', async () => {
    const expected = { success: true, data: { sprintId: 'sprint-9' } } as any;
    (rbookSprintComplete as jest.MockedFunction<typeof rbookSprintComplete>).mockResolvedValueOnce(
      expected
    );

    await rbookSprint({
      action: 'complete',
      sprintId: 'sprint-9',
      summary: 'Force over stale build',
      forceComplete: true,
      projectRoot: '/tmp/project',
    });

    expect(rbookSprintComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        sprintId: 'sprint-9',
        summary: 'Force over stale build',
        forceComplete: true,
        projectRoot: '/tmp/project',
      })
    );
  });

  it('accepts forceComplete on the consolidated .strict() schema (Sprint 70 m02)', () => {
    // The consolidated schema is .strict(); the JSON inputSchema is additionalProperties:false.
    // forceComplete must be a recognized key on both or the MCP boundary rejects it.
    const parsed = rbookSprintSchema.safeParse({
      action: 'complete',
      sprintId: 'sprint-9',
      summary: 'Force over stale build',
      forceComplete: true,
    });
    expect(parsed.success).toBe(true);
    expect((rbookSprintToolDefinition.inputSchema as any).properties.forceComplete).toBeDefined();
    expect((rbookSprintToolDefinition.inputSchema as any).properties.forceComplete.type).toBe(
      'boolean'
    );
  });

  it('returns INVALID_ACTION with available action lists', async () => {
    const result = await rbookSprint({ action: 'archive' as any });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
    expect(result.error?.availableActions).toEqual([...RBOOK_SPRINT_ACTIONS]);
    expect(result.error?.available_actions).toEqual([...RBOOK_SPRINT_ACTIONS]);
    expect(result.error?.validValues).toEqual([...RBOOK_SPRINT_ACTIONS]);
  });

  it('formats invalid action responses with the available actions', () => {
    const formatted = formatSprintForLLM('archive', {
      success: false,
      error: {
        code: 'INVALID_ACTION',
        message: 'Action "archive" is not supported for rbook_sprint.',
        suggestion: 'Use one of the available actions: list, show, add, update, complete',
        availableActions: [...RBOOK_SPRINT_ACTIONS],
      },
    });

    expect(formatted).toContain('Failed to execute rbook_sprint');
    expect(formatted).toContain('Available actions: list, show, add, update, complete');
  });

  it('delegates formatting to the matching action formatter', () => {
    (formatSprintListForLLM as jest.MockedFunction<typeof formatSprintListForLLM>).mockReturnValue(
      'list output'
    );
    (formatSprintShowForLLM as jest.MockedFunction<typeof formatSprintShowForLLM>).mockReturnValue(
      'show output'
    );
    (formatSprintAddForLLM as jest.MockedFunction<typeof formatSprintAddForLLM>).mockReturnValue(
      'add output'
    );
    (
      formatSprintUpdateForLLM as jest.MockedFunction<typeof formatSprintUpdateForLLM>
    ).mockReturnValue('update output');
    (
      formatSprintCompleteForLLM as jest.MockedFunction<typeof formatSprintCompleteForLLM>
    ).mockReturnValue('complete output');

    expect(formatSprintForLLM('list', { success: true, data: {} } as any)).toBe('list output');
    expect(formatSprintForLLM('show', { success: true, data: {} } as any)).toBe('show output');
    expect(formatSprintForLLM('add', { success: true, data: {} } as any)).toBe('add output');
    expect(formatSprintForLLM('update', { success: true, data: {} } as any)).toBe('update output');
    expect(formatSprintForLLM('complete', { success: true, data: {} } as any)).toBe(
      'complete output'
    );
  });

  it('defines the consolidated sprint tool schema', () => {
    expect(rbookSprintToolDefinition.name).toBe('rbook_sprint');
    expect((rbookSprintToolDefinition.inputSchema as any).required).toEqual(['action']);
    expect((rbookSprintToolDefinition.inputSchema as any).properties.action.enum).toEqual([
      ...RBOOK_SPRINT_ACTIONS,
    ]);
  });

  // Sprint 79 m04: the fan-out model (isReadAction/READ_ACTIONS/fanOutRead) was
  // deleted; rbook_sprint always pins to the sender at dispatch. The former
  // fan-out-eligibility assertions were removed with it.
});
