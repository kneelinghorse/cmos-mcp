/**
 * MCP Tool: version_template
 *
 * Exposes version management and migration functionality as MCP tools
 * for use in Claude Desktop and other MCP-compatible environments.
 *
 * Implements SemVer support and migration capabilities from B3.4.
 */

import { VersionManager } from '../versioning/version-manager';
import { MigrationEngine } from '../versioning/migration-engine';
import { TemplateVersion, VersionManagerOptions } from '../versioning/types';

// Global instances (in production, these would be injected)
let versionManager: VersionManager;
let migrationEngine: MigrationEngine;

/**
 * Initialize the versioning system
 */
function initializeVersioning(options: VersionManagerOptions = {}): void {
  if (!versionManager) {
    versionManager = new VersionManager(options);
    migrationEngine = new MigrationEngine(versionManager, options);
  }
}

// ============================================================================
// Tool 1: Check Version Compatibility
// ============================================================================

export interface CheckVersionCompatibilityParams {
  /** Template ID to check */
  templateId: string;

  /** First version to compare */
  version1: string;

  /** Second version to compare */
  version2: string;

  /** Optional version manager options */
  options?: VersionManagerOptions;
}

export interface CheckVersionCompatibilityResult {
  success: boolean;
  compatible: boolean;
  reason?: string;
  suggestedUpgrade?: {
    from: string;
    to: string;
    migrationRequired: boolean;
  };
  message: string;
}

