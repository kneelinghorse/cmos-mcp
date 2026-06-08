/**
 * Type definitions for the Template Versioning system.
 * Implements SemVer support and migration capabilities for mission B3.4.
 */

/**
 * Semantic version components (X.Y.Z format)
 */
export interface SemanticVersion {
  /** Major version - incremented for breaking changes */
  major: number;

  /** Minor version - incremented for backward-compatible features */
  minor: number;

  /** Patch version - incremented for backward-compatible bug fixes */
  patch: number;

  /** Optional pre-release identifier (e.g., 'alpha', 'beta', 'rc.1') */
  prerelease?: string;

  /** Optional build metadata */
  buildMetadata?: string;
}

/**
 * Version comparison result
 */
export enum VersionComparison {
  LESS_THAN = -1,
  EQUAL = 0,
  GREATER_THAN = 1,
}

/**
 * SemVer range specification for compatibility checks
 */
export interface VersionRange {
  /** Minimum version (inclusive) */
  min?: SemanticVersion;

  /** Maximum version (exclusive) */
  max?: SemanticVersion;

  /** Exact version match (overrides min/max) */
  exact?: SemanticVersion;

  /** Range expression (e.g., '^1.2.0', '~1.2.0', '>=1.0.0 <2.0.0') */
  expression?: string;
}

/**
 * Template version metadata
 */
export interface TemplateVersion {
  /** The template identifier */
  templateId: string;

  /** Semantic version of this template */
  version: SemanticVersion;

  /** Human-readable changelog entry for this version */
  changelog?: string;

  /** Compatible versions (range specification) */
  compatibleWith?: VersionRange;

  /** Required dependency versions */
  dependencies?: {
    [templateId: string]: VersionRange;
  };

  /** Migration script path (if upgrading from previous version) */
  migrationFrom?: {
    [sourceVersion: string]: string; // version string -> migration script path
  };

  /** ISO 8601 timestamp of when this version was released */
  releaseDate: string;

  /** Deprecation notice if this version is deprecated */
  deprecated?: {
    message: string;
    replacedBy?: string; // suggested replacement version
  };
}

/**
 * Version compatibility check result
 */
export interface CompatibilityCheckResult {
  /** Whether versions are compatible */
  compatible: boolean;

  /** Detailed reason if not compatible */
  reason?: string;

  /** Suggested upgrade path if incompatible */
  suggestedUpgrade?: {
    from: string;
    to: string;
    migrationRequired: boolean;
  };
}

export type TemplateData = Record<string, unknown>;

/**
 * Migration script metadata
 */
export interface MigrationScript {
  /** Unique identifier for this migration */
  id: string;

  /** Source version (what it migrates from) */
  fromVersion: SemanticVersion;

  /** Target version (what it migrates to) */
  toVersion: SemanticVersion;

  /** Description of what this migration does */
  description: string;

  /** Migration function */
  migrate: (template: TemplateData) => Promise<MigrationResult>;

  /** Optional rollback function */
  rollback?: (template: TemplateData) => Promise<TemplateData>;

  /** Estimated time to complete (in seconds) */
  estimatedDuration?: number;

  /** Whether this migration is reversible */
  reversible: boolean;
}

/**
 * Shared result fields for migration operations
 */
interface MigrationResultBase {
  /** Warnings (non-fatal issues) */
  warnings?: string[];

  /** Execution time in milliseconds */
  executionTime: number;

  /** Backup path (for rollback) */
  backupPath?: string;
}

/**
 * Successful migration result
 */
export interface SuccessfulMigrationResult extends MigrationResultBase {
  /** Whether migration succeeded */
  success: true;

  /** The migrated template (always present when success === true) */
  migratedTemplate: TemplateData;
}

/**
 * Failed migration result
 */
export interface FailedMigrationResult extends MigrationResultBase {
  /** Whether migration succeeded */
  success: false;

  /** Errors encountered during migration */
  errors: string[];

  /** Partial template payload if the migration produced one before failing */
  migratedTemplate?: TemplateData;
}

/**
 * Result of a migration operation
 */
export type MigrationResult = SuccessfulMigrationResult | FailedMigrationResult;

/**
 * Narrow a migration result to the successful variant
 */
export function isSuccessfulMigrationResult(
  result: MigrationResult
): result is SuccessfulMigrationResult {
  return result.success;
}

/**
 * Migration path from one version to another
 */
export interface MigrationPath {
  /** Source version */
  from: SemanticVersion;

  /** Target version */
  to: SemanticVersion;

  /** Ordered list of migration steps */
  steps: MigrationScript[];

  /** Whether all migrations in path are reversible */
  reversible: boolean;

  /** Total estimated duration (sum of all steps) */
  totalDuration: number;
}

/**
 * Version registry entry
 */
export interface VersionRegistryEntry {
  /** Template identifier */
  templateId: string;

  /** All available versions for this template */
  versions: TemplateVersion[];

  /** The latest stable version */
  latestStable: SemanticVersion;

  /** The latest version (including pre-releases) */
  latest: SemanticVersion;
}

/**
 * Version conflict in a template pack combination
 */
export interface VersionConflict {
  /** Template identifier with conflict */
  templateId: string;

  /** Conflicting version requirements */
  conflicts: Array<{
    requiredBy: string; // Template ID that requires this version
    versionRange: VersionRange;
  }>;

  /** Suggested resolution */
  resolution?: {
    version: string;
    reason: string;
  };
}

/**
 * Result of a version resolution operation (for pack combinations)
 */
export interface VersionResolutionResult {
  /** Whether resolution was successful */
  success: boolean;

  /** Resolved versions for each template */
  resolvedVersions?: {
    [templateId: string]: SemanticVersion;
  };

  /** Any conflicts that couldn't be resolved */
  conflicts?: VersionConflict[];

  /** Warnings about version choices */
  warnings?: string[];
}

/**
 * Options for version manager operations
 */
export interface VersionManagerOptions {
  /** Whether to allow pre-release versions */
  allowPrerelease?: boolean;

  /** Whether to automatically migrate when loading templates */
  autoMigrate?: boolean;

  /** Strict mode (fail on warnings) */
  strict?: boolean;

  /** Whether to create backups before migrations */
  createBackups?: boolean;
}

/**
 * Error types for versioning operations
 */
export class VersionError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'VersionError';
  }
}

export class IncompatibleVersionError extends VersionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'INCOMPATIBLE_VERSION', details);
    this.name = 'IncompatibleVersionError';
  }
}

export class MigrationError extends VersionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'MIGRATION_FAILED', details);
    this.name = 'MigrationError';
  }
}

export class InvalidVersionError extends VersionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'INVALID_VERSION', details);
    this.name = 'InvalidVersionError';
  }
}
