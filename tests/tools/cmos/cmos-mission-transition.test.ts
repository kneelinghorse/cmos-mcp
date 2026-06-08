import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-mission-start', () => ({
  cmosMissionStart: jest.fn(),
  formatMissionStartForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-complete', () => ({
  cmosMissionComplete: jest.fn(),
  formatMissionCompleteForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-block', () => ({
  cmosMissionBlock: jest.fn(),
  formatMissionBlockForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-unblock', () => ({
  cmosMissionUnblock: jest.fn(),
  formatMissionUnblockForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-drop', () => ({
  cmosMissionDrop: jest.fn(),
  formatMissionDropForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-defer', () => ({
  cmosMissionDefer: jest.fn(),
  formatMissionDeferForLLM: jest.fn(),
}));

import {
  CMOS_MISSION_TRANSITION_ACTIONS,
  cmosMissionTransition,
  cmosMissionTransitionToolDefinition,
  formatMissionTransitionForLLM,
} from '../../../src/tools/cmos/cmos-mission-transition';
import {
  cmosMissionStart,
  formatMissionStartForLLM,
} from '../../../src/tools/cmos/cmos-mission-start';
import {
  cmosMissionComplete,
  formatMissionCompleteForLLM,
} from '../../../src/tools/cmos/cmos-mission-complete';
import {
  cmosMissionBlock,
  formatMissionBlockForLLM,
} from '../../../src/tools/cmos/cmos-mission-block';
import {
  cmosMissionUnblock,
  formatMissionUnblockForLLM,
} from '../../../src/tools/cmos/cmos-mission-unblock';
import {
  cmosMissionDrop,
  formatMissionDropForLLM,
} from '../../../src/tools/cmos/cmos-mission-drop';
import {
  cmosMissionDefer,
  formatMissionDeferForLLM,
} from '../../../src/tools/cmos/cmos-mission-defer';

