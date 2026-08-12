import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-mission-list', () => ({
  cmosMissionList: jest.fn(),
  formatMissionListForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-show', () => ({
  cmosMissionShow: jest.fn(),
  formatMissionShowForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-status', () => ({
  cmosMissionStatus: jest.fn(),
  formatMissionStatusForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-add', () => ({
  cmosMissionAdd: jest.fn(),
  formatMissionAddForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-update', () => ({
  cmosMissionUpdate: jest.fn(),
  formatMissionUpdateForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/cmos/cmos-mission-depends', () => ({
  cmosMissionDepends: jest.fn(),
  formatMissionDependsForLLM: jest.fn(),
}));

import {
  CMOS_MISSION_ACTIONS,
  cmosMission,
  cmosMissionToolDefinition,
  formatMissionForLLM,
} from '../../../src/tools/cmos/cmos-mission';
import {
  cmosMissionList,
  formatMissionListForLLM,
} from '../../../src/tools/cmos/cmos-mission-list';
import {
  cmosMissionShow,
  formatMissionShowForLLM,
} from '../../../src/tools/cmos/cmos-mission-show';
import {
  cmosMissionStatus,
  formatMissionStatusForLLM,
} from '../../../src/tools/cmos/cmos-mission-status';
import { cmosMissionAdd, formatMissionAddForLLM } from '../../../src/tools/cmos/cmos-mission-add';
import {
  cmosMissionUpdate,
  formatMissionUpdateForLLM,
} from '../../../src/tools/cmos/cmos-mission-update';
import {
  cmosMissionDepends,
  formatMissionDependsForLLM,
} from '../../../src/tools/cmos/cmos-mission-depends';

