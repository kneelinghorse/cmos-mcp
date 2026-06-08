/**
 * Server Health Module Tests
 *
 * Tests for build manifest reading, staleness detection, and health reporting.
 *
 * @module tests/server-health
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readBuildManifest,
  initServerHealth,
  getServerHealth,
  isServerStale,
  getStartupManifest,
  resetServerHealth,
  type BuildManifest,
} from '../src/server-health';

describe('server-health', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-health-test-'));
    resetServerHealth();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetServerHealth();
  });

  describe('readBuildManifest', () => {
    it('returns null when no manifest exists', () => {
      const result = readBuildManifest(tempDir);
      expect(result).toBeNull();
    });

    it('reads valid manifest from direct path', () => {
      const manifest: BuildManifest = {
        buildHash: 'abc123def456',
        buildTime: '2026-03-11T10:00:00.000Z',
        fileCount: 42,
      };
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), JSON.stringify(manifest));

      const result = readBuildManifest(tempDir);
      expect(result).toEqual(manifest);
    });

    it('reads valid manifest from dist/ subdirectory', () => {
      const distDir = path.join(tempDir, 'dist');
      fs.mkdirSync(distDir);
      const manifest: BuildManifest = {
        buildHash: 'xyz789',
        buildTime: '2026-03-11T12:00:00.000Z',
        fileCount: 10,
      };
      fs.writeFileSync(path.join(distDir, '.build-manifest.json'), JSON.stringify(manifest));

      const result = readBuildManifest(tempDir);
      expect(result).toEqual(manifest);
    });

    it('returns null for malformed manifest (missing buildHash)', () => {
      fs.writeFileSync(
        path.join(tempDir, '.build-manifest.json'),
        JSON.stringify({ buildTime: '2026-03-11T10:00:00.000Z' })
      );

      const result = readBuildManifest(tempDir);
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), 'not json');

      const result = readBuildManifest(tempDir);
      expect(result).toBeNull();
    });
  });

  describe('initServerHealth', () => {
    it('captures startup manifest when present', () => {
      const manifest: BuildManifest = {
        buildHash: 'startup-hash-123',
        buildTime: '2026-03-11T10:00:00.000Z',
        fileCount: 20,
      };
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), JSON.stringify(manifest));

      initServerHealth(tempDir);

      const startup = getStartupManifest();
      expect(startup).toEqual(manifest);
    });

    it('handles missing manifest gracefully', () => {
      initServerHealth(tempDir);

      const startup = getStartupManifest();
      expect(startup).toBeNull();
    });
  });

  describe('getServerHealth', () => {
    it('returns basic health metrics', () => {
      initServerHealth(tempDir);

      const health = getServerHealth();
      expect(health.pid).toBe(process.pid);
      expect(health.nodeVersion).toBe(process.version);
      expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(health.memoryUsageMb).toBeGreaterThan(0);
      expect(health.startedAt).toBeDefined();
    });

    it('reports code as current when manifests match', () => {
      const manifest: BuildManifest = {
        buildHash: 'matching-hash-123',
        buildTime: '2026-03-11T10:00:00.000Z',
        fileCount: 15,
      };
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), JSON.stringify(manifest));

      initServerHealth(tempDir);

      const health = getServerHealth();
      expect(health.codeIsCurrent).toBe(true);
      expect(health.stalenessMessage).toBeNull();
      expect(health.startupBuild).toEqual(manifest);
      expect(health.currentBuild).toEqual(manifest);
    });

    it('detects stale code when manifest changes after startup', () => {
      const startupManifest: BuildManifest = {
        buildHash: 'old-hash-111',
        buildTime: '2026-03-11T10:00:00.000Z',
        fileCount: 15,
      };
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), JSON.stringify(startupManifest));

      initServerHealth(tempDir);

      // Simulate rebuild by writing new manifest
      const newManifest: BuildManifest = {
        buildHash: 'new-hash-222',
        buildTime: '2026-03-11T11:00:00.000Z',
        fileCount: 16,
      };
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), JSON.stringify(newManifest));

      const health = getServerHealth();
      expect(health.codeIsCurrent).toBe(false);
      expect(health.stalenessMessage).toContain('stale code');
      expect(health.stalenessMessage).toContain('old-hash-111');
      expect(health.stalenessMessage).toContain('new-hash-222');
      expect(health.startupBuild!.buildHash).toBe('old-hash-111');
      expect(health.currentBuild!.buildHash).toBe('new-hash-222');
    });

    it('detects staleness when manifest appears after startup', () => {
      // Start without manifest
      initServerHealth(tempDir);

      // Then manifest appears (first build)
      const newManifest: BuildManifest = {
        buildHash: 'first-build-hash',
        buildTime: '2026-03-11T11:00:00.000Z',
        fileCount: 10,
      };
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), JSON.stringify(newManifest));

      const health = getServerHealth();
      expect(health.codeIsCurrent).toBe(false);
      expect(health.stalenessMessage).toContain('Restart recommended');
    });

    it('handles no manifest at all (both startup and current)', () => {
      initServerHealth(tempDir);

      const health = getServerHealth();
      expect(health.codeIsCurrent).toBe(true);
      expect(health.stalenessMessage).toBeNull();
      expect(health.startupBuild).toBeNull();
      expect(health.currentBuild).toBeNull();
    });
  });

  describe('isServerStale', () => {
    it('returns false when code is current', () => {
      const manifest: BuildManifest = {
        buildHash: 'current-hash',
        buildTime: '2026-03-11T10:00:00.000Z',
        fileCount: 10,
      };
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), JSON.stringify(manifest));

      initServerHealth(tempDir);
      expect(isServerStale()).toBe(false);
    });

    it('returns true when code is stale', () => {
      const manifest: BuildManifest = {
        buildHash: 'old-hash',
        buildTime: '2026-03-11T10:00:00.000Z',
        fileCount: 10,
      };
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), JSON.stringify(manifest));

      initServerHealth(tempDir);

      // Change manifest
      fs.writeFileSync(
        path.join(tempDir, '.build-manifest.json'),
        JSON.stringify({
          buildHash: 'new-hash',
          buildTime: '2026-03-11T11:00:00.000Z',
          fileCount: 11,
        })
      );

      expect(isServerStale()).toBe(true);
    });
  });

  describe('resetServerHealth', () => {
    it('clears all state', () => {
      const manifest: BuildManifest = {
        buildHash: 'test-hash',
        buildTime: '2026-03-11T10:00:00.000Z',
        fileCount: 5,
      };
      fs.writeFileSync(path.join(tempDir, '.build-manifest.json'), JSON.stringify(manifest));

      initServerHealth(tempDir);
      expect(getStartupManifest()).not.toBeNull();

      resetServerHealth();
      expect(getStartupManifest()).toBeNull();
    });
  });
});
