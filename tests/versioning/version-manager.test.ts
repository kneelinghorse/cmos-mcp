/**
 * Version Manager Tests
 *
 * Tests SemVer parsing, comparison, range evaluation, and compatibility checking
 */

import { VersionManager } from '../../src/versioning/version-manager';
import {
  SemanticVersion,
  VersionComparison,
  TemplateVersion,
  InvalidVersionError,
} from '../../src/versioning/types';

describe('VersionManager', () => {
  let versionManager: VersionManager;

  beforeEach(() => {
    versionManager = new VersionManager();
  });

  describe('Version Parsing', () => {
    test('should parse standard version (X.Y.Z)', () => {
      const version = versionManager.parseVersion('1.2.3');
      expect(version).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
      });
    });

    test('should parse version with prerelease', () => {
      const version = versionManager.parseVersion('1.2.3-alpha');
      expect(version).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: 'alpha',
      });
    });

    test('should parse version with prerelease and build metadata', () => {
      const version = versionManager.parseVersion('1.2.3-beta.1+build.123');
      expect(version).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: 'beta.1',
        buildMetadata: 'build.123',
      });
    });

    test('should throw error for invalid version format', () => {
      expect(() => versionManager.parseVersion('1.2')).toThrow(InvalidVersionError);
      expect(() => versionManager.parseVersion('v1.2.3')).toThrow(InvalidVersionError);
      expect(() => versionManager.parseVersion('1.2.3.4')).toThrow(InvalidVersionError);
      expect(() => versionManager.parseVersion('abc')).toThrow(InvalidVersionError);
    });
  });

  describe('Version to String', () => {
    test('should convert standard version to string', () => {
      const version: SemanticVersion = { major: 1, minor: 2, patch: 3 };
      expect(versionManager.versionToString(version)).toBe('1.2.3');
    });

    test('should convert version with prerelease to string', () => {
      const version: SemanticVersion = {
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: 'alpha',
      };
      expect(versionManager.versionToString(version)).toBe('1.2.3-alpha');
    });

    test('should convert version with prerelease and build metadata to string', () => {
      const version: SemanticVersion = {
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: 'beta.1',
        buildMetadata: 'build.123',
      };
      expect(versionManager.versionToString(version)).toBe('1.2.3-beta.1+build.123');
    });
  });

  describe('Version Comparison', () => {
    test('should compare major versions correctly', () => {
      const v1 = versionManager.parseVersion('2.0.0');
      const v2 = versionManager.parseVersion('1.0.0');
      expect(versionManager.compareVersions(v1, v2)).toBe(VersionComparison.GREATER_THAN);
      expect(versionManager.compareVersions(v2, v1)).toBe(VersionComparison.LESS_THAN);
    });

    test('should compare minor versions correctly', () => {
      const v1 = versionManager.parseVersion('1.5.0');
      const v2 = versionManager.parseVersion('1.3.0');
      expect(versionManager.compareVersions(v1, v2)).toBe(VersionComparison.GREATER_THAN);
      expect(versionManager.compareVersions(v2, v1)).toBe(VersionComparison.LESS_THAN);
    });

    test('should compare patch versions correctly', () => {
      const v1 = versionManager.parseVersion('1.0.5');
      const v2 = versionManager.parseVersion('1.0.3');
      expect(versionManager.compareVersions(v1, v2)).toBe(VersionComparison.GREATER_THAN);
      expect(versionManager.compareVersions(v2, v1)).toBe(VersionComparison.LESS_THAN);
    });

    test('should detect equal versions', () => {
      const v1 = versionManager.parseVersion('1.2.3');
      const v2 = versionManager.parseVersion('1.2.3');
      expect(versionManager.compareVersions(v1, v2)).toBe(VersionComparison.EQUAL);
    });

    test('should treat version without prerelease as greater than with prerelease', () => {
      const v1 = versionManager.parseVersion('1.0.0');
      const v2 = versionManager.parseVersion('1.0.0-alpha');
      expect(versionManager.compareVersions(v1, v2)).toBe(VersionComparison.GREATER_THAN);
      expect(versionManager.compareVersions(v2, v1)).toBe(VersionComparison.LESS_THAN);
    });

    test('should compare prerelease versions lexicographically', () => {
      const v1 = versionManager.parseVersion('1.0.0-beta');
      const v2 = versionManager.parseVersion('1.0.0-alpha');
      expect(versionManager.compareVersions(v1, v2)).toBe(VersionComparison.GREATER_THAN);
      expect(versionManager.compareVersions(v2, v1)).toBe(VersionComparison.LESS_THAN);
    });

    test('should compare numeric prerelease parts numerically', () => {
      const v1 = versionManager.parseVersion('1.0.0-beta.10');
      const v2 = versionManager.parseVersion('1.0.0-beta.2');
      expect(versionManager.compareVersions(v1, v2)).toBe(VersionComparison.GREATER_THAN);
    });
  });

  describe('Version Range - Caret (^)', () => {
    test('should satisfy caret range for major > 0', () => {
      const version = versionManager.parseVersion('1.5.0');
      expect(versionManager.satisfiesRange(version, { expression: '^1.2.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '^1.0.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '^2.0.0' })).toBe(false);
    });

    test('should satisfy caret range for 0.minor.patch', () => {
      const version = versionManager.parseVersion('0.5.7');
      expect(versionManager.satisfiesRange(version, { expression: '^0.5.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '^0.6.0' })).toBe(false);
      expect(versionManager.satisfiesRange(version, { expression: '^0.4.0' })).toBe(false);
    });

    test('should satisfy caret range for 0.0.patch', () => {
      const version = versionManager.parseVersion('0.0.3');
      expect(versionManager.satisfiesRange(version, { expression: '^0.0.3' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '^0.0.2' })).toBe(false);
    });
  });

  describe('Version Range - Tilde (~)', () => {
    test('should satisfy tilde range (patch-level changes)', () => {
      const version = versionManager.parseVersion('1.2.5');
      expect(versionManager.satisfiesRange(version, { expression: '~1.2.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '~1.2.3' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '~1.3.0' })).toBe(false);
      expect(versionManager.satisfiesRange(version, { expression: '~2.0.0' })).toBe(false);
    });
  });

  describe('Version Range - Comparison Operators', () => {
    test('should satisfy >= operator', () => {
      const version = versionManager.parseVersion('1.5.0');
      expect(versionManager.satisfiesRange(version, { expression: '>=1.5.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '>=1.0.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '>=2.0.0' })).toBe(false);
    });

    test('should satisfy > operator', () => {
      const version = versionManager.parseVersion('1.5.0');
      expect(versionManager.satisfiesRange(version, { expression: '>1.4.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '>1.5.0' })).toBe(false);
    });

    test('should satisfy <= operator', () => {
      const version = versionManager.parseVersion('1.5.0');
      expect(versionManager.satisfiesRange(version, { expression: '<=1.5.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '<=2.0.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '<=1.0.0' })).toBe(false);
    });

    test('should satisfy < operator', () => {
      const version = versionManager.parseVersion('1.5.0');
      expect(versionManager.satisfiesRange(version, { expression: '<2.0.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '<1.5.0' })).toBe(false);
    });

    test('should satisfy exact match', () => {
      const version = versionManager.parseVersion('1.5.0');
      expect(versionManager.satisfiesRange(version, { expression: '1.5.0' })).toBe(true);
      expect(versionManager.satisfiesRange(version, { expression: '1.4.0' })).toBe(false);
    });
  });

  describe('Version Range - Min/Max', () => {
    test('should satisfy min/max range', () => {
      const version = versionManager.parseVersion('1.5.0');
      const range = {
        min: versionManager.parseVersion('1.0.0'),
        max: versionManager.parseVersion('2.0.0'),
      };
      expect(versionManager.satisfiesRange(version, range)).toBe(true);
    });

    test('should not satisfy if below min', () => {
      const version = versionManager.parseVersion('0.9.0');
      const range = {
        min: versionManager.parseVersion('1.0.0'),
      };
      expect(versionManager.satisfiesRange(version, range)).toBe(false);
    });

    test('should not satisfy if at or above max (exclusive)', () => {
      const version = versionManager.parseVersion('2.0.0');
      const range = {
        max: versionManager.parseVersion('2.0.0'),
      };
      expect(versionManager.satisfiesRange(version, range)).toBe(false);
    });
  });

  describe('Version Registry', () => {
    test('should register and retrieve template versions', () => {
      const templateVersion: TemplateVersion = {
        templateId: 'test-template',
        version: versionManager.parseVersion('1.0.0'),
        releaseDate: '2025-01-01T00:00:00Z',
      };

      versionManager.registerVersion(templateVersion);

      const retrieved = versionManager.getVersion('test-template', '1.0.0');
      expect(retrieved).toBeDefined();
      expect(versionManager.versionToString(retrieved!.version)).toBe('1.0.0');
    });

    test('should track latest and latest stable versions', () => {
      versionManager.registerVersion({
        templateId: 'test-template',
        version: versionManager.parseVersion('1.0.0'),
        releaseDate: '2025-01-01T00:00:00Z',
      });

      versionManager.registerVersion({
        templateId: 'test-template',
        version: versionManager.parseVersion('1.1.0'),
        releaseDate: '2025-01-02T00:00:00Z',
      });

      versionManager.registerVersion({
        templateId: 'test-template',
        version: versionManager.parseVersion('2.0.0-beta'),
        releaseDate: '2025-01-03T00:00:00Z',
      });

      const entry = versionManager.getRegistryEntry('test-template');
      expect(versionManager.versionToString(entry!.latestStable)).toBe('1.1.0');
      expect(versionManager.versionToString(entry!.latest)).toBe('2.0.0-beta');
    });

    test('should get latest stable version', () => {
      versionManager.registerVersion({
        templateId: 'test-template',
        version: versionManager.parseVersion('1.0.0'),
        releaseDate: '2025-01-01T00:00:00Z',
      });

      versionManager.registerVersion({
        templateId: 'test-template',
        version: versionManager.parseVersion('2.0.0-beta'),
        releaseDate: '2025-01-02T00:00:00Z',
      });

      const latest = versionManager.getLatestVersion('test-template', false);
      expect(versionManager.versionToString(latest!.version)).toBe('1.0.0');
    });

    test('should get latest version including prerelease', () => {
      versionManager.registerVersion({
        templateId: 'test-template',
        version: versionManager.parseVersion('1.0.0'),
        releaseDate: '2025-01-01T00:00:00Z',
      });

      versionManager.registerVersion({
        templateId: 'test-template',
        version: versionManager.parseVersion('2.0.0-beta'),
        releaseDate: '2025-01-02T00:00:00Z',
      });

      const latest = versionManager.getLatestVersion('test-template', true);
      expect(versionManager.versionToString(latest!.version)).toBe('2.0.0-beta');
    });
  });

  describe('Compatibility Checking', () => {
    test('should detect compatible versions', () => {
      const v1: TemplateVersion = {
        templateId: 'test-template',
        version: versionManager.parseVersion('1.5.0'),
        compatibleWith: { expression: '^1.0.0' },
        releaseDate: '2025-01-01T00:00:00Z',
      };

      const v2: TemplateVersion = {
        templateId: 'test-template',
        version: versionManager.parseVersion('1.3.0'),
        releaseDate: '2025-01-01T00:00:00Z',
      };

      const result = versionManager.checkCompatibility(v1, v2);
      expect(result.compatible).toBe(true);
    });

    test('should detect incompatible versions', () => {
      const v1: TemplateVersion = {
        templateId: 'test-template',
        version: versionManager.parseVersion('2.0.0'),
        compatibleWith: { expression: '^2.0.0' },
        releaseDate: '2025-01-01T00:00:00Z',
      };

      const v2: TemplateVersion = {
        templateId: 'test-template',
        version: versionManager.parseVersion('1.5.0'),
        releaseDate: '2025-01-01T00:00:00Z',
      };

      const result = versionManager.checkCompatibility(v1, v2);
      expect(result.compatible).toBe(false);
      expect(result.reason).toBeDefined();
    });

    test('should warn about deprecated versions', () => {
      const v1: TemplateVersion = {
        templateId: 'test-template',
        version: versionManager.parseVersion('1.0.0'),
        deprecated: {
          message: 'This version is deprecated',
          replacedBy: '2.0.0',
        },
        releaseDate: '2025-01-01T00:00:00Z',
      };

      const v2: TemplateVersion = {
        templateId: 'test-template',
        version: versionManager.parseVersion('1.1.0'),
        releaseDate: '2025-01-02T00:00:00Z',
      };

      const result = versionManager.checkCompatibility(v1, v2);
      expect(result.compatible).toBe(true);
      expect(result.reason).toContain('deprecated');
    });
  });

  describe('Version Resolution', () => {
    beforeEach(() => {
      // Register multiple versions
      versionManager.registerVersion({
        templateId: 'template-a',
        version: versionManager.parseVersion('1.0.0'),
        releaseDate: '2025-01-01T00:00:00Z',
      });

      versionManager.registerVersion({
        templateId: 'template-a',
        version: versionManager.parseVersion('1.5.0'),
        releaseDate: '2025-01-02T00:00:00Z',
      });

      versionManager.registerVersion({
        templateId: 'template-a',
        version: versionManager.parseVersion('2.0.0'),
        releaseDate: '2025-01-03T00:00:00Z',
      });
    });

    test('should resolve compatible version ranges', () => {
      const requirements = new Map([
        ['template-a', [{ expression: '^1.0.0' }, { expression: '>=1.5.0' }]],
      ]);

      const result = versionManager.resolveVersions(requirements);
      expect(result.success).toBe(true);
      expect(versionManager.versionToString(result.resolvedVersions!['template-a'])).toBe('1.5.0');
    });

    test('should detect conflicting version ranges', () => {
      const requirements = new Map([
        ['template-a', [{ expression: '^1.0.0' }, { expression: '^2.0.0' }]],
      ]);

      const result = versionManager.resolveVersions(requirements);
      expect(result.success).toBe(false);
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts!.length).toBeGreaterThan(0);
    });
  });

  describe('Version Validation', () => {
    test('should validate valid template version', () => {
      const templateVersion: TemplateVersion = {
        templateId: 'test-template',
        version: versionManager.parseVersion('1.0.0'),
        compatibleWith: { expression: '^1.0.0' },
        releaseDate: '2025-01-01T00:00:00Z',
      };

      const validation = versionManager.validateVersion(templateVersion);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    test('should detect invalid release date', () => {
      const templateVersion: TemplateVersion = {
        templateId: 'test-template',
        version: versionManager.parseVersion('1.0.0'),
        releaseDate: 'invalid-date',
      };

      const validation = versionManager.validateVersion(templateVersion);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('Invalid release date'))).toBe(true);
    });
  });
});
