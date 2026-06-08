import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-session-list', () => ({
  cmosSessionList: jest.fn(),
  formatSessionListForLLM: jest.fn(),
  VALID_SESSION_STATUSES: ['active', 'completed', 'canceled'],
}));
jest.mock('../../../src/tools/cmos/cmos-session-start', () => ({
  cmosSessionStart: jest.fn(),
  formatSessionStartForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-session-capture', () => ({
  cmosSessionCapture: jest.fn(),
  formatSessionCaptureForLLM: jest.fn(),
  VALID_CAPTURE_CATEGORIES: ['decision', 'learning', 'constraint', 'context', 'next-step'],
}));
jest.mock('../../../src/tools/cmos/cmos-session-complete', () => ({
  cmosSessionComplete: jest.fn(),
  formatSessionCompleteForLLM: jest.fn(),
}));

import {
  CMOS_SESSION_ACTIONS,
  cmosSession,
  cmosSessionToolDefinition,
  formatSessionForLLM,
} from '../../../src/tools/cmos/cmos-session';
import { cmosSessionList } from '../../../src/tools/cmos/cmos-session-list';
import { cmosSessionStart } from '../../../src/tools/cmos/cmos-session-start';
import { cmosSessionCapture } from '../../../src/tools/cmos/cmos-session-capture';
import { cmosSessionComplete } from '../../../src/tools/cmos/cmos-session-complete';

describe('cmos_session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action', async () => {
    const expected = { success: true, data: { sessions: [] } } as any;
    (cmosSessionList as jest.MockedFunction<typeof cmosSessionList>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosSession({ action: 'list', status: 'active', page: 1 });
    expect(cmosSessionList).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', page: 1 })
    );
    expect(result).toBe(expected);
  });

  it('routes start action', async () => {
    const expected = { success: true, data: { sessionId: 'PS-123' } } as any;
    (cmosSessionStart as jest.MockedFunction<typeof cmosSessionStart>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosSession({
      action: 'start',
      type: 'planning',
      title: 'Test Session',
      projectRoot: '/tmp',
    });
    expect(cmosSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'planning', title: 'Test Session' })
    );
    expect(result).toBe(expected);
  });

  it('routes capture action', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosSessionCapture as jest.MockedFunction<typeof cmosSessionCapture>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosSession({
      action: 'capture',
      category: 'decision',
      content: 'Decided X',
      missionId: 's14-m01',
    });
    expect(cmosSessionCapture).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'decision', content: 'Decided X', missionId: 's14-m01' })
    );
    expect(result).toBe(expected);
  });

  it('routes complete action', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosSessionComplete as jest.MockedFunction<typeof cmosSessionComplete>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosSession({
      action: 'complete',
      summary: 'Session done',
      nextSteps: ['Step 1'],
    });
    expect(cmosSessionComplete).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Session done', nextSteps: ['Step 1'] })
    );
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await cmosSession({ action: 'archive' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(cmosSessionToolDefinition.name).toBe('cmos_session');
    });
    it('requires action', () => {
      expect(cmosSessionToolDefinition.inputSchema.required).toContain('action');
    });
  });

  describe('CMOS_SESSION_ACTIONS', () => {
    it('contains 4 actions', () => {
      expect(CMOS_SESSION_ACTIONS).toHaveLength(4);
    });
  });

  describe('formatSessionForLLM', () => {
    it('formats INVALID_ACTION errors', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['list', 'start'],
        },
      };
      expect(formatSessionForLLM(undefined, result)).toContain('Failed to execute cmos_session');
    });

    it('returns fallback for unknown action', () => {
      expect(formatSessionForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Session action completed'
      );
    });
  });
});
