import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { resolveWorkspacePath, isPathWithinWorkspace } from '../../src/security/workspace-guard';
import { SanitizationError } from '../../src/validation/errors';
import * as validationCommon from '../../src/validation/common';

describe('workspace guard', () => {
  const WORKSPACE_ENV_KEYS = [
    'MISSION_PROTOCOL_WORKSPACE_ALLOWLIST',
    'MISSION_PROTOCOL_WORKSPACE_ROOT',
    'MCP_WORKSPACE_ROOT',
    'WORKSPACE_ROOT',
  ] as const;

  let envBackup: Partial<Record<(typeof WORKSPACE_ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    envBackup = {};
    jest.restoreAllMocks();
    jest.clearAllMocks();
    for (const key of WORKSPACE_ENV_KEYS) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of WORKSPACE_ENV_KEYS) {
      const value = envBackup[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  test('resolveWorkspacePath rejects when baseDir is outside the allowlist', async () => {
    const allowedBase = path.join(process.cwd(), 'tests', 'workspace-guard', 'allowed-root');
    const disallowedBase = path.join(process.cwd(), 'tests', 'workspace-guard', 'disallowed-root');

    process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = allowedBase;

    await expect(resolveWorkspacePath('config.yaml', { baseDir: disallowedBase })).rejects.toThrow(
      'Base directory is not within the configured workspace allowlist'
    );
  });

  test('resolveWorkspacePath returns fallback sanitization error when all bases reject with non-errors', async () => {
    const firstBase = path.join(process.cwd(), 'tests', 'workspace-guard', 'first');
    const secondBase = path.join(process.cwd(), 'tests', 'workspace-guard', 'second');

    process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = [firstBase, secondBase].join(path.delimiter);

    const safeFilePathSpy = jest
      .spyOn(validationCommon, 'safeFilePath')
      .mockImplementation(async (_, options) => {
        if (options?.baseDir === firstBase) {
          throw 'first failure';
        }
        throw 'final failure';
      });

    let caughtError: unknown;
    try {
      await resolveWorkspacePath('config.yaml');
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(SanitizationError);
    expect((caughtError as SanitizationError).message).toBe(
      'Path is not within allowed workspace directories'
    );

    expect(safeFilePathSpy).toHaveBeenCalledTimes(2);
    expect(safeFilePathSpy).toHaveBeenNthCalledWith(
      1,
      'config.yaml',
      expect.objectContaining({ baseDir: firstBase })
    );
    expect(safeFilePathSpy).toHaveBeenNthCalledWith(
      2,
      'config.yaml',
      expect.objectContaining({ baseDir: secondBase })
    );
  });

  test('resolveWorkspacePath rethrows the last error when safeFilePath yields real errors', async () => {
    const firstBase = path.join(process.cwd(), 'tests', 'workspace-guard', 'first');
    const secondBase = path.join(process.cwd(), 'tests', 'workspace-guard', 'second');

    process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = [firstBase, secondBase].join(path.delimiter);

    const firstError = new Error('first failure');
    const finalError = new Error('final failure');

    const safeFilePathSpy = jest
      .spyOn(validationCommon, 'safeFilePath')
      .mockImplementation(async (_, options) => {
        if (options?.baseDir === firstBase) {
          throw firstError;
        }
        throw finalError;
      });

    await expect(resolveWorkspacePath('config.yaml')).rejects.toBe(finalError);
    expect(safeFilePathSpy).toHaveBeenCalledTimes(2);
  });

  test('isPathWithinWorkspace handles allowlist entries with and without trailing separators', () => {
    const baseWithoutTrailing = path.join(process.cwd(), 'tests', 'workspace-guard', 'primary');
    const baseWithTrailing = `${path.join(process.cwd(), 'tests', 'workspace-guard', 'secondary')}${path.sep}`;

    process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = [
      baseWithoutTrailing,
      baseWithTrailing,
      baseWithoutTrailing,
    ].join(path.delimiter);

    const insidePrimary = path.join(baseWithoutTrailing, 'project', 'file.txt');
    const baseWithTrailingNormalized = path.resolve(baseWithTrailing);
    const insideSecondary = path.join(baseWithTrailingNormalized, 'nested', 'config.json');
    const outsidePath = path.join(
      process.cwd(),
      'tests',
      'workspace-guard',
      'external',
      'file.txt'
    );

    expect(isPathWithinWorkspace(baseWithoutTrailing)).toBe(true);
    expect(isPathWithinWorkspace(insidePrimary)).toBe(true);
    expect(isPathWithinWorkspace(baseWithTrailingNormalized)).toBe(true);
    expect(isPathWithinWorkspace(insideSecondary)).toBe(true);
    expect(isPathWithinWorkspace(outsidePath)).toBe(false);
  });

  test('isPathWithinWorkspace treats filesystem root entries as valid allowlist bases', () => {
    const rootEntry = path.parse(process.cwd()).root || path.sep;
    process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = rootEntry;

    const nestedPath = path.join(rootEntry, 'var', 'tmp', 'workspace-file.txt');
    expect(isPathWithinWorkspace(nestedPath)).toBe(true);
  });

  test('resolveWorkspacePath resolves relative paths within allowlisted base directories', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-'));
    try {
      process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = tempRoot;

      const resolved = await resolveWorkspacePath('nested/config.yaml');
      expect(resolved).toBe(path.join(tempRoot, 'nested', 'config.yaml'));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('resolveWorkspacePath rejects relative paths when allowRelative is false', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-'));
    try {
      process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = tempRoot;

      await expect(
        resolveWorkspacePath('relative/file.txt', { allowRelative: false })
      ).rejects.toThrow('Path must be absolute');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('resolveWorkspacePath rejects when allowlist base is missing on disk', async () => {
    const pendingBase = path.join(
      os.tmpdir(),
      'workspace-guard-missing',
      `${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = pendingBase;

    await expect(resolveWorkspacePath('subdir/file.yml')).rejects.toThrow(
      'Path escapes allowed base directory via unresolved symlink'
    );
  });

  test('resolveWorkspacePath supports filesystem root allowlist entries', async () => {
    const rootEntry = path.parse(process.cwd()).root || path.sep;
    process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = rootEntry;

    const targetRelative = path.join('tmp', 'workspace-guard', 'root-file.txt');
    const resolved = await resolveWorkspacePath(targetRelative);

    expect(resolved).toBe(path.resolve(rootEntry, targetRelative));
  });

  test('resolveWorkspacePath rejects paths that escape the allowlisted base directory', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-'));
    try {
      process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = tempRoot;
      const outsideAbsolute = path.resolve(os.tmpdir(), 'outside-file.yaml');

      await expect(resolveWorkspacePath(outsideAbsolute)).rejects.toThrow(
        'Path escapes allowed base directory'
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('resolveWorkspacePath rejects symlinks that resolve outside the base directory', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-base-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-outside-'));
    const outsideFile = path.join(outsideDir, 'target.txt');
    const symlinkPath = path.join(baseDir, 'outside-link.txt');

    try {
      await fs.writeFile(outsideFile, 'outside');
      await fs.symlink(outsideFile, symlinkPath, 'file');

      process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = baseDir;

      await expect(resolveWorkspacePath('outside-link.txt')).rejects.toThrow(
        'Path escapes allowed base directory via symlink resolution'
      );
    } finally {
      await fs.rm(symlinkPath, { force: true });
      await fs.rm(baseDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('resolveWorkspacePath permits symlinks when allowSymbolicLinks is enabled', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-base-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-outside-'));
    const outsideFile = path.join(outsideDir, 'target.txt');
    const symlinkPath = path.join(baseDir, 'outside-link.txt');

    try {
      await fs.writeFile(outsideFile, 'outside');
      await fs.symlink(outsideFile, symlinkPath, 'file');

      process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = baseDir;

      const resolved = await resolveWorkspacePath('outside-link.txt', {
        allowSymbolicLinks: true,
      });

      expect(resolved).toBe(symlinkPath);
    } finally {
      await fs.rm(symlinkPath, { force: true });
      await fs.rm(baseDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('resolveWorkspacePath rejects symlinks within the base when symbolic links are disabled', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-base-'));
    const targetFile = path.join(baseDir, 'target.txt');
    const symlinkPath = path.join(baseDir, 'alias.txt');

    try {
      await fs.writeFile(targetFile, 'inside');
      await fs.symlink(targetFile, symlinkPath, 'file');

      process.env.MISSION_PROTOCOL_WORKSPACE_ALLOWLIST = baseDir;

      let caughtError: unknown;
      try {
        await resolveWorkspacePath('alias.txt');
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(SanitizationError);
      expect((caughtError as SanitizationError).message).toBe(
        'Unable to inspect filesystem entry for symbolic links'
      );
    } finally {
      await fs.rm(symlinkPath, { force: true });
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});