describe('cmos_mission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action to the existing mission list handler', async () => {
    const expected = { success: true, data: { missions: [], totalCount: 0 } } as any;
    (cmosMissionList as jest.MockedFunction<typeof cmosMissionList>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMission({
      action: 'list',
      sprintId: 'sprint-14',
      status: 'Queued',
      limit: 10,
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionList).toHaveBeenCalledWith({
      sprintId: 'sprint-14',
      status: 'Queued',
      limit: 10,
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes show action to the existing mission show handler', async () => {
    const expected = { success: true, data: { id: 's14-m01' } } as any;
    (cmosMissionShow as jest.MockedFunction<typeof cmosMissionShow>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMission({
      action: 'show',
      missionId: 's14-m01',
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionShow).toHaveBeenCalledWith({
      missionId: 's14-m01',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes status action to the existing mission status handler', async () => {
    const expected = { success: true, data: { inProgress: [], current: [], queued: [] } } as any;
    (cmosMissionStatus as jest.MockedFunction<typeof cmosMissionStatus>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMission({
      action: 'status',
      includeBlocked: true,
      queuedLimit: 10,
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionStatus).toHaveBeenCalledWith({
      includeBlocked: true,
      queuedLimit: 10,
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes add action to the existing mission add handler', async () => {
    const expected = { success: true, data: { id: 's14-m05' } } as any;
    (cmosMissionAdd as jest.MockedFunction<typeof cmosMissionAdd>).mockResolvedValueOnce(expected);

    const result = await cmosMission({
      action: 'add',
      missionId: 's14-m05',
      name: 'Test Mission',
      sprintId: 'sprint-14',
      objective: 'Do something',
      successCriteria: ['Criterion 1'],
      deliverables: ['File.ts'],
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionAdd).toHaveBeenCalledWith({
      missionId: 's14-m05',
      name: 'Test Mission',
      sprintId: 'sprint-14',
      status: undefined,
      objective: 'Do something',
      context: undefined,
      successCriteria: ['Criterion 1'],
      deliverables: ['File.ts'],
      referenceDocs: undefined,
      domainFields: undefined,
      notes: undefined,
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes update action to the existing mission update handler', async () => {
    const expected = { success: true, data: { missionId: 's14-m01' } } as any;
    (cmosMissionUpdate as jest.MockedFunction<typeof cmosMissionUpdate>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMission({
      action: 'update',
      missionId: 's14-m01',
      fields: { name: 'Updated Name', objective: 'New objective' },
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionUpdate).toHaveBeenCalledWith({
      missionId: 's14-m01',
      fields: { name: 'Updated Name', objective: 'New objective' },
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes depends action to the existing mission depends handler', async () => {
    const expected = { success: true, data: { fromId: 's14-m02', toId: 's14-m01' } } as any;
    (cmosMissionDepends as jest.MockedFunction<typeof cmosMissionDepends>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosMission({
      action: 'depends',
      fromId: 's14-m02',
      toId: 's14-m01',
      type: 'Requires',
      projectRoot: '/tmp/project',
    });

    expect(cmosMissionDepends).toHaveBeenCalledWith({
      fromId: 's14-m02',
      toId: 's14-m01',
      type: 'Requires',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION error for unknown action', async () => {
    const result = await cmosMission({ action: 'archive' as any });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults missing missionId to empty string for show', async () => {
    const expected = { success: false, error: { code: 'INVALID_PARAMETER' } } as any;
    (cmosMissionShow as jest.MockedFunction<typeof cmosMissionShow>).mockResolvedValueOnce(
      expected
    );

    await cmosMission({ action: 'show' });

    expect(cmosMissionShow).toHaveBeenCalledWith({
      missionId: '',
      projectRoot: undefined,
    });
  });

  describe('CMOS_MISSION_ACTIONS', () => {
    it('contains exactly 8 actions', () => {
      // s86-m08: 7 -> 8. `move` re-binds a mission to a different sprint — a CRUD field change,
      // which is why it lives here and not among the six status transitions.
      expect(CMOS_MISSION_ACTIONS).toHaveLength(8);
      expect([...CMOS_MISSION_ACTIONS]).toEqual([
        'list',
        'show',
        'status',
        'add',
        'update',
        'move',
        'depends',
        'undepends',
      ]);
    });
  });

  describe('cmosMissionToolDefinition', () => {
    it('has the correct tool name', () => {
      expect(cmosMissionToolDefinition.name).toBe('cmos_mission');
    });

    it('requires action parameter', () => {
      expect(cmosMissionToolDefinition.inputSchema.required).toContain('action');
    });

    it('disallows additional properties', () => {
      expect(cmosMissionToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('formatMissionForLLM', () => {
    it('formats INVALID_ACTION errors with available actions', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action "archive" is not supported for cmos_mission.',
          suggestion: 'Use one of the available actions.',
          availableActions: ['list', 'show', 'status', 'add', 'update', 'depends'],
        },
      };

      const formatted = formatMissionForLLM(undefined, result);

      expect(formatted).toContain('Failed to execute cmos_mission');
      expect(formatted).toContain('archive');
      expect(formatted).toContain('Available actions');
    });

    it('delegates list formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { missions: [] } } as any;
      (
        formatMissionListForLLM as jest.MockedFunction<typeof formatMissionListForLLM>
      ).mockReturnValueOnce('formatted list');

      const result = formatMissionForLLM('list', mockResult);

      expect(formatMissionListForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted list');
    });

    it('delegates show formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { id: 's14-m01' } } as any;
      (
        formatMissionShowForLLM as jest.MockedFunction<typeof formatMissionShowForLLM>
      ).mockReturnValueOnce('formatted show');

      const result = formatMissionForLLM('show', mockResult);

      expect(formatMissionShowForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted show');
    });

    it('returns fallback for unknown action', () => {
      const result = formatMissionForLLM('unknown', { success: true, data: {} } as any);
      expect(result).toContain('Mission action completed');
    });
  });

  // Sprint 79 m04: the per-handler fan-out model (isReadAction/READ_ACTIONS/
  // fanOutRead) was deleted — every cmos_mission read now pins to the sender, and
  // "active missions across the portfolio" is served by acrossProjects=true (m05).
  // The former isReadAction fan-out-eligibility assertions were removed with it.
});
