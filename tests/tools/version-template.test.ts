import { describe, expect, test, beforeEach } from '@jest/globals';
import type { TemplateVersion, MigrationPath } from '../../src/versioning/types';

type VersionMap = Map<string, Map<string, TemplateVersion>>;

interface VersionManagerMockState {
  versions: VersionMap;
  compatibilityResult: {
    compatible: boolean;
    reason?: string;
    suggestedUpgrade?: {
      from: string;
      to: string;
      migrationRequired: boolean;
    };
  };
  validateResult: { valid: boolean; errors?: string[] };
  latestVersion: {
    version: { major: number; minor: number; patch: number; prerelease?: string };
    releaseDate: string;
    deprecated?: { message: string };
  } | null;
  latestVersionThrows: boolean;
  latestVersionError?: string;
  compareResult: -1 | 0 | 1;
  migrationPath: MigrationPath | null;
  registeredVersions: TemplateVersion[];
  initializations: number;
  getVersionThrows?: unknown;
}

const mockState: VersionManagerMockState = {
  versions: new Map(),
  compatibilityResult: { compatible: true },
  validateResult: { valid: true },
  latestVersion: null,
  latestVersionThrows: false,
  compareResult: 0,
  migrationPath: null,
  registeredVersions: [],
  initializations: 0,
  getVersionThrows: undefined,
};

const resetMockState = () => {
  mockState.versions = new Map();
  mockState.compatibilityResult = { compatible: true };
  mockState.validateResult = { valid: true };
  mockState.latestVersion = null;
  mockState.latestVersionThrows = false;
  mockState.latestVersionError = undefined;
  mockState.compareResult = 0;
  mockState.migrationPath = null;
  mockState.registeredVersions = [];
  mockState.initializations = 0;
  mockState.getVersionThrows = undefined;
};

jest.mock('../../src/versioning/version-manager', () => {
  class MockVersionManager {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(options: unknown = {}) {
      mockState.initializations += 1;
    }

    getVersion(templateId: string, version: string) {
      if (mockState.getVersionThrows !== undefined) {
        throw mockState.getVersionThrows;
      }
      return mockState.versions.get(templateId)?.get(version);
    }

    checkCompatibility() {
      return mockState.compatibilityResult;
    }

    parseVersion(versionString: string) {
      const [main, prerelease] = versionString.split('-');
      const [major, minor, patch] = main.split('.').map((part) => parseInt(part, 10));
      if ([major, minor, patch].some((value) => Number.isNaN(value))) {
        throw new Error(`Invalid version: ${versionString}`);
      }
      return { major, minor, patch, prerelease };
    }

    versionToString(version: { major: number; minor: number; patch: number; prerelease?: string }) {
      const base = `${version.major}.${version.minor}.${version.patch}`;
      return version.prerelease ? `${base}-${version.prerelease}` : base;
    }

    validateVersion() {
      return mockState.validateResult;
    }

    registerVersion(templateVersion: TemplateVersion) {
      mockState.registeredVersions.push(templateVersion);
    }

    getLatestVersion() {
      if (mockState.latestVersionThrows) {
        throw new Error(mockState.latestVersionError ?? 'latest version failed');
      }
      return mockState.latestVersion;
    }

    compareVersions() {
      return mockState.compareResult;
    }
  }

  return { VersionManager: MockVersionManager };
});

jest.mock('../../src/versioning/migration-engine', () => {
  class MockMigrationEngine {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(versionManager: unknown, options: unknown = {}) {}

    findMigrationPath() {
      return mockState.migrationPath;
    }
  }

  return {
    MigrationEngine: MockMigrationEngine,
    createMigration: jest.fn(),
  };
});

const loadModule = async () => import('../../src/tools/version-template');

const registerTemplateVersionInState = (
  templateId: string,
  version: string,
  payload: Partial<TemplateVersion> = {}
) => {
  const [major, minor, patch] = version.split('.').map((part) => parseInt(part, 10));
  const versions = mockState.versions.get(templateId) ?? new Map<string, TemplateVersion>();
  versions.set(version, {
    templateId,
    version: { major, minor, patch },
    releaseDate: payload.releaseDate ?? '2024-01-01T00:00:00.000Z',
    ...payload,
  });
  mockState.versions.set(templateId, versions);
};