export async function checkVersionCompatibility(
  params: CheckVersionCompatibilityParams
): Promise<CheckVersionCompatibilityResult> {
  try {
    initializeVersioning(params.options);

    // Get the two versions from the registry
    const templateVersion1 = versionManager.getVersion(params.templateId, params.version1);
    const templateVersion2 = versionManager.getVersion(params.templateId, params.version2);

    if (!templateVersion1) {
      throw new Error(`Version ${params.version1} not found for template ${params.templateId}`);
    }

    if (!templateVersion2) {
      throw new Error(`Version ${params.version2} not found for template ${params.templateId}`);
    }

    const result = versionManager.checkCompatibility(templateVersion1, templateVersion2);

    return {
      success: true,
      compatible: result.compatible,
      reason: result.reason,
      suggestedUpgrade: result.suggestedUpgrade,
      message: result.compatible
        ? `Versions ${params.version1} and ${params.version2} are compatible`
        : `Versions ${params.version1} and ${params.version2} are NOT compatible: ${result.reason}`,
    };
  } catch (error) {
    return {
      success: false,
      compatible: false,
      message: `Compatibility check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const getVersionCompatibilityToolDefinition = {
  name: 'get_version_compatibility',
  description:
    'Check if two template versions are compatible with each other. Returns compatibility status and suggested upgrade path if incompatible.',
  inputSchema: {
    type: 'object',
    properties: {
      templateId: {
        type: 'string',
        description: 'The template identifier',
      },
      version1: {
        type: 'string',
        description: 'First version to compare (SemVer format: X.Y.Z)',
      },
      version2: {
        type: 'string',
        description: 'Second version to compare (SemVer format: X.Y.Z)',
      },
    },
    required: ['templateId', 'version1', 'version2'],
  },
} as const;

export const checkVersionCompatibilityToolDefinitionDeprecated = {
  ...getVersionCompatibilityToolDefinition,
  name: 'check_version_compatibility',
  description:
    '[DEPRECATED] Use get_version_compatibility instead. Returns the same compatibility assessment.',
} as const;

// ============================================================================
// Tool 2: Find Migration Path
// ============================================================================

export interface FindMigrationPathParams {
  /** Template ID */
  templateId: string;

  /** Source version */
  fromVersion: string;

  /** Target version */
  toVersion: string;

  /** Optional version manager options */
  options?: VersionManagerOptions;
}

export interface FindMigrationPathResult {
  success: boolean;
  pathFound: boolean;
  path?: {
    from: string;
    to: string;
    steps: Array<{
      id: string;
      fromVersion: string;
      toVersion: string;
      description: string;
      estimatedDuration?: number;
      reversible: boolean;
    }>;
    reversible: boolean;
    totalDuration: number;
  };
  message: string;
}

export async function findMigrationPath(
  params: FindMigrationPathParams
): Promise<FindMigrationPathResult> {
  try {
    initializeVersioning(params.options);

    const fromVersion = versionManager.parseVersion(params.fromVersion);
    const toVersion = versionManager.parseVersion(params.toVersion);

    const path = migrationEngine.findMigrationPath(params.templateId, fromVersion, toVersion);

    if (!path) {
      return {
        success: true,
        pathFound: false,
        message: `No migration path found from ${params.fromVersion} to ${params.toVersion}`,
      };
    }

    return {
      success: true,
      pathFound: true,
      path: {
        from: versionManager.versionToString(path.from),
        to: versionManager.versionToString(path.to),
        steps: path.steps.map((step) => ({
          id: step.id,
          fromVersion: versionManager.versionToString(step.fromVersion),
          toVersion: versionManager.versionToString(step.toVersion),
          description: step.description,
          estimatedDuration: step.estimatedDuration,
          reversible: step.reversible,
        })),
        reversible: path.reversible,
        totalDuration: path.totalDuration,
      },
      message: `Migration path found with ${path.steps.length} step(s), estimated duration: ${path.totalDuration}s`,
    };
  } catch (error) {
    return {
      success: false,
      pathFound: false,
      message: `Failed to find migration path: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const getMigrationPathToolDefinition = {
  name: 'get_migration_path',
  description:
    'Find a migration path from one template version to another. Returns the sequence of migration steps required.',
  inputSchema: {
    type: 'object',
    properties: {
      templateId: {
        type: 'string',
        description: 'The template identifier',
      },
      fromVersion: {
        type: 'string',
        description: 'Source version (SemVer format: X.Y.Z)',
      },
      toVersion: {
        type: 'string',
        description: 'Target version (SemVer format: X.Y.Z)',
      },
    },
    required: ['templateId', 'fromVersion', 'toVersion'],
  },
} as const;

export const findMigrationPathToolDefinitionDeprecated = {
  ...getMigrationPathToolDefinition,
  name: 'find_migration_path',
  description:
    '[DEPRECATED] Use get_migration_path instead. Produces the same ordered migration plan.',
} as const;

// ============================================================================
// Tool 3: Register Template Version
// ============================================================================

export interface RegisterTemplateVersionParams {
  /** Template ID */
  templateId: string;

  /** Version string (SemVer format) */
  version: string;

  /** Changelog for this version */
  changelog?: string;

  /** Compatible version range (e.g., '^1.0.0', '~1.2.0') */
  compatibleWith?: string;

  /** Release date (ISO 8601) */
  releaseDate?: string;

  /** Optional version manager options */
  options?: VersionManagerOptions;
}

export interface RegisterTemplateVersionResult {
  success: boolean;
  version?: {
    templateId: string;
    version: string;
    releaseDate: string;
  };
  message: string;
}

export async function registerTemplateVersion(
  params: RegisterTemplateVersionParams
): Promise<RegisterTemplateVersionResult> {
  try {
    initializeVersioning(params.options);

    const version = versionManager.parseVersion(params.version);
    const releaseDate = params.releaseDate || new Date().toISOString();

    const templateVersion: TemplateVersion = {
      templateId: params.templateId,
      version,
      changelog: params.changelog,
      compatibleWith: params.compatibleWith ? { expression: params.compatibleWith } : undefined,
      releaseDate,
    };

    // Validate the version
    const validation = versionManager.validateVersion(templateVersion);
    if (!validation.valid) {
      throw new Error(`Invalid template version: ${validation.errors.join(', ')}`);
    }

    // Register the version
    versionManager.registerVersion(templateVersion);

    return {
      success: true,
      version: {
        templateId: params.templateId,
        version: params.version,
        releaseDate,
      },
      message: `Template version ${params.templateId}@${params.version} registered successfully`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to register template version: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const createTemplateVersionToolDefinition = {
  name: 'create_template_version',
  description:
    'Register a new template version in the version registry. Validates the version and adds it to the registry.',
  inputSchema: {
    type: 'object',
    properties: {
      templateId: {
        type: 'string',
        description: 'The template identifier',
      },
      version: {
        type: 'string',
        description: 'Version string in SemVer format (X.Y.Z)',
      },
      changelog: {
        type: 'string',
        description: 'Human-readable changelog entry for this version (optional)',
      },
      compatibleWith: {
        type: 'string',
        description:
          "Compatible version range (e.g., '^1.0.0' for compatible with 1.x, '~1.2.0' for 1.2.x) (optional)",
      },
      releaseDate: {
        type: 'string',
        description: 'ISO 8601 release date (optional, defaults to now)',
      },
    },
    required: ['templateId', 'version'],
  },
} as const;

export const registerTemplateVersionToolDefinitionDeprecated = {
  ...createTemplateVersionToolDefinition,
  name: 'register_template_version',
  description:
    '[DEPRECATED] Use create_template_version instead. Registers the same version metadata and changelog information.',
} as const;

// ============================================================================
// Tool 4: Get Latest Version
// ============================================================================

export interface GetLatestVersionParams {
  /** Template ID */
  templateId: string;

  /** Include pre-release versions */
  includePrerelease?: boolean;

  /** Optional version manager options */
  options?: VersionManagerOptions;
}

export interface GetLatestVersionResult {
  success: boolean;
  version?: {
    templateId: string;
    version: string;
    releaseDate: string;
    deprecated?: boolean;
    deprecationMessage?: string;
  };
  message: string;
}

export async function getLatestVersion(
  params: GetLatestVersionParams
): Promise<GetLatestVersionResult> {
  try {
    initializeVersioning(params.options);

    const latest = versionManager.getLatestVersion(params.templateId, params.includePrerelease);

    if (!latest) {
      return {
        success: true,
        message: `No versions found for template ${params.templateId}`,
      };
    }

    return {
      success: true,
      version: {
        templateId: params.templateId,
        version: versionManager.versionToString(latest.version),
        releaseDate: latest.releaseDate,
        deprecated: latest.deprecated !== undefined,
        deprecationMessage: latest.deprecated?.message,
      },
      message: `Latest version for ${params.templateId}: ${versionManager.versionToString(latest.version)}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get latest version: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const getLatestVersionToolDefinition = {
  name: 'get_latest_version',
  description:
    'Get the latest version of a template from the registry. Can optionally include pre-release versions.',
  inputSchema: {
    type: 'object',
    properties: {
      templateId: {
        type: 'string',
        description: 'The template identifier',
      },
      includePrerelease: {
        type: 'boolean',
        description: 'Include pre-release versions (e.g., 1.0.0-alpha) (optional)',
      },
    },
    required: ['templateId'],
  },
};

// ============================================================================
// Tool 5: Compare Versions
// ============================================================================

export interface CompareVersionsParams {
  /** First version */
  version1: string;

  /** Second version */
  version2: string;
}

export interface CompareVersionsResult {
  success: boolean;
  comparison?: 'less_than' | 'equal' | 'greater_than';
  message: string;
}

export async function compareVersions(
  params: CompareVersionsParams
): Promise<CompareVersionsResult> {
  try {
    initializeVersioning();

    const v1 = versionManager.parseVersion(params.version1);
    const v2 = versionManager.parseVersion(params.version2);

    const result = versionManager.compareVersions(v1, v2);

    const comparisonMap = {
      [-1]: 'less_than' as const,
      [0]: 'equal' as const,
      [1]: 'greater_than' as const,
    };

    return {
      success: true,
      comparison: comparisonMap[result],
      message: `${params.version1} is ${comparisonMap[result].replace('_', ' ')} ${params.version2}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to compare versions: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const getVersionComparisonToolDefinition = {
  name: 'get_version_comparison',
  description:
    'Compare two semantic versions. Returns whether the first version is less than, equal to, or greater than the second.',
  inputSchema: {
    type: 'object',
    properties: {
      version1: {
        type: 'string',
        description: 'First version in SemVer format (X.Y.Z)',
      },
      version2: {
        type: 'string',
        description: 'Second version in SemVer format (X.Y.Z)',
      },
    },
    required: ['version1', 'version2'],
  },
} as const;

export const compareVersionsToolDefinitionDeprecated = {
  ...getVersionComparisonToolDefinition,
  name: 'compare_versions',
  description:
    '[DEPRECATED] Use get_version_comparison instead. Provides the same ordering result.',
} as const;

// ============================================================================
// Export all tool definitions for MCP registration
// ============================================================================

export const versioningTools = [
  getVersionCompatibilityToolDefinition,
  getMigrationPathToolDefinition,
  createTemplateVersionToolDefinition,
  getLatestVersionToolDefinition,
  getVersionComparisonToolDefinition,
] as const;

export const versioningToolsDeprecated = [
  checkVersionCompatibilityToolDefinitionDeprecated,
  findMigrationPathToolDefinitionDeprecated,
  registerTemplateVersionToolDefinitionDeprecated,
  compareVersionsToolDefinitionDeprecated,
] as const;
