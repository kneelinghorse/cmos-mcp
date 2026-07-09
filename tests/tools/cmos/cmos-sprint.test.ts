import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-sprint-list', () => ({
  cmosSprintList: jest.fn(),
  formatSprintListForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-sprint-show', () => ({
  cmosSprintShow: jest.fn(),
  formatSprintShowForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-sprint-add', () => ({
  cmosSprintAdd: jest.fn(),
  formatSprintAddForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-sprint-update', () => ({
  cmosSprintUpdate: jest.fn(),
  formatSprintUpdateForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-sprint-complete', () => ({
  cmosSprintComplete: jest.fn(),
  formatSprintCompleteForLLM: jest.fn(),
}));

import {
  CMOS_SPRINT_ACTIONS,
  cmosSprint,
  cmosSprintSchema,
  cmosSprintToolDefinition,
  formatSprintForLLM,
} from '../../../src/tools/cmos/cmos-sprint';
import { cmosSprintList, formatSprintListForLLM } from '../../../src/tools/cmos/cmos-sprint-list';
import { cmosSprintShow, formatSprintShowForLLM } from '../../../src/tools/cmos/cmos-sprint-show';
import { cmosSprintAdd, formatSprintAddForLLM } from '../../../src/tools/cmos/cmos-sprint-add';
import {
  cmosSprintUpdate,
  formatSprintUpdateForLLM,
} from '../../../src/tools/cmos/cmos-sprint-update';
import {
  cmosSprintComplete,
  formatSprintCompleteForLLM,
} from '../../../src/tools/cmos/cmos-sprint-complete';

describe('cmos_sprint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action to the existing sprint list handler', async () => {
    const expected = { success: true, data: { sprints: [], totalCount: 0 } } as any;
    (cmosSprintList as jest.MockedFunction<typeof cmosSprintList>).mockResolvedValueOnce(expected);

    const result = await cmosSprint({
      action: 'list',
      status: 'Active',
      limit: 5,
      projectRoot: '/tmp/project',
    });

    expect(cmosSprintList).toHaveBeenCalledWith({
      status: 'Active',
      limit: 5,
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes show action to the existing sprint show handler', async () => {
    const expected = { success: true, data: { id: 'sprint-1' } } as any;
    (cmosSprintShow as jest.MockedFunction<typeof cmosSprintShow>).mockResolvedValueOnce(expected);

    const result = await cmosSprint({
      action: 'show',
      sprintId: 'sprint-1',
      projectRoot: '/tmp/project',
    });

    expect(cmosSprintShow).toHaveBeenCalledWith({
      sprintId: 'sprint-1',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes add action to the existing sprint add handler', async () => {
    const expected = { success: true, data: { id: 'sprint-2' } } as any;
    (cmosSprintAdd as jest.MockedFunction<typeof cmosSprintAdd>).mockResolvedValueOnce(expected);

    const result = await cmosSprint({
      action: 'add',
      sprintId: 'sprint-2',
      title: 'Sprint Two',
      focus: 'Cleanup',
      status: 'Planned',
      startDate: '2026-03-08',
      endDate: '2026-03-15',
      projectRoot: '/tmp/project',
    });

    expect(cmosSprintAdd).toHaveBeenCalledWith({
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
    (cmosSprintUpdate as jest.MockedFunction<typeof cmosSprintUpdate>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosSprint({
      action: 'update',
      sprintId: 'sprint-3',
      fields: { title: 'Updated Sprint' },
      projectRoot: '/tmp/project',
    });

    expect(cmosSprintUpdate).toHaveBeenCalledWith({
      sprintId: 'sprint-3',
      fields: { title: 'Updated Sprint' },
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes complete action to the existing sprint complete handler', async () => {
    const expected = { success: true, data: { sprintId: 'sprint-4' } } as any;
    (cmosSprintComplete as jest.MockedFunction<typeof cmosSprintComplete>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosSprint({
      action: 'complete',
      sprintId: 'sprint-4',
      summary: 'Closed out the sprint',
      condensation: 'auto',
      targetSizePercent: 55,
      projectRoot: '/tmp/project',
    });

    expect(cmosSprintComplete).toHaveBeenCalledWith({
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
    (cmosSprintComplete as jest.MockedFunction<typeof cmosSprintComplete>).mockResolvedValueOnce(
      expected
    );

    await cmosSprint({
      action: 'complete',
      sprintId: 'sprint-9',
      summary: 'Force over stale build',
      forceComplete: true,
      projectRoot: '/tmp/project',
    });

    expect(cmosSprintComplete).toHaveBeenCalledWith(
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
    const parsed = cmosSprintSchema.safeParse({
      action: 'complete',
      sprintId: 'sprint-9',
      summary: 'Force over stale build',
      forceComplete: true,
    });
    expect(parsed.success).toBe(true);
    expect((cmosSprintToolDefinition.inputSchema as any).properties.forceComplete).toBeDefined();
    expect((cmosSprintToolDefinition.inputSchema as any).properties.forceComplete.type).toBe(
      'boolean'
    );
  });

  it('returns INVALID_ACTION with available action lists', async () => {
    const result = await cmosSprint({ action: 'archive' as any });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
    expect(result.error?.availableActions).toEqual([...CMOS_SPRINT_ACTIONS]);
    expect(result.error?.available_actions).toEqual([...CMOS_SPRINT_ACTIONS]);
    expect(result.error?.validValues).toEqual([...CMOS_SPRINT_ACTIONS]);
  });

  it('formats invalid action responses with the available actions', () => {
    const formatted = formatSprintForLLM('archive', {
      success: false,
      error: {
        code: 'INVALID_ACTION',
        message: 'Action "archive" is not supported for cmos_sprint.',
        suggestion: 'Use one of the available actions: list, show, add, update, complete',
        availableActions: [...CMOS_SPRINT_ACTIONS],
      },
    });

    expect(formatted).toContain('Failed to execute cmos_sprint');
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
    expect(cmosSprintToolDefinition.name).toBe('cmos_sprint');
    expect((cmosSprintToolDefinition.inputSchema as any).required).toEqual(['action']);
    expect((cmosSprintToolDefinition.inputSchema as any).properties.action.enum).toEqual([
      ...CMOS_SPRINT_ACTIONS,
    ]);
  });

  // Sprint 79 m04: the fan-out model (isReadAction/READ_ACTIONS/fanOutRead) was
  // deleted; cmos_sprint always pins to the sender at dispatch. The former
  // fan-out-eligibility assertions were removed with it.
});
