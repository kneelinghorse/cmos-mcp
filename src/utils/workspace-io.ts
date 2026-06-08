import { promises as fs } from 'fs';
import { pathExists, writeFileAtomic } from './fs';
import {
  resolveWorkspacePath as guardResolveWorkspacePath,
  WorkspacePathOptions,
} from '../security/workspace-guard';

export { getWorkspaceRoot } from '../security/workspace-guard';

export type ResolveWorkspacePathOptions = WorkspacePathOptions;

export async function resolveWorkspacePath(
  inputPath: string,
  options: ResolveWorkspacePathOptions = {}
): Promise<string> {
  return guardResolveWorkspacePath(inputPath, options);
}

export interface AtomicWorkspaceWriteOptions {
  readonly encoding?: BufferEncoding | null;
  readonly mode?: number;
  readonly flag?: string;
  readonly signal?: AbortSignal;
  readonly backupSuffix?: string;
  readonly allowedExtensions?: readonly string[];
  readonly allowRelative?: boolean;
  readonly baseDir?: string;
}

export async function writeFileAtomicWithBackup(
  targetPath: string,
  data: string | NodeJS.ArrayBufferView,
  options: AtomicWorkspaceWriteOptions = {}
): Promise<{ backupPath?: string }> {
  const { backupSuffix, allowedExtensions, allowRelative, baseDir, ...writeOptions } = options;
  const sanitizedTarget = await guardResolveWorkspacePath(targetPath, {
    allowRelative: allowRelative ?? true,
    allowedExtensions,
    baseDir,
  });

  const suffix = backupSuffix ?? '.backup';
  const backupPath = `${sanitizedTarget}${suffix}`;
  const originalExists = await pathExists(sanitizedTarget);
  let backupCreated = false;

  if (originalExists) {
    await fs.copyFile(sanitizedTarget, backupPath);
    backupCreated = true;
  }

  try {
    await writeFileAtomic(sanitizedTarget, data, writeOptions);
    return backupCreated ? { backupPath } : {};
  } catch (error) {
    if (backupCreated) {
      await fs.copyFile(backupPath, sanitizedTarget).catch(() => undefined);
    }
    throw error;
  }
}
