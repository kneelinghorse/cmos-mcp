import { promises as fs, constants } from 'fs';
import type { Mode, PathLike, RmOptions, WriteFileOptions } from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';

function normalizeError(error: unknown): NodeJS.ErrnoException {
  if (error instanceof Error) {
    return error as NodeJS.ErrnoException;
  }

  return Object.assign(new Error(String(error)), { code: 'UNKNOWN' }) as NodeJS.ErrnoException;
}

export async function pathExists(targetPath: PathLike): Promise<boolean> {
  try {
    await fs.access(targetPath, constants.F_OK);
    return true;
  } catch (error) {
    const err = normalizeError(error);
    const code = typeof err.code === 'string' ? err.code.toUpperCase() : undefined;
    const message = (err.message || '').toUpperCase();

    if (
      code === 'ENOENT' ||
      code === 'ENOTDIR' ||
      message.includes('ENOENT') ||
      message.includes('ENOTDIR')
    ) {
      return false;
    }
    throw err;
  }
}

export async function ensureDir(directoryPath: PathLike): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
}

export async function writeFileAtomic(
  filePath: PathLike,
  data: string | NodeJS.ArrayBufferView,
  options: WriteFileOptions = {}
): Promise<void> {
  const resolvedPath = typeof filePath === 'string' ? filePath : filePath.toString();
  const directory = path.dirname(resolvedPath);
  await ensureDir(directory);

  const uniqueSuffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tempFile = path.join(directory, `.tmp-${path.basename(resolvedPath)}-${uniqueSuffix}`);

  try {
    await fs.writeFile(tempFile, data, options);
    await fs.rename(tempFile, resolvedPath);
  } catch (error) {
    const err = normalizeError(error);
    if (err.code === 'EXDEV') {
      // Cross-device rename fallback: copy + unlink
      await fs.copyFile(tempFile, resolvedPath, constants.COPYFILE_FICLONE);
      await fs.unlink(tempFile);
    } else {
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup failures
      }
      throw err;
    }
  }
}

export async function removeFile(targetPath: PathLike): Promise<void> {
  try {
    await fs.unlink(targetPath);
  } catch (error) {
    const err = normalizeError(error);
    const code = typeof err.code === 'string' ? err.code.toUpperCase() : undefined;
    const message = (err.message || '').toUpperCase();
    if (code === 'ENOENT' || message.includes('ENOENT')) {
      return;
    }
    throw err;
  }
}

export async function removeDir(
  targetPath: PathLike,
  options: RmOptions = { recursive: true, force: true }
): Promise<void> {
  await fs.rm(targetPath, options);
}

export async function chmod(targetPath: PathLike, mode: Mode): Promise<void> {
  await fs.chmod(targetPath, mode);
}

export interface MkdirOptions {
  readonly mode?: Mode;
}

export async function ensureTempDir(prefix: string): Promise<string> {
  const base = path.join(os.tmpdir(), prefix);
  await ensureDir(base);
  return fs.mkdtemp(`${base}${path.sep}`);
}

export type ConcurrencyTask<T> = () => Promise<T>;

export async function runWithConcurrency<T>(
  tasks: readonly ConcurrencyTask<T>[],
  limit = 8
): Promise<T[]> {
  if (limit <= 0) {
    throw new Error('Concurrency limit must be greater than zero');
  }

  const results: T[] = [];
  let current = 0;

  async function worker(): Promise<void> {
    while (current < tasks.length) {
      const index = current++;
      results[index] = await tasks[index]();
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
