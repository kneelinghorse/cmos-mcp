/**
 * Migration Engine - Template version migration and upgrade paths
 * Handles transitioning between template versions (B3.4)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  SemanticVersion,
  MigrationScript,
  MigrationResult,
  MigrationPath,
  MigrationError,
  VersionManagerOptions,
  TemplateData,
} from './types';
import { VersionManager } from './version-manager';
import { jsonContent } from '../validation/common';

const MAX_BACKUP_SIZE_BYTES = 2 * 1024 * 1024;

/**
 * Manages migration between template versions
 */
export class MigrationEngine {
  private versionManager: VersionManager;
  private migrations: Map<string, MigrationScript[]> = new Map(); // templateId -> migrations
  private options: VersionManagerOptions;

  constructor(versionManager: VersionManager, options: VersionManagerOptions = {}) {
    this.versionManager = versionManager;
    this.options = {
      createBackups: options.createBackups ?? true,
      autoMigrate: options.autoMigrate ?? false,
      strict: options.strict ?? true,
    };
  }

  /**
   * Register a migration script
   */
  registerMigration(templateId: string, migration: MigrationScript): void {
    const migrations = this.migrations.get(templateId) || [];
    migrations.push(migration);

    // Sort by from version (oldest to newest)
    migrations.sort((a, b) => this.versionManager.compareVersions(a.fromVersion, b.fromVersion));

    this.migrations.set(templateId, migrations);
  }

  /**
   * Find a migration path from one version to another
   */
  findMigrationPath(
    templateId: string,
    fromVersion: SemanticVersion,
    toVersion: SemanticVersion
  ): MigrationPath | null {
    const migrations = this.migrations.get(templateId);
    if (!migrations) {
      return null;
    }

    // Use breadth-first search to find shortest migration path
    const path: MigrationScript[] = [];
    let currentVersion = fromVersion;
    const visited = new Set<string>();

    while (this.versionManager.compareVersions(currentVersion, toVersion) !== 0) {
      const versionKey = this.versionManager.versionToString(currentVersion);

      if (visited.has(versionKey)) {
        // Circular dependency detected
        return null;
      }
      visited.add(versionKey);

      // Find migration from current version
      const nextMigration = migrations.find(
        (m) => this.versionManager.compareVersions(m.fromVersion, currentVersion) === 0
      );

      if (!nextMigration) {
        // No migration found from this version
        return null;
      }

      path.push(nextMigration);
      currentVersion = nextMigration.toVersion;

      // Check if we've reached the target version
      if (this.versionManager.compareVersions(currentVersion, toVersion) === 0) {
        break;
      }

      // Check if we've overshot the target (shouldn't happen with proper migrations)
      if (this.versionManager.compareVersions(currentVersion, toVersion) > 0) {
        return null;
      }
    }

    // Calculate total duration and reversibility
    const totalDuration = path.reduce(
      (sum, migration) => sum + (migration.estimatedDuration || 0),
      0
    );
    const reversible = path.every((migration) => migration.reversible);

    return {
      from: fromVersion,
      to: toVersion,
      steps: path,
      reversible,
      totalDuration,
    };
  }

