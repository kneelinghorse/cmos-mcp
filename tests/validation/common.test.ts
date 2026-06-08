import { promises as fs } from 'fs';
import path from 'path';
import {
  safeFilePath,
  missionId,
  domainName,
  yamlContent,
  jsonContent,
  FilePathSchema,
} from '../../src/validation/common';
import { SanitizationError, SchemaError } from '../../src/validation/errors';
import { ensureDir, ensureTempDir, removeDir } from '../../src/utils/fs';
import { z } from 'zod';

describe('validation/common', () => {
  describe('safeFilePath', () => {
    it('sanitizes relative paths by normalizing segments', async () => {
      const result = await safeFilePath('./templates/../templates/sample.yaml', {
        allowRelative: true,
      });
      expect(result).toBe(path.normalize('templates/sample.yaml'));
    });

    it('rejects paths that escape the base directory', async () => {
      await expect(
        safeFilePath('../etc/passwd', { allowRelative: true, baseDir: '/srv/app' })
      ).rejects.toThrow(SanitizationError);
    });

    it('rejects paths exceeding max length', async () => {
      const longName = 'a'.repeat(20);
      await expect(safeFilePath(longName, { maxLength: 10 })).rejects.toThrow(SanitizationError);
    });

    it('rejects parent directory traversals', async () => {
      await expect(safeFilePath('foo/../..')).rejects.toThrow(SanitizationError);
    });

    it('requires absolute path when allowRelative=false', async () => {
      await expect(safeFilePath('relative/path.yaml', { allowRelative: false })).rejects.toThrow(
        SanitizationError
      );
    });

    it('enforces allowed extensions when provided', async () => {
      await expect(
        safeFilePath('templates/sample.txt', {
          allowRelative: true,
          allowedExtensions: ['.yaml', '.yml'],
        })
      ).rejects.toThrow(SanitizationError);
    });

    it('honors allowed extensions specified without a leading dot', async () => {
      const tempDir = await ensureTempDir('validation-ext-');
      const target = path.join(tempDir, 'sample.yaml');
      await fs.writeFile(target, 'test', 'utf-8');

      try {
        const sanitized = await safeFilePath(target, {
          allowedExtensions: ['yaml'],
          allowRelative: false,
        });
        expect(sanitized).toBe(target);
      } finally {
        await removeDir(tempDir, { recursive: true, force: true });
      }
    });

    it('resolves relative paths against base directories that include a trailing separator', async () => {
      const baseDir = await ensureTempDir('validation-base-');
      const sanitized = await safeFilePath('nested/file.txt', {
        baseDir: `${baseDir}${path.sep}`,
        allowRelative: true,
      });

      expect(sanitized).toContain(path.join(baseDir, 'nested', 'file.txt'));
      await removeDir(baseDir, { recursive: true, force: true });
    });

    it('rejects paths that resolve outside the base directory via symlink', async () => {
      const tempRoot = await ensureTempDir('safe-path-');
      const baseDir = path.join(tempRoot, 'base');
      const outsideDir = path.join(tempRoot, 'outside');

      await ensureDir(baseDir);
      await ensureDir(outsideDir);

      const symlinkPath = path.join(baseDir, 'link');
      await fs.symlink(outsideDir, symlinkPath, 'dir');

      try {
        await expect(
          safeFilePath(path.join('link', 'payload.json'), {
            allowRelative: true,
            baseDir,
          })
        ).rejects.toThrow(SanitizationError);
      } finally {
        await removeDir(tempRoot, { recursive: true, force: true });
      }
    });

    it('rejects symlink escapes discovered via ancestor lookup', async () => {
      const tempRoot = await ensureTempDir('ancestor-symlink-');
      const baseDir = path.join(tempRoot, 'base');
      const outsideDir = path.join(tempRoot, 'outside');

      await ensureDir(baseDir);
      await ensureDir(outsideDir);

      const symlinkPath = path.join(baseDir, 'link');
      await fs.symlink(outsideDir, symlinkPath, 'dir');

      try {
        await expect(
          safeFilePath('link/new-mission.yaml', {
            allowRelative: true,
            baseDir,
          })
        ).rejects.toThrow('Path escapes allowed base directory via unresolved symlink');
      } finally {
        await removeDir(tempRoot, { recursive: true, force: true });
      }
    });

    it('allows symlinks when explicitly permitted', async () => {
      const tempRoot = await ensureTempDir('safe-path-allow-symlink-');
      const baseDir = path.join(tempRoot, 'base');
      const outsideDir = path.join(tempRoot, 'outside');

      await ensureDir(baseDir);
      await ensureDir(outsideDir);

      const symlinkPath = path.join(baseDir, 'link');
      await fs.symlink(outsideDir, symlinkPath, 'dir');

      try {
        const sanitized = await safeFilePath(path.join('link', 'payload.json'), {
          allowRelative: true,
          baseDir,
          allowSymbolicLinks: true,
        });

        expect(sanitized.endsWith(path.join('link', 'payload.json'))).toBe(true);
      } finally {
        await removeDir(tempRoot, { recursive: true, force: true });
      }
    });

    it('propagates filesystem inspection failures with context', async () => {
      const tempRoot = await ensureTempDir('safe-path-lstat-');
      const baseDir = path.join(tempRoot, 'base');
      const targetFile = path.join(baseDir, 'mission.yaml');

      await ensureDir(baseDir);
      await fs.writeFile(targetFile, 'name: demo');

      const lstatSpy = jest.spyOn(fs, 'lstat').mockRejectedValue(new Error('permission denied'));

      try {
        await expect(
          safeFilePath('mission.yaml', { allowRelative: true, baseDir })
        ).rejects.toThrow('Unable to inspect filesystem entry for symbolic links');
        expect(lstatSpy).toHaveBeenCalled();
      } finally {
        lstatSpy.mockRestore();
        await removeDir(tempRoot, { recursive: true, force: true });
      }
    });

    it('surface unexpected realpath failures as sanitization errors', async () => {
      const tempRoot = await ensureTempDir('safe-path-realpath-');
      const baseDir = path.join(tempRoot, 'base');
      await ensureDir(baseDir);
      const actualRealpath = jest.requireActual('fs').promises.realpath;
      const realpathSpy = jest.spyOn(fs, 'realpath').mockImplementation(async (input) => {
        const target = String(input);
        if (target.endsWith(`${path.sep}mission.yaml`)) {
          const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
          throw err;
        }
        return actualRealpath(input as string);
      });

      try {
        await expect(
          safeFilePath('mission.yaml', { allowRelative: true, baseDir })
        ).rejects.toThrow('Unable to resolve real path');
      } finally {
        realpathSpy.mockRestore();
        await removeDir(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('missionId', () => {
    it('accepts valid mission identifiers', () => {
      expect(missionId('M02-security')).toBe('M02-security');
    });

    it('rejects malformed mission identifiers', () => {
      expect(() => missionId('mission-02')).toThrow();
    });
  });

  describe('domainName', () => {
    it('enforces lowercase kebab-case names', () => {
      expect(domainName('operations-core')).toBe('operations-core');
      expect(() => domainName('OperationsCore')).toThrow();
    });
  });

  describe('yamlContent', () => {
    it('parses YAML safely', () => {
      const result = yamlContent('foo: bar');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('throws SchemaError on invalid YAML', () => {
      expect(() => yamlContent('foo: [1, 2')).toThrow(SchemaError);
    });

    it('validates parsed YAML against supplied schema', () => {
      const schema = z.object({ name: z.string(), steps: z.array(z.string()) });
      const result = yamlContent<{ name: string; steps: string[] }>(
        'name: demo\nsteps:\n  - one\n  - two',
        { schema }
      );

      expect(result.name).toBe('demo');
      expect(result.steps).toEqual(['one', 'two']);
    });

    it('surfaces schema validation errors with context', () => {
      const schema = z.object({ name: z.string().min(3) });
      expect(() => yamlContent('name: x', { schema })).toThrow(SchemaError);
    });
  });

  describe('jsonContent', () => {
    it('parses JSON content', () => {
      const result = jsonContent('{"foo":"bar"}');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('throws SchemaError when JSON is malformed', () => {
      expect(() => jsonContent('{"foo":}')).toThrow(SchemaError);
    });

    it('validates JSON payloads when schema provided', () => {
      const schema = z.object({ id: z.string().uuid(), count: z.number().int().min(0) });
      const payload = jsonContent<{ id: string; count: number }>(
        JSON.stringify({ id: '0b6a0d9e-6f85-4eb8-8425-41de9f8bfe83', count: 3 }),
        { schema }
      );

      expect(payload.count).toBe(3);
    });

    it('throws SchemaError when JSON schema validation fails', () => {
      const schema = z.object({ id: z.string().uuid() });
      expect(() => jsonContent(JSON.stringify({ id: 'not-a-uuid' }), { schema })).toThrow(
        SchemaError
      );
    });
  });

  describe('FilePathSchema', () => {
    it('returns validation errors normalized through safeFilePath', async () => {
      const result = await FilePathSchema.safeParseAsync('../escape.txt');
      expect(result.success).toBe(false);
      const issue = result.success ? null : result.error.issues[0];
      expect(issue?.message).toContain('Path cannot contain parent directory traversals');
    });

    it('resolves relative paths to sanitized file system locations', async () => {
      const result = await FilePathSchema.parseAsync('fixtures/mission.yaml');
      expect(result).toContain(`fixtures${path.sep}mission.yaml`);
      expect(path.isAbsolute(result)).toBe(false);
    });
  });
});
