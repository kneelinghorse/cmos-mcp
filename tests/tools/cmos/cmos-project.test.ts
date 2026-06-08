import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/cmos/cmos-project-init', () => ({
  cmosProjectInit: jest.fn(),
  formatProjectInitForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-project-register', () => ({
  cmosProjectRegister: jest.fn(),
  formatProjectRegisterForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-project-list', () => ({
  cmosProjectList: jest.fn(),
  formatProjectListForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-project-unregister', () => ({
  cmosProjectUnregister: jest.fn(),
  formatProjectUnregisterForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/cmos/cmos-project-validate', () => ({
  cmosProjectValidate: jest.fn(),
  formatProjectValidateForLLM: jest.fn(),
}));

import {
  CMOS_PROJECT_ACTIONS,
  cmosProject,
  cmosProjectToolDefinition,
  formatProjectForLLM,
} from '../../../src/tools/cmos/cmos-project';
import { cmosProjectInit } from '../../../src/tools/cmos/cmos-project-init';
import { cmosProjectRegister } from '../../../src/tools/cmos/cmos-project-register';
import { cmosProjectList } from '../../../src/tools/cmos/cmos-project-list';
import { cmosProjectUnregister } from '../../../src/tools/cmos/cmos-project-unregister';
import { cmosProjectValidate } from '../../../src/tools/cmos/cmos-project-validate';

describe('cmos_project', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes init action', async () => {
    const expected = { success: true, data: { initialized: true } } as any;
    (cmosProjectInit as jest.MockedFunction<typeof cmosProjectInit>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosProject({
      action: 'init',
      projectRoot: '/tmp/test',
      projectName: 'Test Project',
      projectId: 'test-proj',
    });
    expect(cmosProjectInit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/tmp/test',
        projectName: 'Test Project',
        projectId: 'test-proj',
      })
    );
    expect(result).toBe(expected);
  });

  it('routes register action', async () => {
    const expected = { success: true, data: { registered: true } } as any;
    (cmosProjectRegister as jest.MockedFunction<typeof cmosProjectRegister>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosProject({
      action: 'register',
      projectRoot: '/tmp/test',
      name: 'My Project',
      setAsDefault: true,
    });
    expect(cmosProjectRegister).toHaveBeenCalledWith({
      projectRoot: '/tmp/test',
      name: 'My Project',
      setAsDefault: true,
    });
    expect(result).toBe(expected);
  });

  it('routes list action', async () => {
    const expected = { success: true, data: { projects: [] } } as any;
    (cmosProjectList as jest.MockedFunction<typeof cmosProjectList>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosProject({ action: 'list' });
    expect(cmosProjectList).toHaveBeenCalledWith({});
    expect(result).toBe(expected);
  });

  it('routes list with validate flag to validate handler', async () => {
    const expected = { success: true, data: { valid: true } } as any;
    (cmosProjectValidate as jest.MockedFunction<typeof cmosProjectValidate>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosProject({ action: 'list', validate: true, prune: true });
    expect(cmosProjectValidate).toHaveBeenCalledWith({ prune: true });
    expect(cmosProjectList).not.toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it('routes unregister action', async () => {
    const expected = { success: true, data: { unregistered: true } } as any;
    (
      cmosProjectUnregister as jest.MockedFunction<typeof cmosProjectUnregister>
    ).mockResolvedValueOnce(expected);

    const result = await cmosProject({ action: 'unregister', projectRoot: '/tmp/test' });
    expect(cmosProjectUnregister).toHaveBeenCalledWith({ projectRoot: '/tmp/test' });
    expect(result).toBe(expected);
  });

  it('routes validate action', async () => {
    const expected = { success: true, data: { valid: true } } as any;
    (cmosProjectValidate as jest.MockedFunction<typeof cmosProjectValidate>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosProject({ action: 'validate', prune: false });
    expect(cmosProjectValidate).toHaveBeenCalledWith({ prune: false });
    expect(result).toBe(expected);
  });

  it('routes prune action to cmosProjectValidate with prune=true', async () => {
    const expected = { success: true, data: { validations: [], summary: {} } } as any;
    (cmosProjectValidate as jest.MockedFunction<typeof cmosProjectValidate>).mockResolvedValueOnce(
      expected
    );

    const result = await cmosProject({ action: 'prune' });
    expect(cmosProjectValidate).toHaveBeenCalledWith({ prune: true });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await cmosProject({ action: 'delete' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults projectRoot for init and register', async () => {
    const expected = { success: true, data: {} } as any;
    (cmosProjectInit as jest.MockedFunction<typeof cmosProjectInit>).mockResolvedValueOnce(
      expected
    );

    await cmosProject({ action: 'init' });
    expect(cmosProjectInit).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: '' }));
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(cmosProjectToolDefinition.name).toBe('cmos_project');
    });
    it('requires action', () => {
      expect(cmosProjectToolDefinition.inputSchema.required).toContain('action');
    });
    it('disallows additional properties', () => {
      expect(cmosProjectToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('CMOS_PROJECT_ACTIONS', () => {
    it('contains 8 actions', () => {
      expect(CMOS_PROJECT_ACTIONS).toHaveLength(8);
      expect([...CMOS_PROJECT_ACTIONS]).toEqual([
        'init',
        'register',
        'list',
        'unregister',
        'validate',
        'prune',
        'update',
        'sweep',
      ]);
    });
  });

  describe('formatProjectForLLM', () => {
    it('formats INVALID_ACTION errors', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['init', 'register', 'list', 'unregister', 'validate'],
        },
      };
      expect(formatProjectForLLM(undefined, result)).toContain('Failed to execute cmos_project');
    });

    it('returns fallback for unknown action', () => {
      expect(formatProjectForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Project action completed'
      );
    });
  });
});
