/**
 * Version Manager - SemVer support and compatibility checking
 * Implements semantic versioning for mission templates (B3.4)
 */

import {
  SemanticVersion,
  VersionComparison,
  VersionRange,
  TemplateVersion,
  CompatibilityCheckResult,
  VersionRegistryEntry,
  VersionConflict,
  VersionResolutionResult,
  VersionManagerOptions,
  InvalidVersionError,
} from './types';

/**
 * Manages semantic versioning for mission templates
 */
export class VersionManager {
  private registry: Map<string, VersionRegistryEntry> = new Map();
  private options: VersionManagerOptions;

  constructor(options: VersionManagerOptions = {}) {
    this.options = {
      allowPrerelease: options.allowPrerelease ?? false,
      autoMigrate: options.autoMigrate ?? false,
      strict: options.strict ?? true,
      createBackups: options.createBackups ?? true,
    };
  }

  /**
   * Parse a version string into a SemanticVersion object
   * Supports formats: "1.2.3", "1.2.3-alpha", "1.2.3+build123", "1.2.3-beta.1+build"
   */
  parseVersion(versionString: string): SemanticVersion {
    // SemVer regex pattern
    const semverRegex =
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

    const match = versionString.match(semverRegex);
    if (!match) {
      throw new InvalidVersionError(
        `Invalid version string: ${versionString}. Expected format: X.Y.Z[-prerelease][+build]`
      );
    }

    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      prerelease: match[4],
      buildMetadata: match[5],
    };
  }

  /**
   * Convert a SemanticVersion object to a version string
   */
  versionToString(version: SemanticVersion): string {
    let versionStr = `${version.major}.${version.minor}.${version.patch}`;

    if (version.prerelease) {
      versionStr += `-${version.prerelease}`;
    }

    if (version.buildMetadata) {
      versionStr += `+${version.buildMetadata}`;
    }

    return versionStr;
  }

  /**
   * Compare two semantic versions
   * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
   */
  compareVersions(v1: SemanticVersion, v2: SemanticVersion): VersionComparison {
    // Compare major.minor.patch
    if (v1.major !== v2.major) {
      return v1.major > v2.major ? VersionComparison.GREATER_THAN : VersionComparison.LESS_THAN;
    }
    if (v1.minor !== v2.minor) {
      return v1.minor > v2.minor ? VersionComparison.GREATER_THAN : VersionComparison.LESS_THAN;
    }
    if (v1.patch !== v2.patch) {
      return v1.patch > v2.patch ? VersionComparison.GREATER_THAN : VersionComparison.LESS_THAN;
    }

    // If major.minor.patch are equal, check prerelease
    // According to SemVer: version with prerelease < version without prerelease
    if (!v1.prerelease && !v2.prerelease) {
      return VersionComparison.EQUAL;
    }
    if (!v1.prerelease && v2.prerelease) {
      return VersionComparison.GREATER_THAN;
    }
    if (v1.prerelease && !v2.prerelease) {
      return VersionComparison.LESS_THAN;
    }

    // Both have prerelease - compare them lexicographically
    const prerelease1 = v1.prerelease!.split('.');
    const prerelease2 = v2.prerelease!.split('.');

    for (let i = 0; i < Math.max(prerelease1.length, prerelease2.length); i++) {
      const part1 = prerelease1[i];
      const part2 = prerelease2[i];

      if (part1 === undefined) return VersionComparison.LESS_THAN;
      if (part2 === undefined) return VersionComparison.GREATER_THAN;

      // Try parsing as numbers
      const num1 = parseInt(part1, 10);
      const num2 = parseInt(part2, 10);

      if (!isNaN(num1) && !isNaN(num2)) {
        if (num1 !== num2) {
          return num1 > num2 ? VersionComparison.GREATER_THAN : VersionComparison.LESS_THAN;
        }
      } else {
        // Lexicographic comparison for non-numeric parts
        if (part1 !== part2) {
          return part1 > part2 ? VersionComparison.GREATER_THAN : VersionComparison.LESS_THAN;
        }
      }
    }

    return VersionComparison.EQUAL;
  }

  /**
   * Check if a version satisfies a version range
   */
  satisfiesRange(version: SemanticVersion, range: VersionRange): boolean {
    // Exact version match
    if (range.exact) {
      return this.compareVersions(version, range.exact) === VersionComparison.EQUAL;
    }

    // Range expression (simplified SemVer range support)
    if (range.expression) {
      return this.evaluateRangeExpression(version, range.expression);
    }

    // Min/max range check
    if (range.min) {
      const minComparison = this.compareVersions(version, range.min);
      if (minComparison === VersionComparison.LESS_THAN) {
        return false;
      }
    }

    if (range.max) {
      const maxComparison = this.compareVersions(version, range.max);
      if (maxComparison !== VersionComparison.LESS_THAN) {
        return false; // max is exclusive
      }
    }

    return true;
  }

  /**
   * Evaluate simplified SemVer range expressions
   * Supports: ^, ~, >=, <=, >, <, exact match
   */
  private evaluateRangeExpression(version: SemanticVersion, expression: string): boolean {
    // Remove whitespace
    expression = expression.trim();

    // Caret range (^): allow changes that don't modify left-most non-zero digit
    if (expression.startsWith('^')) {
      const baseVersion = this.parseVersion(expression.slice(1));
      const comparison = this.compareVersions(version, baseVersion);

      if (comparison === VersionComparison.LESS_THAN) return false;

      // Check if within caret range
      if (baseVersion.major > 0) {
        return version.major === baseVersion.major;
      } else if (baseVersion.minor > 0) {
        return version.major === 0 && version.minor === baseVersion.minor;
      } else {
        return version.major === 0 && version.minor === 0 && version.patch === baseVersion.patch;
      }
    }

    // Tilde range (~): allow patch-level changes
    if (expression.startsWith('~')) {
      const baseVersion = this.parseVersion(expression.slice(1));
      const comparison = this.compareVersions(version, baseVersion);

      if (comparison === VersionComparison.LESS_THAN) return false;

      return version.major === baseVersion.major && version.minor === baseVersion.minor;
    }

    // Comparison operators
    if (expression.startsWith('>=')) {
      const baseVersion = this.parseVersion(expression.slice(2).trim());
      const comparison = this.compareVersions(version, baseVersion);
      return comparison !== VersionComparison.LESS_THAN;
    }

    if (expression.startsWith('<=')) {
      const baseVersion = this.parseVersion(expression.slice(2).trim());
      const comparison = this.compareVersions(version, baseVersion);
      return comparison !== VersionComparison.GREATER_THAN;
    }

    if (expression.startsWith('>')) {
      const baseVersion = this.parseVersion(expression.slice(1).trim());
      return this.compareVersions(version, baseVersion) === VersionComparison.GREATER_THAN;
    }

    if (expression.startsWith('<')) {
      const baseVersion = this.parseVersion(expression.slice(1).trim());
      return this.compareVersions(version, baseVersion) === VersionComparison.LESS_THAN;
    }

    // Exact match
    const baseVersion = this.parseVersion(expression);
    return this.compareVersions(version, baseVersion) === VersionComparison.EQUAL;
  }

  /**
   * Check compatibility between two template versions
   */
  checkCompatibility(
    version1: TemplateVersion,
    version2: TemplateVersion
  ): CompatibilityCheckResult {
    // Check if version1 is compatible with version2
    if (
      version1.compatibleWith &&
      !this.satisfiesRange(version2.version, version1.compatibleWith)
    ) {
      return {
        compatible: false,
        reason: `Version ${this.versionToString(version1.version)} is not compatible with ${this.versionToString(version2.version)}`,
        suggestedUpgrade: this.findUpgradePath(version1, version2),
      };
    }

    // Check if version2 is compatible with version1
    if (
      version2.compatibleWith &&
      !this.satisfiesRange(version1.version, version2.compatibleWith)
    ) {
      return {
        compatible: false,
        reason: `Version ${this.versionToString(version2.version)} is not compatible with ${this.versionToString(version1.version)}`,
        suggestedUpgrade: this.findUpgradePath(version2, version1),
      };
    }

    // Check for deprecation warnings
    if (version1.deprecated || version2.deprecated) {
      const deprecatedVersion = version1.deprecated ? version1 : version2;
      return {
        compatible: true,
        reason: `Warning: Version ${this.versionToString(deprecatedVersion.version)} is deprecated. ${deprecatedVersion.deprecated!.message}`,
      };
    }

    return { compatible: true };
  }

  /**
   * Find an upgrade path between two versions
   */
  private findUpgradePath(
    from: TemplateVersion,
    to: TemplateVersion
  ): { from: string; to: string; migrationRequired: boolean } | undefined {
    const fromStr = this.versionToString(from.version);
    const toStr = this.versionToString(to.version);

    // Check if migration is available
    const migrationRequired = from.migrationFrom?.[toStr] !== undefined;

    return {
      from: fromStr,
      to: toStr,
      migrationRequired,
    };
  }

  /**
   * Register a template version in the registry
   */
  registerVersion(templateVersion: TemplateVersion): void {
    const { templateId } = templateVersion;

    let entry = this.registry.get(templateId);
    if (!entry) {
      entry = {
        templateId,
        versions: [],
        latestStable: templateVersion.version,
        latest: templateVersion.version,
      };
      this.registry.set(templateId, entry);
    }

    // Add version to the list
    entry.versions.push(templateVersion);

    // Sort versions
    entry.versions.sort((a, b) => this.compareVersions(b.version, a.version));

    // Update latest stable and latest versions
    entry.latest = entry.versions[0].version;
    const stableVersions = entry.versions.filter((v) => !v.version.prerelease);
    if (stableVersions.length > 0) {
      entry.latestStable = stableVersions[0].version;
    }
  }

  /**
   * Get a specific version from the registry
   */
  getVersion(templateId: string, version: string | SemanticVersion): TemplateVersion | undefined {
    const entry = this.registry.get(templateId);
    if (!entry) return undefined;

    const versionObj = typeof version === 'string' ? this.parseVersion(version) : version;

    return entry.versions.find(
      (v) => this.compareVersions(v.version, versionObj) === VersionComparison.EQUAL
    );
  }

  /**
   * Get the latest version for a template
   */
  getLatestVersion(templateId: string, includePrerelease = false): TemplateVersion | undefined {
    const entry = this.registry.get(templateId);
    if (!entry) return undefined;

    if (includePrerelease || this.options.allowPrerelease) {
      return this.getVersion(templateId, entry.latest);
    }

    return this.getVersion(templateId, entry.latestStable);
  }

  /**
   * Resolve version conflicts in a template pack combination
   */
  resolveVersions(requirements: Map<string, VersionRange[]>): VersionResolutionResult {
    const resolvedVersions: { [templateId: string]: SemanticVersion } = {};
    const conflicts: VersionConflict[] = [];
    const warnings: string[] = [];

    for (const [templateId, ranges] of requirements.entries()) {
      const entry = this.registry.get(templateId);
      if (!entry) {
        conflicts.push({
          templateId,
          conflicts: ranges.map((range) => ({
            requiredBy: 'unknown',
            versionRange: range,
          })),
        });
        continue;
      }

      // Find a version that satisfies all ranges
      let compatibleVersion: TemplateVersion | undefined;

      for (const version of entry.versions) {
        // Skip prerelease versions if not allowed
        if (version.version.prerelease && !this.options.allowPrerelease) {
          continue;
        }

        // Check if this version satisfies all ranges
        const satisfiesAll = ranges.every((range) => this.satisfiesRange(version.version, range));

        if (satisfiesAll) {
          compatibleVersion = version;
          break;
        }
      }

      if (compatibleVersion) {
        resolvedVersions[templateId] = compatibleVersion.version;

        // Add deprecation warning
        if (compatibleVersion.deprecated) {
          warnings.push(
            `${templateId}@${this.versionToString(compatibleVersion.version)} is deprecated: ${compatibleVersion.deprecated.message}`
          );
        }
      } else {
        // No compatible version found
        conflicts.push({
          templateId,
          conflicts: ranges.map((range) => ({
            requiredBy: 'unknown',
            versionRange: range,
          })),
        });
      }
    }

    return {
      success: conflicts.length === 0,
      resolvedVersions: conflicts.length === 0 ? resolvedVersions : undefined,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Validate that a template version is valid
   */
  validateVersion(templateVersion: TemplateVersion): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate version format
    try {
      this.parseVersion(this.versionToString(templateVersion.version));
    } catch (error) {
      errors.push(
        `Invalid version format: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Validate compatibility range
    if (templateVersion.compatibleWith?.expression) {
      try {
        const testVersion = { major: 1, minor: 0, patch: 0 };
        this.evaluateRangeExpression(testVersion, templateVersion.compatibleWith.expression);
      } catch (error) {
        errors.push(
          `Invalid compatibility range: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Validate release date
    if (isNaN(Date.parse(templateVersion.releaseDate))) {
      errors.push(`Invalid release date: ${templateVersion.releaseDate}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get all registered versions for a template
   */
  getRegistryEntry(templateId: string): VersionRegistryEntry | undefined {
    return this.registry.get(templateId);
  }

  /**
   * Clear the version registry
   */
  clearRegistry(): void {
    this.registry.clear();
  }
}
