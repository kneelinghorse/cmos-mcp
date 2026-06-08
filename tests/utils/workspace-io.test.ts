import { promises as fs } from 'fs';

jest.mock('../../src/security/workspace-guard', () => ({
  resolveWorkspacePath: jest.fn(),
  getWorkspaceRoot: jest.fn(),
}));

jest.mock('../../src/utils/fs', () => ({
  pathExists: jest.fn(),
  writeFileAtomic: jest.fn(),
}));

import { resolveWorkspacePath as guardResolveWorkspacePath } from '../../src/security/workspace-guard';
import { pathExists, writeFileAtomic } from '../../src/utils/fs';
import {
  writeFileAtomicWithBackup,
  resolveWorkspacePath as resolveWorkspacePathPublic,
} from '../../src/utils/workspace-io';

const mockResolve = guardResolveWorkspacePath as jest.MockedFunction<
  typeof guardResolveWorkspacePath
>;
const mockPathExists = pathExists as jest.MockedFunction<typeof pathExists>;
const mockWriteFileAtomic = writeFileAtomic as jest.MockedFunction<typeof writeFileAtomic>;

describe('writeFileAtomicWithBackup', () => {
  const sanitizedPath = '/tmp/workspace/file.txt';
  const backupPath = `${sanitizedPath}.backup`;
  let copyFileSpy: jest.SpyInstance;

  beforeEach(() => {
    mockResolve.mockReset();
    mockResolve.mockResolvedValue(sanitizedPath);
    mockPathExists.mockReset();
    mockWriteFileAtomic.mockReset();
    copyFileSpy = jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined as unknown as void);
  });

  afterEach(() => {
    copyFileSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('delegates resolveWorkspacePath to the workspace guard helper', async () => {
    mockResolve.mockResolvedValueOnce('/tmp/workspace/resolved');

    const result = await resolveWorkspacePathPublic('file.txt', { allowRelative: false });

    expect(result).toBe('/tmp/workspace/resolved');
    expect(mockResolve).toHaveBeenLastCalledWith('file.txt', { allowRelative: false });
  });

  it('creates a backup when the target exists and returns its path', async () => {
    mockPathExists.mockResolvedValue(true);
    mockWriteFileAtomic.mockResolvedValue(undefined as unknown as void);

    const result = await writeFileAtomicWithBackup('file.txt', 'payload');

    expect(mockResolve).toHaveBeenCalledWith(
      'file.txt',
      expect.objectContaining({ allowRelative: true })
    );
    expect(copyFileSpy).toHaveBeenCalledWith(sanitizedPath, backupPath);
    expect(mockWriteFileAtomic).toHaveBeenCalledWith(sanitizedPath, 'payload', {});
    expect(result).toEqual({ backupPath });
  });

  it('skips backup creation when the target is new and supports custom suffixes', async () => {
    mockPathExists.mockResolvedValue(false);
    mockWriteFileAtomic.mockResolvedValue(undefined as unknown as void);

    const result = await writeFileAtomicWithBackup('file.txt', 'payload', {
      backupSuffix: '.bak',
      allowRelative: false,
    });

    expect(mockResolve).toHaveBeenCalledWith(
      'file.txt',
      expect.objectContaining({ allowRelative: false })
    );
    expect(copyFileSpy).not.toHaveBeenCalled();
    expect(mockWriteFileAtomic).toHaveBeenCalledWith(sanitizedPath, 'payload', {});
    expect(result).toEqual({});
  });

  it('restores the original when the write fails after creating a backup', async () => {
    mockPathExists.mockResolvedValue(true);
    const failure = new Error('write failed');
    mockWriteFileAtomic.mockRejectedValue(failure);

    await expect(writeFileAtomicWithBackup('file.txt', 'payload')).rejects.toThrow('write failed');

    expect(copyFileSpy).toHaveBeenNthCalledWith(1, sanitizedPath, backupPath);
    expect(copyFileSpy).toHaveBeenNthCalledWith(2, backupPath, sanitizedPath);
  });

  it('skips restoration when the write fails without a pre-existing file', async () => {
    mockPathExists.mockResolvedValue(false);
    mockWriteFileAtomic.mockRejectedValue(new Error('write failed'));

    await expect(writeFileAtomicWithBackup('file.txt', 'payload')).rejects.toThrow('write failed');

    expect(copyFileSpy).not.toHaveBeenCalled();
  });
});
