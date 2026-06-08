/**
 * Migration Engine Tests
 *
 * Tests migration path finding, execution, rollback, and statistics
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { VersionManager } from '../../src/versioning/version-manager';
import { MigrationEngine, createMigration } from '../../src/versioning/migration-engine';
import {
  SemanticVersion,
  MigrationScript,
  MigrationError,
  MigrationResult,
  SuccessfulMigrationResult,
  FailedMigrationResult,
  isSuccessfulMigrationResult,
} from '../../src/versioning/types';
import { ensureDir, pathExists, removeDir } from '../../src/utils/fs';

function expectSuccessfulResult(
  result: MigrationResult,
  message = 'Expected migration to succeed'
): SuccessfulMigrationResult {
  expect(result.success).toBe(true);

  if (!isSuccessfulMigrationResult(result)) {
    throw new Error(message);
  }

  return result;
}

function expectFailedResult(
  result: MigrationResult,
  message = 'Expected migration to fail'
): FailedMigrationResult {
  expect(result.success).toBe(false);

  if (isSuccessfulMigrationResult(result)) {
    throw new Error(message);
  }

  return result;
}

describe('MigrationEngine', () => {
  let versionManager: VersionManager;
  let migrationEngine: MigrationEngine;
  const testDir = path.join(__dirname, 'test-backups');

  beforeAll(async () => {
    await ensureDir(testDir);
  });

  beforeEach(async () => {
    await removeDir(testDir, { recursive: true, force: true });
    await ensureDir(testDir);
    versionManager = new VersionManager();
    migrationEngine = new MigrationEngine(versionManager);
  });

  afterAll(async () => {
    // Clean up test directory
    if (await pathExists(testDir)) {
      await removeDir(testDir, { recursive: true, force: true });
    }
  });

  describe('Migration Registration', () => {
    test('should register a migration script', () => {
      const migration = createMigration(
        'test-migration',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0'),
        'Test migration',
        async (template) => template
      );

      migrationEngine.registerMigration('test-template', migration);

      const migrations = migrationEngine.getMigrations('test-template');
      expect(migrations).toHaveLength(1);
      expect(migrations[0].id).toBe('test-migration');
    });

    test('should sort migrations by from version', () => {
      const migration1 = createMigration(
        'migration-1',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0'),
        'Migration 1',
        async (template) => template
      );

      const migration2 = createMigration(
        'migration-2',
        versionManager.parseVersion('1.1.0'),
        versionManager.parseVersion('1.2.0'),
        'Migration 2',
        async (template) => template
      );

      // Register in reverse order
      migrationEngine.registerMigration('test-template', migration2);
      migrationEngine.registerMigration('test-template', migration1);

      const migrations = migrationEngine.getMigrations('test-template');
      expect(migrations[0].id).toBe('migration-1');
      expect(migrations[1].id).toBe('migration-2');
    });
  });

  describe('Migration Path Finding', () => {
    beforeEach(() => {
      // Register a chain of migrations: 1.0.0 -> 1.1.0 -> 1.2.0 -> 2.0.0
      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'v1.0-to-v1.1',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('1.1.0'),
          'Migrate from 1.0.0 to 1.1.0',
          async (template) => template,
          { estimatedDuration: 10 }
        )
      );

      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'v1.1-to-v1.2',
          versionManager.parseVersion('1.1.0'),
          versionManager.parseVersion('1.2.0'),
          'Migrate from 1.1.0 to 1.2.0',
          async (template) => template,
          { estimatedDuration: 15 }
        )
      );

      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'v1.2-to-v2.0',
          versionManager.parseVersion('1.2.0'),
          versionManager.parseVersion('2.0.0'),
          'Migrate from 1.2.0 to 2.0.0',
          async (template) => template,
          { estimatedDuration: 20 }
        )
      );
    });

    test('should find single-step migration path', () => {
      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0')
      );

      expect(path).not.toBeNull();
      expect(path!.steps).toHaveLength(1);
      expect(path!.steps[0].id).toBe('v1.0-to-v1.1');
    });

    test('should find multi-step migration path', () => {
      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('2.0.0')
      );

      expect(path).not.toBeNull();
      expect(path!.steps).toHaveLength(3);
      expect(path!.steps[0].id).toBe('v1.0-to-v1.1');
      expect(path!.steps[1].id).toBe('v1.1-to-v1.2');
      expect(path!.steps[2].id).toBe('v1.2-to-v2.0');
    });

    test('should calculate total duration', () => {
      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('2.0.0')
      );

      expect(path).not.toBeNull();
      expect(path!.totalDuration).toBe(45); // 10 + 15 + 20
    });

    test('should return null if no path exists', () => {
      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('2.0.0'),
        versionManager.parseVersion('3.0.0')
      );

      expect(path).toBeNull();
    });

    test('returns null when migrations create a cycle', () => {
      migrationEngine.clearMigrations();

      migrationEngine.registerMigration(
        'cyclic-template',
        createMigration(
          'forward',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('1.1.0'),
          'Forward step',
          async (template) => template
        )
      );

      migrationEngine.registerMigration(
        'cyclic-template',
        createMigration(
          'backward',
          versionManager.parseVersion('1.1.0'),
          versionManager.parseVersion('1.0.0'),
          'Backward step',
          async (template) => template
        )
      );

      const path = migrationEngine.findMigrationPath(
        'cyclic-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.2.0')
      );

      expect(path).toBeNull();
    });

    test('should return null for unknown template', () => {
      const path = migrationEngine.findMigrationPath(
        'unknown-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('2.0.0')
      );

      expect(path).toBeNull();
    });

    test('should track reversibility', () => {
      migrationEngine.clearMigrations();

      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'reversible',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('1.1.0'),
          'Reversible migration',
          async (template) => template,
          { rollbackFn: async (template) => template }
        )
      );

      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'non-reversible',
          versionManager.parseVersion('1.1.0'),
          versionManager.parseVersion('1.2.0'),
          'Non-reversible migration',
          async (template) => template
        )
      );

      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.2.0')
      );

      expect(path).not.toBeNull();
      expect(path!.reversible).toBe(false);
    });
  });

  describe('Migration Execution', () => {
    test('should execute a simple migration', async () => {
      const migration = createMigration(
        'add-field',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0'),
        'Add new field',
        async (template) => ({
          ...template,
          newField: 'value',
        })
      );

      migrationEngine.registerMigration('test-template', migration);

      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0')
      );

      const template = { name: 'test' };
      const result = await migrationEngine.migrate('test-template', template, path!, testDir);

      const success = expectSuccessfulResult(result);
      expect(success.migratedTemplate).toEqual({
        name: 'test',
        newField: 'value',
      });
    });

    test('should execute multi-step migration', async () => {
      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'step-1',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('1.1.0'),
          'Step 1',
          async (template) => ({
            ...template,
            step1: true,
          })
        )
      );

      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'step-2',
          versionManager.parseVersion('1.1.0'),
          versionManager.parseVersion('1.2.0'),
          'Step 2',
          async (template) => ({
            ...template,
            step2: true,
          })
        )
      );

      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.2.0')
      );

      const template = { name: 'test' };
      const result = await migrationEngine.migrate('test-template', template, path!, testDir);

      const success = expectSuccessfulResult(result);
      expect(success.migratedTemplate).toEqual({
        name: 'test',
        step1: true,
        step2: true,
      });
    });

    test('should create backup when enabled', async () => {
      const migration = createMigration(
        'test',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0'),
        'Test migration',
        async (template) => template
      );

      migrationEngine.registerMigration('test-template', migration);

      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0')
      );

      const template = { name: 'test' };
      const result = await migrationEngine.migrate('test-template', template, path!, testDir);

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(await pathExists(result.backupPath!)).toBe(true);

      // Verify backup content
      const backupContent = await fs.readFile(result.backupPath!, 'utf-8');
      expect(JSON.parse(backupContent)).toEqual(template);
    });

    test('should handle migration errors in strict mode', async () => {
      const migration = createMigration(
        'failing-migration',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0'),
        'Failing migration',
        async () => {
          throw new Error('Migration failed');
        }
      );

      migrationEngine.registerMigration('test-template', migration);

      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0')
      );

      const template = { name: 'test' };

      await expect(
        migrationEngine.migrate('test-template', template, path!, testDir)
      ).rejects.toThrow(MigrationError);
    });

    test('should collect errors in non-strict mode', async () => {
      const nonStrictEngine = new MigrationEngine(versionManager, { strict: false });

      const migration = createMigration(
        'failing-migration',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0'),
        'Failing migration',
        async () => {
          throw new Error('Migration failed');
        }
      );

      nonStrictEngine.registerMigration('test-template', migration);

      const path = nonStrictEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0')
      );

      const template = { name: 'test' };
      const result = await nonStrictEngine.migrate('test-template', template, path!, testDir);

      const failure = expectFailedResult(result);
      expect(failure.errors.length).toBeGreaterThan(0);
    });

    test('should record warnings from successful steps', async () => {
      migrationEngine.registerMigration('test-template', {
        id: 'warn-step',
        fromVersion: versionManager.parseVersion('1.0.0'),
        toVersion: versionManager.parseVersion('1.1.0'),
        description: 'Warns but succeeds',
        migrate: async () => ({
          success: true,
          migratedTemplate: { migrated: true },
          warnings: ['manual review recommended'],
          executionTime: 5,
        }),
        reversible: false,
      });

      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0')
      );

      const result = await migrationEngine.migrate(
        'test-template',
        { name: 'warn' },
        path!,
        testDir
      );

      expect(result.warnings).toEqual(['manual review recommended']);
      const success = expectSuccessfulResult(result);
      expect(success.migratedTemplate).toEqual({ migrated: true });
    });

    test('throws in strict mode when step reports failure without throwing', async () => {
      const failingMigration: MigrationScript = {
        id: 'soft-failure',
        fromVersion: versionManager.parseVersion('1.0.0'),
        toVersion: versionManager.parseVersion('1.1.0'),
        description: 'Returns failure',
        migrate: async () => ({
          success: false,
          errors: ['validation failed'],
          executionTime: 2,
        }),
        reversible: false,
      };

      migrationEngine.registerMigration('test-template', failingMigration);

      const path = migrationEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0')
      );

      await expect(
        migrationEngine.migrate('test-template', { id: 'x' }, path!, testDir)
      ).rejects.toThrow(MigrationError);
    });

    test('collects soft failures in non-strict mode', async () => {
      const nonStrictEngine = new MigrationEngine(versionManager, { strict: false });
      const failingMigration: MigrationScript = {
        id: 'soft-failure-nonstrict',
        fromVersion: versionManager.parseVersion('1.0.0'),
        toVersion: versionManager.parseVersion('1.1.0'),
        description: 'Returns failure but continues',
        migrate: async () => ({
          success: false,
          errors: ['step incomplete'],
          warnings: ['follow-up required'],
          executionTime: 1,
        }),
        reversible: false,
      };

      nonStrictEngine.registerMigration('test-template', failingMigration);

      const path = nonStrictEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0')
      );

      const result = await nonStrictEngine.migrate('test-template', { id: 'y' }, path!, testDir);

      const failure = expectFailedResult(result);
      expect(failure.errors).toEqual([
        'Migration step 1 (soft-failure-nonstrict) failed: step incomplete',
      ]);
      expect(failure.warnings).toEqual(['follow-up required']);
    });

    test('skips backup creation when disabled', async () => {
      const noBackupEngine = new MigrationEngine(versionManager, { createBackups: false });
      noBackupEngine.registerMigration(
        'test-template',
        createMigration(
          'noop',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('1.1.0'),
          'No-op',
          async (template) => template
        )
      );

      const path = noBackupEngine.findMigrationPath(
        'test-template',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0')
      );

      const result = await noBackupEngine.migrate(
        'test-template',
        { name: 'no-backup' },
        path!,
        testDir
      );

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeUndefined();
    });

    test('wraps unexpected backup failures in migration error', async () => {
      const writeSpy = jest.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('denied'));

      try {
        migrationEngine.registerMigration(
          'test-template',
          createMigration(
            'simple',
            versionManager.parseVersion('1.0.0'),
            versionManager.parseVersion('1.1.0'),
            'Simple migration',
            async (template) => template
          )
        );

        const path = migrationEngine.findMigrationPath(
          'test-template',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('1.1.0')
        );

        await expect(
          migrationEngine.migrate('test-template', { name: 'fail-backup' }, path!, testDir)
        ).rejects.toThrow(/Migration failed: denied/);
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  describe('Migration Rollback', () => {
    test('should rollback from backup', async () => {
      // Create a backup file
      const template = { name: 'original', version: '1.0.0' };
      const backupPath = path.join(testDir, 'test-backup.json');
      await fs.writeFile(backupPath, JSON.stringify(template), 'utf-8');

      const result = await migrationEngine.rollback('test-template', backupPath);

      expect(result.success).toBe(true);
      expect(result.template).toEqual(template);
    });

    test('should handle rollback errors', async () => {
      const result = await migrationEngine.rollback('test-template', '/nonexistent/path.json');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Migration Validation', () => {
    test('should validate valid migration', () => {
      const migration = createMigration(
        'valid',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.1.0'),
        'Valid migration',
        async (template) => template,
        { rollbackFn: async (template) => template }
      );

      const validation = migrationEngine.validateMigration(migration);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    test('should reject migration with same from and to version', () => {
      const migration = createMigration(
        'invalid',
        versionManager.parseVersion('1.0.0'),
        versionManager.parseVersion('1.0.0'),
        'Invalid migration',
        async (template) => template
      );

      const validation = migrationEngine.validateMigration(migration);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('must be different'))).toBe(true);
    });

    test('should reject downgrade migration', () => {
      const migration = createMigration(
        'downgrade',
        versionManager.parseVersion('2.0.0'),
        versionManager.parseVersion('1.0.0'),
        'Downgrade migration',
        async (template) => template
      );

      const validation = migrationEngine.validateMigration(migration);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('no downgrades'))).toBe(true);
    });

    test('should reject reversible migration without rollback', () => {
      const migration: MigrationScript = {
        id: 'missing-rollback',
        fromVersion: versionManager.parseVersion('1.0.0'),
        toVersion: versionManager.parseVersion('1.1.0'),
        description: 'Missing rollback',
        migrate: async (template) => ({
          success: true,
          migratedTemplate: template,
          executionTime: 0,
        }),
        reversible: true,
      };

      const validation = migrationEngine.validateMigration(migration);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('rollback function'))).toBe(true);
    });
  });

  test('autoMigrate throws when no versions registered', async () => {
    const template = { name: 'test', version: '0.1.0' };

    await expect(
      migrationEngine.autoMigrate(
        'missing-template',
        template,
        versionManager.parseVersion('0.1.0'),
        testDir
      )
    ).rejects.toThrow(/No versions registered/);
  });

  describe('Auto-Migration', () => {
    beforeEach(() => {
      // Register versions
      versionManager.registerVersion({
        templateId: 'test-template',
        version: versionManager.parseVersion('1.0.0'),
        releaseDate: '2025-01-01T00:00:00Z',
      });

      versionManager.registerVersion({
        templateId: 'test-template',
        version: versionManager.parseVersion('2.0.0'),
        releaseDate: '2025-01-02T00:00:00Z',
      });

      // Register migrations
      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'auto-migrate',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('2.0.0'),
          'Auto migration',
          async (template) => ({
            ...template,
            version: '2.0.0',
          })
        )
      );
    });

    test('should auto-migrate to latest version', async () => {
      const template = { name: 'test', version: '1.0.0' };
      const result = await migrationEngine.autoMigrate(
        'test-template',
        template,
        versionManager.parseVersion('1.0.0'),
        testDir
      );

      const success = expectSuccessfulResult(result);
      expect(success.migratedTemplate.version).toBe('2.0.0');
    });

    test('should skip migration if already at latest version', async () => {
      const template = { name: 'test', version: '2.0.0' };
      const result = await migrationEngine.autoMigrate(
        'test-template',
        template,
        versionManager.parseVersion('2.0.0'),
        testDir
      );

      expect(result.success).toBe(true);
      expect(result.warnings!.some((w) => w.includes('already at the latest version'))).toBe(true);
    });

    test('should fail if no migration path exists', async () => {
      migrationEngine.clearMigrations();

      const template = { name: 'test', version: '1.0.0' };

      await expect(
        migrationEngine.autoMigrate(
          'test-template',
          template,
          versionManager.parseVersion('1.0.0'),
          testDir
        )
      ).rejects.toThrow(MigrationError);
    });
  });

  describe('Migration Statistics', () => {
    beforeEach(() => {
      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'migration-1',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('1.1.0'),
          'Migration 1',
          async (template) => template,
          { rollbackFn: async (template) => template, estimatedDuration: 10 }
        )
      );

      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'migration-2',
          versionManager.parseVersion('1.1.0'),
          versionManager.parseVersion('1.2.0'),
          'Migration 2',
          async (template) => template,
          { estimatedDuration: 20 }
        )
      );
    });

    test('should calculate migration statistics', () => {
      const stats = migrationEngine.getStatistics('test-template');

      expect(stats.totalMigrations).toBe(2);
      expect(stats.reversibleCount).toBe(1);
      expect(stats.averageDuration).toBe(15); // (10 + 20) / 2
      expect(stats.versionCoverage).toHaveLength(2);
    });

    test('should handle empty statistics', () => {
      const stats = migrationEngine.getStatistics('unknown-template');

      expect(stats.totalMigrations).toBe(0);
      expect(stats.reversibleCount).toBe(0);
      expect(stats.averageDuration).toBe(0);
      expect(stats.versionCoverage).toHaveLength(0);
    });
  });

  describe('Can Migrate Check', () => {
    test('should check if migration is possible', () => {
      migrationEngine.registerMigration(
        'test-template',
        createMigration(
          'test',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('1.1.0'),
          'Test migration',
          async (template) => template
        )
      );

      expect(
        migrationEngine.canMigrate(
          'test-template',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('1.1.0')
        )
      ).toBe(true);

      expect(
        migrationEngine.canMigrate(
          'test-template',
          versionManager.parseVersion('1.0.0'),
          versionManager.parseVersion('2.0.0')
        )
      ).toBe(false);
    });
  });
});
