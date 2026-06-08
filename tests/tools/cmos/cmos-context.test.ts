import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-context-view', () => ({
  cmosContextView: jest.fn(),
  formatContextViewForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-context-update', () => ({
  cmosContextUpdate: jest.fn(),
  formatContextUpdateForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-context-condense', () => ({
  cmosContextCondense: jest.fn(),
  formatContextCondenseForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-context-snapshot', () => ({
  cmosContextSnapshot: jest.fn(),
  formatContextSnapshotForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-context-history', () => ({
  cmosContextHistory: jest.fn(),
  formatContextHistoryForLLM: jest.fn(),
}));

import {
  CMOS_CONTEXT_ACTIONS,
  cmosContext,
  cmosContextToolDefinition,
  formatContextForLLM,
} from '../../../src/tools/cmos/cmos-context';
import { cmosContextView } from '../../../src/tools/cmos/cmos-context-view';
import { cmosContextUpdate } from '../../../src/tools/cmos/cmos-context-update';
import { cmosContextCondense } from '../../../src/tools/cmos/cmos-context-condense';
import { cmosContextSnapshot } from '../../../src/tools/cmos/cmos-context-snapshot';
import { cmosContextHistory } from '../../../src/tools/cmos/cmos-context-history';

describe('cmos_context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes view action', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosContextView as jest.MockedFunction<typeof cmosContextView>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosContext({
      action: 'view',
      contextType: 'master_context',
      sizeOnly: true,
    });
    expect(cmosContextView).toHaveBeenCalledWith(
      expect.objectContaining({ contextType: 'master_context', sizeOnly: true })
    );
    expect(result).toBe(expected);
  });

  it('routes update action', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosContextUpdate as jest.MockedFunction<typeof cmosContextUpdate>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosContext({ action: 'update', mode: 'aggregate' });
    expect(cmosContextUpdate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'aggregate' }));
    expect(result).toBe(expected);
  });

  it('routes condense action', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosContextCondense as jest.MockedFunction<typeof cmosContextCondense>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosContext({
      action: 'condense',
      strategy: 'conservative',
      dryRun: true,
    });
    expect(cmosContextCondense).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'conservative', dryRun: true })
    );
    expect(result).toBe(expected);
  });

  it('routes snapshot action', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosContextSnapshot as jest.MockedFunction<typeof cmosContextSnapshot>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosContext({ action: 'snapshot', source: 'test-snapshot' });
    expect(cmosContextSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'test-snapshot' })
    );
    expect(result).toBe(expected);
  });

  it('routes history action', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosContextHistory as jest.MockedFunction<typeof cmosContextHistory>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosContext({ action: 'history', page: 1, pageSize: 10 });
    expect(cmosContextHistory).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 10 })
    );
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await cmosContext({ action: 'archive' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(cmosContextToolDefinition.name).toBe('cmos_context');
    });
    it('requires action', () => {
      expect(cmosContextToolDefinition.inputSchema.required).toContain('action');
    });
  });

  describe('CMOS_CONTEXT_ACTIONS', () => {
    it('contains 8 actions', () => {
      expect(CMOS_CONTEXT_ACTIONS).toHaveLength(8);
    });
  });

  describe('formatContextForLLM', () => {
    it('formats INVALID_ACTION errors', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['view', 'update'],
        },
      };
      const formatted = formatContextForLLM(undefined, result);
      expect(formatted).toContain('Failed to execute cmos_context');
    });

    it('returns fallback for unknown action', () => {
      expect(formatContextForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Context action completed'
      );
    });
  });
});
