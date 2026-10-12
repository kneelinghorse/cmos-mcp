import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-mission-list', () => ({
  rbookMissionList: jest.fn(),
  formatMissionListForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-show', () => ({
  rbookMissionShow: jest.fn(),
  formatMissionShowForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-status', () => ({
  rbookMissionStatus: jest.fn(),
  formatMissionStatusForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-add', () => ({
  rbookMissionAdd: jest.fn(),
  formatMissionAddForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-update', () => ({
  rbookMissionUpdate: jest.fn(),
  formatMissionUpdateForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-depends', () => ({
  rbookMissionDepends: jest.fn(),
  formatMissionDependsForLLM: jest.fn(),
}));

import {
  RBOOK_MISSION_ACTIONS,
  rbookMission,
  rbookMissionToolDefinition,
  formatMissionForLLM,
} from '../../../src/tools/rbook/rbook-mission';
import {
  rbookMissionList,
  formatMissionListForLLM,
} from '../../../src/tools/rbook/rbook-mission-list';
import {
  rbookMissionShow,
  formatMissionShowForLLM,
} from '../../../src/tools/rbook/rbook-mission-show';
import {
  rbookMissionStatus,
  formatMissionStatusForLLM,
} from '../../../src/tools/rbook/rbook-mission-status';
import {
  rbookMissionAdd,
  formatMissionAddForLLM,
} from '../../../src/tools/rbook/rbook-mission-add';
import {
  rbookMissionUpdate,
  formatMissionUpdateForLLM,
} from '../../../src/tools/rbook/rbook-mission-update';
import {
  rbookMissionDepends,
  formatMissionDependsForLLM,
} from '../../../src/tools/rbook/rbook-mission-depends';

describe('rbook_mission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action to the existing mission list handler', async () => {
    const expected = { success: true, data: { missions: [], totalCount: 0 } } as any;
    (rbookMissionList as jest.MockedFunction<typeof rbookMissionList>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMission({
      action: 'list',
      sprintId: 'sprint-14',
      status: 'Queued',
      limit: 10,
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionList).toHaveBeenCalledWith({
      sprintId: 'sprint-14',
      status: 'Queued',
      limit: 10,
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes show action to the existing mission show handler', async () => {
    const expected = { success: true, data: { id: 's14-m01' } } as any;
    (rbookMissionShow as jest.MockedFunction<typeof rbookMissionShow>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMission({
      action: 'show',
      missionId: 's14-m01',
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionShow).toHaveBeenCalledWith({
      missionId: 's14-m01',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes status action to the existing mission status handler', async () => {
    const expected = { success: true, data: { inProgress: [], current: [], queued: [] } } as any;
    (rbookMissionStatus as jest.MockedFunction<typeof rbookMissionStatus>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMission({
      action: 'status',
      includeBlocked: true,
      queuedLimit: 10,
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionStatus).toHaveBeenCalledWith({
      includeBlocked: true,
      queuedLimit: 10,
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes add action to the existing mission add handler', async () => {
    const expected = { success: true, data: { id: 's14-m05' } } as any;
    (rbookMissionAdd as jest.MockedFunction<typeof rbookMissionAdd>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMission({
      action: 'add',
      missionId: 's14-m05',
      name: 'Test Mission',
      sprintId: 'sprint-14',
      objective: 'Do something',
      successCriteria: ['Criterion 1'],
      deliverables: ['File.ts'],
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionAdd).toHaveBeenCalledWith({
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
    (rbookMissionUpdate as jest.MockedFunction<typeof rbookMissionUpdate>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMission({
      action: 'update',
      missionId: 's14-m01',
      fields: { name: 'Updated Name', objective: 'New objective' },
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionUpdate).toHaveBeenCalledWith({
      missionId: 's14-m01',
      fields: { name: 'Updated Name', objective: 'New objective' },
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes depends action to the existing mission depends handler', async () => {
    const expected = { success: true, data: { fromId: 's14-m02', toId: 's14-m01' } } as any;
    (rbookMissionDepends as jest.MockedFunction<typeof rbookMissionDepends>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMission({
      action: 'depends',
      fromId: 's14-m02',
      toId: 's14-m01',
      type: 'Requires',
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionDepends).toHaveBeenCalledWith({
      fromId: 's14-m02',
      toId: 's14-m01',
      type: 'Requires',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION error for unknown action', async () => {
    const result = await rbookMission({ action: 'archive' as any });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults missing missionId to empty string for show', async () => {
    const expected = { success: false, error: { code: 'INVALID_PARAMETER' } } as any;
    (rbookMissionShow as jest.MockedFunction<typeof rbookMissionShow>).mockResolvedValueOnce(
      expected
    );

    await rbookMission({ action: 'show' });

    expect(rbookMissionShow).toHaveBeenCalledWith({
      missionId: '',
      projectRoot: undefined,
    });
  });

  describe('RBOOK_MISSION_ACTIONS', () => {
    it('contains exactly 8 actions', () => {
      // s86-m08: 7 -> 8. `move` re-binds a mission to a different sprint — a CRUD field change,
      // which is why it lives here and not among the six status transitions.
      expect(RBOOK_MISSION_ACTIONS).toHaveLength(8);
      expect([...RBOOK_MISSION_ACTIONS]).toEqual([
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

  describe('rbookMissionToolDefinition', () => {
    it('has the correct tool name', () => {
      expect(rbookMissionToolDefinition.name).toBe('rbook_mission');
    });

    it('requires action parameter', () => {
      expect(rbookMissionToolDefinition.inputSchema.required).toContain('action');
    });

    it('disallows additional properties', () => {
      expect(rbookMissionToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('formatMissionForLLM', () => {
    it('formats INVALID_ACTION errors with available actions', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action "archive" is not supported for rbook_mission.',
          suggestion: 'Use one of the available actions.',
          availableActions: ['list', 'show', 'status', 'add', 'update', 'depends'],
        },
      };

      const formatted = formatMissionForLLM(undefined, result);

      expect(formatted).toContain('Failed to execute rbook_mission');
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
  // fanOutRead) was deleted — every rbook_mission read now pins to the sender, and
  // "active missions across the portfolio" is served by acrossProjects=true (m05).
  // The former isReadAction fan-out-eligibility assertions were removed with it.
});
