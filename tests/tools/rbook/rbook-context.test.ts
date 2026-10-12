import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-context-view', () => ({
  rbookContextView: jest.fn(),
  formatContextViewForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-context-update', () => ({
  rbookContextUpdate: jest.fn(),
  formatContextUpdateForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-context-condense', () => ({
  rbookContextCondense: jest.fn(),
  formatContextCondenseForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-context-snapshot', () => ({
  rbookContextSnapshot: jest.fn(),
  formatContextSnapshotForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-context-history', () => ({
  rbookContextHistory: jest.fn(),
  formatContextHistoryForLLM: jest.fn(),
}));

import {
  RBOOK_CONTEXT_ACTIONS,
  rbookContext,
  rbookContextToolDefinition,
  formatContextForLLM,
} from '../../../src/tools/rbook/rbook-context';
import { rbookContextView } from '../../../src/tools/rbook/rbook-context-view';
import { rbookContextUpdate } from '../../../src/tools/rbook/rbook-context-update';
import { rbookContextCondense } from '../../../src/tools/rbook/rbook-context-condense';
import { rbookContextSnapshot } from '../../../src/tools/rbook/rbook-context-snapshot';
import { rbookContextHistory } from '../../../src/tools/rbook/rbook-context-history';

describe('rbook_context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes view action', async () => {
    const expected = { success: true, data: {} } as any;
    (rbookContextView as jest.MockedFunction<typeof rbookContextView>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookContext({
      action: 'view',
      contextType: 'master_context',
      sizeOnly: true,
    });
    expect(rbookContextView).toHaveBeenCalledWith(
      expect.objectContaining({ contextType: 'master_context', sizeOnly: true })
    );
    expect(result).toBe(expected);
  });

  it('routes update action', async () => {
    const expected = { success: true, data: {} } as any;
    (rbookContextUpdate as jest.MockedFunction<typeof rbookContextUpdate>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookContext({ action: 'update', mode: 'aggregate' });
    expect(rbookContextUpdate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'aggregate' }));
    expect(result).toBe(expected);
  });

  it('routes condense action', async () => {
    const expected = { success: true, data: {} } as any;
    (
      rbookContextCondense as jest.MockedFunction<typeof rbookContextCondense>
    ).mockResolvedValueOnce(expected);

    const result = await rbookContext({
      action: 'condense',
      strategy: 'conservative',
      dryRun: true,
    });
    expect(rbookContextCondense).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'conservative', dryRun: true })
    );
    expect(result).toBe(expected);
  });

  it('routes snapshot action', async () => {
    const expected = { success: true, data: {} } as any;
    (
      rbookContextSnapshot as jest.MockedFunction<typeof rbookContextSnapshot>
    ).mockResolvedValueOnce(expected);

    const result = await rbookContext({ action: 'snapshot', source: 'test-snapshot' });
    expect(rbookContextSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'test-snapshot' })
    );
    expect(result).toBe(expected);
  });

  it('routes history action', async () => {
    const expected = { success: true, data: {} } as any;
    (rbookContextHistory as jest.MockedFunction<typeof rbookContextHistory>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookContext({ action: 'history', page: 1, pageSize: 10 });
    expect(rbookContextHistory).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 10 })
    );
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await rbookContext({ action: 'archive' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(rbookContextToolDefinition.name).toBe('rbook_context');
    });
    it('requires action', () => {
      expect(rbookContextToolDefinition.inputSchema.required).toContain('action');
    });
  });

  describe('RBOOK_CONTEXT_ACTIONS', () => {
    it('contains 8 actions', () => {
      expect(RBOOK_CONTEXT_ACTIONS).toHaveLength(8);
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
      expect(formatted).toContain('Failed to execute rbook_context');
    });

    it('returns fallback for unknown action', () => {
      expect(formatContextForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Context action completed'
      );
    });
  });
});