describe('version-template tools (success paths)', () => {
  beforeEach(() => {
    jest.resetModules();
    resetMockState();
  });

  test('checkVersionCompatibility returns compatibility details when versions exist', async () => {
    registerTemplateVersionInState('demo', '1.0.0');
    registerTemplateVersionInState('demo', '1.1.0');
    mockState.compatibilityResult = {
      compatible: true,
      reason: undefined,
      suggestedUpgrade: undefined,
    };

    const { checkVersionCompatibility } = await loadModule();
    const result = await checkVersionCompatibility({
      templateId: 'demo',
      version1: '1.0.0',
      version2: '1.1.0',
    });

    expect(result.success).toBe(true);
    expect(result.compatible).toBe(true);
    expect(result.message).toContain('are compatible');
  });

  test('checkVersionCompatibility reports incompatible versions', async () => {
    registerTemplateVersionInState('demo', '1.0.0');
    registerTemplateVersionInState('demo', '2.0.0');
    mockState.compatibilityResult = {
      compatible: false,
      reason: 'Breaking API change',
      suggestedUpgrade: {
        from: '1.0.0',
        to: '2.0.0',
        migrationRequired: true,
      },
    };

    const { checkVersionCompatibility } = await loadModule();
    const result = await checkVersionCompatibility({
      templateId: 'demo',
      version1: '1.0.0',
      version2: '2.0.0',
    });

    expect(result.success).toBe(true);
    expect(result.compatible).toBe(false);
    expect(result.message).toContain('NOT compatible');
    expect(result.suggestedUpgrade?.migrationRequired).toBe(true);
  });

  test('checkVersionCompatibility fails when second version missing', async () => {
    registerTemplateVersionInState('demo', '1.0.0');

    const { checkVersionCompatibility } = await loadModule();
    const result = await checkVersionCompatibility({
      templateId: 'demo',
      version1: '1.0.0',
      version2: '2.0.0',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Version 2.0.0 not found');
  });

  test('checkVersionCompatibility fails when first version missing', async () => {
    registerTemplateVersionInState('demo', '2.0.0');

    const { checkVersionCompatibility } = await loadModule();
    const result = await checkVersionCompatibility({
      templateId: 'demo',
      version1: '1.0.0',
      version2: '2.0.0',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Version 1.0.0 not found');
  });

  test('findMigrationPath returns formatted migration path', async () => {
    registerTemplateVersionInState('demo', '1.0.0');
    registerTemplateVersionInState('demo', '2.0.0');
    mockState.migrationPath = {
      from: { major: 1, minor: 0, patch: 0 },
      to: { major: 2, minor: 0, patch: 0 },
      steps: [
        {
          id: 'upgrade-core',
          fromVersion: { major: 1, minor: 0, patch: 0 },
          toVersion: { major: 1, minor: 5, patch: 0 },
          description: 'Upgrade core components',
          migrate: async () => ({
            success: true,
            migratedTemplate: { version: '1.1.0' },
            executionTime: 10,
          }),
          reversible: true,
          estimatedDuration: 15,
        },
        {
          id: 'upgrade-api',
          fromVersion: { major: 1, minor: 5, patch: 0 },
          toVersion: { major: 2, minor: 0, patch: 0 },
          description: 'Upgrade API',
          migrate: async () => ({
            success: true,
            migratedTemplate: { version: '2.0.0' },
            executionTime: 8,
          }),
          reversible: true,
          estimatedDuration: 10,
        },
      ],
      reversible: true,
      totalDuration: 25,
    };

    const { findMigrationPath } = await loadModule();
    const result = await findMigrationPath({
      templateId: 'demo',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    });

    expect(result.success).toBe(true);
    expect(result.pathFound).toBe(true);
    expect(result.path?.steps).toHaveLength(2);
    expect(result.message).toContain('estimated duration: 25s');
  });

  test('findMigrationPath returns no path when migrations missing', async () => {
    mockState.migrationPath = null;
    const { findMigrationPath } = await loadModule();
    const result = await findMigrationPath({
      templateId: 'demo',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    });

    expect(result.success).toBe(true);
    expect(result.pathFound).toBe(false);
    expect(result.message).toContain('No migration path found');
  });

  test('findMigrationPath reports parse failures gracefully', async () => {
    const { findMigrationPath } = await loadModule();

    const result = await findMigrationPath({
      templateId: 'demo',
      fromVersion: '1.invalid',
      toVersion: '2.0.0',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid version: 1.invalid');
  });

  test('registerTemplateVersion stores parsed versions', async () => {
    const { registerTemplateVersion } = await loadModule();

    const result = await registerTemplateVersion({
      templateId: 'demo',
      version: '1.2.3',
      changelog: 'Adds reporting',
      releaseDate: '2024-05-01T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
    expect(mockState.registeredVersions).toHaveLength(1);
    expect(mockState.registeredVersions[0].version.major).toBe(1);
    expect(result.version?.version).toBe('1.2.3');
  });

  test('registerTemplateVersion surfaces validation errors', async () => {
    mockState.validateResult = { valid: false, errors: ['missing changelog'] };
    const { registerTemplateVersion } = await loadModule();

    const result = await registerTemplateVersion({
      templateId: 'demo',
      version: '3.0.0',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid template version: missing changelog');
  });

  test('registerTemplateVersion applies defaults and compatible ranges', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2024-06-01T12:00:00Z'));

    try {
      const { registerTemplateVersion } = await loadModule();

      const result = await registerTemplateVersion({
        templateId: 'demo',
        version: '4.5.6',
        compatibleWith: '^4.0.0',
      });

      expect(result.success).toBe(true);
      expect(result.version?.releaseDate).toBe('2024-06-01T12:00:00.000Z');
      expect(mockState.registeredVersions[0].compatibleWith?.expression).toBe('^4.0.0');
    } finally {
      jest.useRealTimers();
    }
  });

  test('getLatestVersion returns latest metadata when available', async () => {
    mockState.latestVersion = {
      version: { major: 2, minor: 1, patch: 0 },
      releaseDate: '2024-04-01T00:00:00.000Z',
      deprecated: { message: 'Superseded by 3.0.0' },
    };

    const { getLatestVersion } = await loadModule();
    const result = await getLatestVersion({
      templateId: 'demo',
      includePrerelease: false,
    });

    expect(result.success).toBe(true);
    expect(result.version?.version).toBe('2.1.0');
    expect(result.version?.deprecated).toBe(true);
    expect(result.version?.deprecationMessage).toBe('Superseded by 3.0.0');
  });

  test('getLatestVersion returns error when version manager fails', async () => {
    mockState.latestVersionThrows = true;
    mockState.latestVersionError = 'registry offline';

    const { getLatestVersion } = await loadModule();
    const result = await getLatestVersion({
      templateId: 'demo',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('registry offline');
  });

  test('getLatestVersion reports when no versions registered', async () => {
    mockState.latestVersion = null;

    const { getLatestVersion } = await loadModule();
    const result = await getLatestVersion({ templateId: 'demo' });

    expect(result.success).toBe(true);
    expect(result.version).toBeUndefined();
    expect(result.message).toContain('No versions found');
  });

  test('compareVersions maps compare result to comparison enum', async () => {
    mockState.compareResult = -1;

    const { compareVersions } = await loadModule();
    const result = await compareVersions({
      version1: '1.0.0',
      version2: '2.0.0',
    });

    expect(result.success).toBe(true);
    expect(result.comparison).toBe('less_than');
    expect(result.message).toContain('less than');
  });

  test('compareVersions handles equal and greater-than comparisons', async () => {
    const { compareVersions } = await loadModule();

    mockState.compareResult = 0;
    const equal = await compareVersions({ version1: '1.0.0', version2: '1.0.0' });
    expect(equal.comparison).toBe('equal');

    mockState.compareResult = 1;
    const greater = await compareVersions({ version1: '2.0.0', version2: '1.0.0' });
    expect(greater.comparison).toBe('greater_than');
  });

  test('compareVersions surfaces parse errors', async () => {
    const { compareVersions } = await loadModule();

    const result = await compareVersions({
      version1: '1.0.0',
      version2: 'invalid',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid version: invalid');
  });

  test('initializeVersioning reuses existing manager instances within module scope', async () => {
    const module = await loadModule();
    const context = {
      templateId: 'demo',
      version: '1.0.0',
    };

    await module.registerTemplateVersion(context);
    mockState.latestVersion = {
      version: { major: 1, minor: 0, patch: 0 },
      releaseDate: '2024-01-01T00:00:00.000Z',
    };

    await module.getLatestVersion({ templateId: 'demo' });
    expect(mockState.initializations).toBe(1);
  });

  test('checkVersionCompatibility handles non-error throws gracefully', async () => {
    mockState.getVersionThrows = 'text failure';

    const { checkVersionCompatibility } = await loadModule();
    const result = await checkVersionCompatibility({
      templateId: 'demo',
      version1: '1.0.0',
      version2: '1.1.0',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('text failure');
  });
});
