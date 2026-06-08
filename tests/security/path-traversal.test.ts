/**
 * Path Traversal Security Tests
 * Validates Layer 1: Path Sanitization
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { SecureYAMLLoader } from '../../src/loaders/yaml-loader';
import { PathTraversalError } from '../../src/types/errors';
import { ensureDir, ensureTempDir, pathExists, removeDir } from '../../src/utils/fs';

describe('Path Traversal Security Tests', () => {
  let tempDir: string;
  let loader: SecureYAMLLoader;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await ensureTempDir('yaml-loader-test-');
    loader = new SecureYAMLLoader({ baseDir: tempDir });

    // Create a safe test file
    await fs.writeFile(path.join(tempDir, 'safe.yaml'), 'key: value\nnumber: 42');
  });

  afterEach(async () => {
    // Clean up temp directory
    await removeDir(tempDir, { recursive: true, force: true });
  });

  describe('Path Traversal Attacks', () => {
    test('should block ../ traversal attempt', async () => {
      expect(() => {
        loader.sanitizePath('../etc/passwd');
      }).toThrow(PathTraversalError);
    });

    test('should block ../../ traversal attempt', async () => {
      expect(() => {
        loader.sanitizePath('../../etc/passwd');
      }).toThrow(PathTraversalError);
    });

    test('should block ../../../ traversal attempt', async () => {
      expect(() => {
        loader.sanitizePath('../../../etc/passwd');
      }).toThrow(PathTraversalError);
    });

    test('should block absolute path outside baseDir', async () => {
      expect(() => {
        loader.sanitizePath('/etc/passwd');
      }).toThrow(PathTraversalError);
    });

    test('should block path with .. in the middle', async () => {
      expect(() => {
        loader.sanitizePath('subdir/../../../etc/passwd');
      }).toThrow(PathTraversalError);
    });

    test('should block hidden .. in path', async () => {
      expect(() => {
        loader.sanitizePath('safe/../../../etc/passwd');
      }).toThrow(PathTraversalError);
    });

    test('should block traversal with mixed separators', async () => {
      expect(() => {
        loader.sanitizePath('../etc/passwd');
      }).toThrow(PathTraversalError);
    });

    test('should block traversal with null bytes', async () => {
      expect(() => {
        loader.sanitizePath('../etc/passwd\x00.yaml');
      }).toThrow(PathTraversalError);
    });

    test('should block multiple levels of parent traversal', async () => {
      expect(() => {
        loader.sanitizePath('../../../../root/.ssh/id_rsa');
      }).toThrow(PathTraversalError);
    });

    test('should block relative path that resolves outside', async () => {
      expect(() => {
        loader.sanitizePath('subdir/../../outside.yaml');
      }).toThrow(PathTraversalError);
    });

    test('should block absolute path targeting parent directory', async () => {
      const outsideAbs = path.resolve(tempDir, '..', 'outside.yaml');
      expect(() => {
        loader.sanitizePath(outsideAbs);
      }).toThrow(PathTraversalError);
    });

    test('should block traversal with current directory segments', async () => {
      expect(() => {
        loader.sanitizePath('./.././../etc/passwd');
      }).toThrow(PathTraversalError);
    });
  });

  describe('Valid Paths', () => {
    test('should allow simple filename', async () => {
      const sanitized = loader.sanitizePath('safe.yaml');
      expect(sanitized).toBe(path.join(tempDir, 'safe.yaml'));
    });

    test('should allow subdirectory path', async () => {
      // Create subdirectory and file
      const subdir = path.join(tempDir, 'subdir');
      await ensureDir(subdir);
      await fs.writeFile(path.join(subdir, 'file.yaml'), 'data: test');

      const sanitized = loader.sanitizePath('subdir/file.yaml');
      expect(sanitized).toBe(path.join(tempDir, 'subdir', 'file.yaml'));
    });

    test('should allow nested subdirectories', async () => {
      const nested = path.join(tempDir, 'a', 'b', 'c');
      await ensureDir(nested);
      await fs.writeFile(path.join(nested, 'file.yaml'), 'data: test');

      const sanitized = loader.sanitizePath('a/b/c/file.yaml');
      expect(sanitized).toBe(path.join(tempDir, 'a', 'b', 'c', 'file.yaml'));
    });

    test('should allow absolute path within baseDir', async () => {
      const filePath = path.join(tempDir, 'safe.yaml');
      const sanitized = loader.sanitizePath(filePath);
      expect(sanitized).toBe(filePath);
    });

    test('should handle current directory reference', async () => {
      const sanitized = loader.sanitizePath('./safe.yaml');
      expect(sanitized).toBe(path.join(tempDir, 'safe.yaml'));
    });
  });

  describe('Symbolic Link Security', () => {
    test('should block symlinks by default', async () => {
      // Create a symlink within baseDir (pointing to internal file)
      const targetFile = path.join(tempDir, 'target.yaml');
      const symlinkPath = path.join(tempDir, 'symlink.yaml');

      await fs.writeFile(targetFile, 'data: test');

      try {
        await fs.symlink(targetFile, symlinkPath);

        await expect(loader.load('symlink.yaml')).rejects.toThrow('Symbolic links not allowed');
      } finally {
        // Cleanup
        if (await pathExists(symlinkPath)) {
          await fs.unlink(symlinkPath);
        }
      }
    });

    test('should allow symlinks when explicitly enabled', async () => {
      const loaderWithSymlinks = new SecureYAMLLoader({
        baseDir: tempDir,
        followSymlinks: true,
      });

      // Create symlink within baseDir
      const targetFile = path.join(tempDir, 'target.yaml');
      const symlinkPath = path.join(tempDir, 'link.yaml');

      await fs.writeFile(targetFile, 'data: symlink-test');

      try {
        await fs.symlink(targetFile, symlinkPath);

        const data = await loaderWithSymlinks.load('link.yaml');
        expect(data).toEqual({ data: 'symlink-test' });
      } finally {
        // Cleanup
        if (await pathExists(symlinkPath)) {
          await fs.unlink(symlinkPath);
        }
      }
    });
  });

  describe('File Size Limits', () => {
    test('should reject files exceeding size limit', async () => {
      const smallLoader = new SecureYAMLLoader({
        baseDir: tempDir,
        maxFileSize: 100, // 100 bytes
      });

      // Create a large file
      const largeFile = path.join(tempDir, 'large.yaml');
      await fs.writeFile(largeFile, 'x'.repeat(200));

      await expect(smallLoader.load('large.yaml')).rejects.toThrow('File too large');
    });

    test('should accept files within size limit', async () => {
      const result = await loader.load('safe.yaml');
      expect(result).toHaveProperty('key', 'value');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty path gracefully', async () => {
      // Empty path resolves to baseDir itself
      const sanitized = loader.sanitizePath('');
      expect(sanitized).toBe(tempDir);
    });

    test('should handle path with trailing slashes', async () => {
      const sanitized = loader.sanitizePath('safe.yaml/');
      expect(sanitized).toBe(path.join(tempDir, 'safe.yaml'));
    });

    test('should handle path with multiple slashes', async () => {
      const subdir = path.join(tempDir, 'sub');
      await ensureDir(subdir);
      await fs.writeFile(path.join(subdir, 'file.yaml'), 'test: data');

      const sanitized = loader.sanitizePath('sub//file.yaml');
      expect(sanitized).toBe(path.join(tempDir, 'sub', 'file.yaml'));
    });
  });
});
