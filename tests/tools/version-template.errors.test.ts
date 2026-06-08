import { describe, it, expect, beforeEach } from '@jest/globals';

describe('version-template error handling', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  const loadTools = async () => import('../../src/tools/version-template');

  it('fails compatibility check when versions are missing', async () => {
    const { checkVersionCompatibility } = await loadTools();

    const result = await checkVersionCompatibility({
      templateId: 'unknown-template',
      version1: '1.0.0',
      version2: '1.0.1',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Compatibility check failed');
  });

  it('returns no latest version when none are registered', async () => {
    const { getLatestVersion } = await loadTools();

    const result = await getLatestVersion({
      templateId: 'empty-template',
      includePrerelease: false,
    });

    expect(result.success).toBe(true);
    expect(result.version).toBeUndefined();
    expect(result.message).toContain('No versions found');
  });

  it('fails to register invalid semantic versions', async () => {
    const { registerTemplateVersion } = await loadTools();

    const result = await registerTemplateVersion({
      templateId: 'demo',
      version: 'not-a-version',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to register template version');
  });

  it('fails to compare invalid versions', async () => {
    const { compareVersions } = await loadTools();

    const result = await compareVersions({
      version1: 'foo',
      version2: '1.0.0',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to compare versions');
  });

  it('fails to find migration path on invalid input', async () => {
    const { findMigrationPath } = await loadTools();

    const result = await findMigrationPath({
      templateId: 'demo',
      fromVersion: 'invalid',
      toVersion: '1.0.0',
    });

    expect(result.success).toBe(false);
    expect(result.pathFound).toBe(false);
    expect(result.message).toContain('Failed to find migration path');
  });
});