  /**
   * Execute a migration path
   */
  async migrate(
    templateId: string,
    template: TemplateData,
    migrationPath: MigrationPath,
    backupDir?: string
  ): Promise<MigrationResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];
    let currentTemplate: TemplateData = template;
    let backupPath: string | undefined;

    try {
      // Create backup if enabled
      if (this.options.createBackups && backupDir) {
        backupPath = await this.createBackup(templateId, template, backupDir);
      }

      // Execute each migration step
      for (let i = 0; i < migrationPath.steps.length; i++) {
        const migration = migrationPath.steps[i];
        const stepStart = Date.now();

        try {
          const result = await migration.migrate(currentTemplate);

          if (!result.success) {
            errors.push(
              `Migration step ${i + 1} (${migration.id}) failed: ${result.errors?.join(', ')}`
            );

            if (this.options.strict) {
              throw new MigrationError(`Migration failed at step ${i + 1}: ${migration.id}`, {
                step: i + 1,
                migration: migration.id,
                errors: result.errors,
              });
            }
          }

          if (result.warnings) {
            warnings.push(...result.warnings);
          }

          currentTemplate = result.migratedTemplate || currentTemplate;

          const stepDuration = Date.now() - stepStart;
          console.error(
            `[INFO] Migration step ${i + 1}/${migrationPath.steps.length} completed in ${stepDuration}ms`
          );
        } catch (error) {
          const errorMsg = `Migration step ${i + 1} (${migration.id}) threw error: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(errorMsg);

          if (this.options.strict) {
            throw new MigrationError(errorMsg, {
              step: i + 1,
              migration: migration.id,
              error,
            });
          }
        }
      }

      const executionTime = Date.now() - startTime;
      const warningList = warnings.length > 0 ? warnings : undefined;

      if (errors.length === 0) {
        return {
          success: true,
          migratedTemplate: currentTemplate,
          warnings: warningList,
          executionTime,
          backupPath,
        };
      }

      return {
        success: false,
        migratedTemplate: currentTemplate,
        errors,
        warnings: warningList,
        executionTime,
        backupPath,
      };
    } catch (error) {
      if (error instanceof MigrationError) {
        throw error;
      }

      throw new MigrationError(
        `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
        { error, backupPath }
      );
    }
  }

  /**
   * Rollback a migration using backup
   */
  async rollback(
    templateId: string,
    backupPath: string
  ): Promise<{ success: boolean; template?: TemplateData; error?: string }> {
    try {
      const backupContent = await fs.readFile(backupPath, 'utf-8');
      const template = jsonContent(backupContent, {
        maxSize: MAX_BACKUP_SIZE_BYTES,
      }) as TemplateData;

      return {
        success: true,
        template,
      };
    } catch (error) {
      return {
        success: false,
        error: `Rollback failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Create a backup of the template before migration
   */
  private async createBackup(
    templateId: string,
    template: TemplateData,
    backupDir: string
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `${templateId}_${timestamp}_backup.json`;
    const backupPath = path.join(backupDir, backupFileName);

    // Ensure backup directory exists
    await fs.mkdir(backupDir, { recursive: true });

    // Write backup
    await fs.writeFile(backupPath, JSON.stringify(template, null, 2), 'utf-8');

    return backupPath;
  }

  /**
   * Get all available migrations for a template
   */
  getMigrations(templateId: string): MigrationScript[] {
    return this.migrations.get(templateId) || [];
  }

  /**
   * Check if a migration path exists between two versions
   */
  canMigrate(
    templateId: string,
    fromVersion: SemanticVersion,
    toVersion: SemanticVersion
  ): boolean {
    const path = this.findMigrationPath(templateId, fromVersion, toVersion);
    return path !== null;
  }

  /**
   * Validate a migration script
   */
  validateMigration(migration: MigrationScript): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check that versions are different
    if (this.versionManager.compareVersions(migration.fromVersion, migration.toVersion) === 0) {
      errors.push('Migration fromVersion and toVersion must be different');
    }

    // Check that toVersion is greater than fromVersion (no downgrades)
    if (this.versionManager.compareVersions(migration.fromVersion, migration.toVersion) > 0) {
      errors.push('Migration toVersion must be greater than fromVersion (no downgrades)');
    }

    // Check that migration function exists
    if (typeof migration.migrate !== 'function') {
      errors.push('Migration must have a migrate function');
    }

    // Check rollback if reversible
    if (migration.reversible && typeof migration.rollback !== 'function') {
      errors.push('Reversible migrations must have a rollback function');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Auto-migrate a template to the latest version
   */
  async autoMigrate(
    templateId: string,
    template: TemplateData,
    currentVersion: SemanticVersion,
    backupDir?: string
  ): Promise<MigrationResult> {
    // Get latest version
    const latestVersion = this.versionManager.getLatestVersion(templateId);
    if (!latestVersion) {
      throw new MigrationError(`No versions registered for template: ${templateId}`);
    }

    // Check if already at latest version
    if (this.versionManager.compareVersions(currentVersion, latestVersion.version) === 0) {
      return {
        success: true,
        migratedTemplate: template,
        executionTime: 0,
        warnings: ['Template is already at the latest version'],
      };
    }

    // Find migration path
    const path = this.findMigrationPath(templateId, currentVersion, latestVersion.version);
    if (!path) {
      throw new MigrationError(
        `No migration path found from ${this.versionManager.versionToString(currentVersion)} to ${this.versionManager.versionToString(latestVersion.version)}`
      );
    }

    // Execute migration
    return this.migrate(templateId, template, path, backupDir);
  }

  /**
   * Get migration statistics
   */
  getStatistics(templateId: string): {
    totalMigrations: number;
    reversibleCount: number;
    averageDuration: number;
    versionCoverage: { from: string; to: string }[];
  } {
    const migrations = this.getMigrations(templateId);

    const totalMigrations = migrations.length;
    const reversibleCount = migrations.filter((m) => m.reversible).length;
    const totalDuration = migrations.reduce((sum, m) => sum + (m.estimatedDuration || 0), 0);
    const averageDuration = totalMigrations > 0 ? totalDuration / totalMigrations : 0;

    const versionCoverage = migrations.map((m) => ({
      from: this.versionManager.versionToString(m.fromVersion),
      to: this.versionManager.versionToString(m.toVersion),
    }));

    return {
      totalMigrations,
      reversibleCount,
      averageDuration,
      versionCoverage,
    };
  }

  /**
   * Clear all registered migrations
   */
  clearMigrations(): void {
    this.migrations.clear();
  }
}

/**
 * Helper to create a simple migration script
 */
export function createMigration(
  id: string,
  fromVersion: SemanticVersion,
  toVersion: SemanticVersion,
  description: string,
  migrateFn: (template: TemplateData) => Promise<TemplateData>,
  options: {
    rollbackFn?: (template: TemplateData) => Promise<TemplateData>;
    estimatedDuration?: number;
  } = {}
): MigrationScript {
  return {
    id,
    fromVersion,
    toVersion,
    description,
    migrate: async (template: TemplateData): Promise<MigrationResult> => {
      const startTime = Date.now();
      try {
        const migratedTemplate = await migrateFn(template);
        return {
          success: true,
          migratedTemplate,
          executionTime: Date.now() - startTime,
        };
      } catch (error) {
        return {
          success: false,
          errors: [error instanceof Error ? error.message : String(error)],
          executionTime: Date.now() - startTime,
        };
      }
    },
    rollback: options.rollbackFn,
    estimatedDuration: options.estimatedDuration,
    reversible: options.rollbackFn !== undefined,
  };
}
