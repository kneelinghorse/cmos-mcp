import { promises as fsPromises } from 'fs';
import path from 'path';
import {
  pathExists,
  removeFile,
  runWithConcurrency,
  writeFileAtomic,
  ensureTempDir,
  removeDir,
} from '../../src/utils/fs';

describe('fs utility helpers', () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await ensureTempDir('fs-utils-test-');
  });

  afterEach(async () => {
    await removeDir(sandbox, { recursive: true, force: true });
  });

  it('returns false from pathExists for missing files', async () => {
    const missingPath = path.join(sandbox, 'missing.json');
    await expect(pathExists(missingPath)).resolves.toBe(false);
  });

  it('rethrows unexpected errors from pathExists', async () => {
    const accessSpy = jest
      .spyOn(fsPromises, 'access')
      .mockRejectedValue(Object.assign(new Error('boom'), { code: 'EACCES' }));

    await expect(pathExists(path.join(sandbox, 'denied.txt'))).rejects.toThrow('boom');

    accessSpy.mockRestore();
  });

  it('ignores missing files in removeFile', async () => {
    await expect(removeFile(path.join(sandbox, 'no-file.log'))).resolves.toBeUndefined();
  });

  it('propagates unexpected errors from removeFile', async () => {
    const unlinkSpy = jest
      .spyOn(fsPromises, 'unlink')
      .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expect(removeFile(path.join(sandbox, 'protected.txt'))).rejects.toThrow(
      'permission denied'
    );

    unlinkSpy.mockRestore();
  });

  it('writes files atomically', async () => {
    const target = path.join(sandbox, 'atomic.txt');
    await writeFileAtomic(target, 'atomic payload');
    const content = await fsPromises.readFile(target, 'utf-8');
    expect(content).toBe('atomic payload');
  });

  it('falls back to copy on cross-device rename errors', async () => {
    const target = path.join(sandbox, 'exdev.txt');

    const renameSpy = jest
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));

    const copySpy = jest.spyOn(fsPromises, 'copyFile').mockImplementation(async (src, dest) => {
      const data = await fsPromises.readFile(src);
      await fsPromises.writeFile(dest, data);
    });

    const unlinkSpy = jest.spyOn(fsPromises, 'unlink').mockResolvedValue();

    await writeFileAtomic(target, 'fallback payload');

    expect(copySpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);

    renameSpy.mockRestore();
    copySpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it('cleans up temp files when rename fails unexpectedly', async () => {
    const target = path.join(sandbox, 'rename-failure.txt');

    const renameSpy = jest
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('rename-failure'), { code: 'EPERM' }));

    const unlinkSpy = jest.spyOn(fsPromises, 'unlink');

    await expect(writeFileAtomic(target, 'data')).rejects.toThrow('rename-failure');
    expect(unlinkSpy).toHaveBeenCalled();

    renameSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it('executes tasks with concurrency control', async () => {
    const order: number[] = [];
    const tasks = Array.from({ length: 4 }, (_, index) => async () => {
      order.push(index);
      return index * 2;
    });

    const results = await runWithConcurrency(tasks, 2);
    expect(results).toEqual([0, 2, 4, 6]);
    expect(order).toHaveLength(4);
  });

  it('throws when concurrency limit is invalid', async () => {
    await expect(runWithConcurrency([], 0)).rejects.toThrow(/greater than zero/i);
  });
});