describe('cmos_mission_transition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes start action to the existing mission start handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'In Progress' },
    } as any;
    (cmosMissionStart as jest.MockedFunction<typeof cmosMissionStart>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMissionTransition({
      action: 'start',
      missionId: 's14-m01',
      notes: 'Starting work',
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionStart).toHaveBeenCalledWith({
      missionId: 's14-m01',
      notes: 'Starting work',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes complete action to the existing mission complete handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'Completed' },
    } as any;
    (cmosMissionComplete as jest.MockedFunction<typeof cmosMissionComplete>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMissionTransition({
      action: 'complete',
      missionId: 's14-m01',
      notes: 'All done',
      decisions: ['Used pattern X'],
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionComplete).toHaveBeenCalledWith({
      missionId: 's14-m01',
      notes: 'All done',
      decisions: ['Used pattern X'],
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes block action to the existing mission block handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'Blocked' },
    } as any;
    (cmosMissionBlock as jest.MockedFunction<typeof cmosMissionBlock>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMissionTransition({
      action: 'block',
      missionId: 's14-m01',
      reason: 'Dependency not ready',
      blockers: ['s14-m02'],
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionBlock).toHaveBeenCalledWith({
      missionId: 's14-m01',
      reason: 'Dependency not ready',
      blockers: ['s14-m02'],
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes unblock action to the existing mission unblock handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'In Progress' },
    } as any;
    (cmosMissionUnblock as jest.MockedFunction<typeof cmosMissionUnblock>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMissionTransition({
      action: 'unblock',
      missionId: 's14-m01',
      resolution: 'Dependency resolved',
      targetStatus: 'In Progress',
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionUnblock).toHaveBeenCalledWith({
      missionId: 's14-m01',
      resolution: 'Dependency resolved',
      targetStatus: 'In Progress',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION error for unknown action', async () => {
    const result = await cmosMissionTransition({
      action: 'archive' as any,
      missionId: 's14-m01',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults missing reason to empty string for block action', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosMissionBlock as jest.MockedFunction<typeof cmosMissionBlock>).mockResolvedValueOnce(
      expected
    );

    await cmosMissionTransition({ action: 'block', missionId: 's14-m01' });

    expect(cmosMissionBlock).toHaveBeenCalledWith({
      missionId: 's14-m01',
      reason: '',
      blockers: undefined,
      projectRoot: undefined,
    });
  });

  it('routes drop action to the mission drop handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'Dropped' },
    } as any;
    (cmosMissionDrop as jest.MockedFunction<typeof cmosMissionDrop>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMissionTransition({
      action: 'drop',
      missionId: 's14-m01',
      reason: 'No longer relevant',
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionDrop).toHaveBeenCalledWith({
      missionId: 's14-m01',
      reason: 'No longer relevant',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes defer action to the mission defer handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'Deferred' },
    } as any;
    (cmosMissionDefer as jest.MockedFunction<typeof cmosMissionDefer>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMissionTransition({
      action: 'defer',
      missionId: 's14-m01',
      reason: 'Waiting on dependency',
      deferUntil: 'after sprint 49',
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionDefer).toHaveBeenCalledWith({
      missionId: 's14-m01',
      reason: 'Waiting on dependency',
      deferUntil: 'after sprint 49',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  describe('CMOS_MISSION_TRANSITION_ACTIONS', () => {
    it('contains exactly 6 actions', () => {
      expect(CMOS_MISSION_TRANSITION_ACTIONS).toHaveLength(6);
      expect([...CMOS_MISSION_TRANSITION_ACTIONS]).toEqual([
        'start',
        'complete',
        'block',
        'unblock',
        'drop',
        'defer',
      ]);
    });
  });

  describe('cmosMissionTransitionToolDefinition', () => {
    it('has the correct tool name', () => {
      expect(cmosMissionTransitionToolDefinition.name).toBe('cmos_mission_transition');
    });

    it('requires action and missionId parameters', () => {
      expect(cmosMissionTransitionToolDefinition.inputSchema.required).toContain('action');
      expect(cmosMissionTransitionToolDefinition.inputSchema.required).toContain('missionId');
    });

    it('disallows additional properties', () => {
      expect(cmosMissionTransitionToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('formatMissionTransitionForLLM', () => {
    it('formats INVALID_ACTION errors with available actions', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action "archive" is not supported for cmos_mission_transition.',
          suggestion: 'Use one of the available actions.',
          availableActions: ['start', 'complete', 'block', 'unblock', 'drop', 'defer'],
        },
      };

      const formatted = formatMissionTransitionForLLM(undefined, result);

      expect(formatted).toContain('Failed to execute cmos_mission_transition');
      expect(formatted).toContain('archive');
      expect(formatted).toContain('Available actions');
    });

    it('delegates start formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { missionId: 's14-m01' } } as any;
      (
        formatMissionStartForLLM as jest.MockedFunction<typeof formatMissionStartForLLM>
      ).mockReturnValueOnce('formatted start');

      const result = formatMissionTransitionForLLM('start', mockResult);

      expect(formatMissionStartForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted start');
    });

    it('delegates complete formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { missionId: 's14-m01' } } as any;
      (
        formatMissionCompleteForLLM as jest.MockedFunction<typeof formatMissionCompleteForLLM>
      ).mockReturnValueOnce('formatted complete');

      const result = formatMissionTransitionForLLM('complete', mockResult);

      expect(formatMissionCompleteForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted complete');
    });

    it('delegates drop formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { missionId: 's14-m01' } } as any;
      (
        formatMissionDropForLLM as jest.MockedFunction<typeof formatMissionDropForLLM>
      ).mockReturnValueOnce('formatted drop');

      const result = formatMissionTransitionForLLM('drop', mockResult);

      expect(formatMissionDropForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted drop');
    });

    it('delegates defer formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { missionId: 's14-m01' } } as any;
      (
        formatMissionDeferForLLM as jest.MockedFunction<typeof formatMissionDeferForLLM>
      ).mockReturnValueOnce('formatted defer');

      const result = formatMissionTransitionForLLM('defer', mockResult);

      expect(formatMissionDeferForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted defer');
    });

    it('returns fallback for unknown action', () => {
      const result = formatMissionTransitionForLLM('unknown', {
        success: true,
        data: {},
      } as any);
      expect(result).toContain('Mission transition completed');
    });
  });
});
