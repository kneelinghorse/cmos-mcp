/**
 * MCP Server Health Module
 *
 * Tracks server process health and detects stale code (build drift).
 * At startup, captures the build manifest from dist/.build-manifest.json.
 * At runtime, re-reads the manifest to detect if a rebuild has occurred
 * since the server started.
 *
 * @module server-health
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Build manifest written by scripts/generate-build-manifest.js
 */
export interface BuildManifest {
  /** SHA-256 hash of all compiled JS files */
  buildHash: string;
  /** ISO timestamp of the build */
  buildTime: string;
  /** Number of JS files in the build */
  fileCount: number;
}

/**
 * Server health status returned by getServerHealth().
 */
export interface ServerHealthStatus {
  /** Server uptime in seconds */
  uptimeSeconds: number;
  /** Server start time as ISO string */
  startedAt: string;
  /** Current memory usage in MB */
  memoryUsageMb: number;
  /** Build manifest captured at startup (null if manifest not found) */
  startupBuild: BuildManifest | null;
  /** Current build manifest on disk (null if manifest not found) */
  currentBuild: BuildManifest | null;
  /** Whether running code matches the latest build */
  codeIsCurrent: boolean;
  /** Human-readable staleness message (null if code is current) */
  stalenessMessage: string | null;
  /** Process PID */
  pid: number;
  /** Node.js version */
  nodeVersion: string;
}

// Module-level state
let serverStartTime: Date | null = null;
let startupManifest: BuildManifest | null = null;
let manifestPath: string | null = null;
let initialSearchDir: string | undefined = undefined;

/**
 * Read the build manifest from disk.
 * Returns null if the file doesn't exist or is malformed.
 */
export function readBuildManifest(distDir?: string): BuildManifest | null {
  const dir = distDir ?? path.resolve(__dirname, '..');
  // When running from dist/, __dirname IS the dist dir
  // When running from src/ (tests), go up to project root then into dist/
  const candidates = [
    path.join(dir, '.build-manifest.json'),
    path.join(dir, 'dist', '.build-manifest.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed.buildHash === 'string' &&
          typeof parsed.buildTime === 'string'
        ) {
          manifestPath = candidate;
          return parsed as BuildManifest;
        }
      }
    } catch {
      // Continue to next candidate
    }
  }
  return null;
}

/**
 * Initialize server health tracking.
 * Call this once at server startup to capture the initial build manifest.
 */
export function initServerHealth(distDir?: string): void {
  serverStartTime = new Date();
  initialSearchDir = distDir;
  startupManifest = readBuildManifest(distDir);

  if (startupManifest) {
    console.error(
      `[INFO] Server health initialized: buildHash=${startupManifest.buildHash.slice(0, 12)}… buildTime=${startupManifest.buildTime}`
    );
  } else {
    console.error(
      // s86-m05: names both situations. `npm run build` exists only in a source checkout —
      // scripts/ and the build toolchain are not in package.json files[].
      `[WARN] No build manifest found — staleness detection disabled. Rebuild from source ('npm run build') or reinstall the package to generate one.`
    );
  }
}

/**
 * Get the current server health status.
 * Re-reads the build manifest from disk to detect drift.
 */
export function getServerHealth(): ServerHealthStatus {
  const now = new Date();
  const startTime = serverStartTime ?? now;
  const uptimeSeconds = Math.floor((now.getTime() - startTime.getTime()) / 1000);

  const memUsage = process.memoryUsage();
  const memoryUsageMb = Math.round((memUsage.rss / 1024 / 1024) * 100) / 100;

  // Re-read manifest from disk to check for drift
  // Use the same search directory as initialization to avoid finding unrelated manifests
  const currentManifest = manifestPath
    ? readBuildManifest(path.dirname(manifestPath))
    : readBuildManifest(initialSearchDir);

  // Determine staleness
  let codeIsCurrent = true;
  let stalenessMessage: string | null = null;

  if (startupManifest && currentManifest) {
    if (startupManifest.buildHash !== currentManifest.buildHash) {
      codeIsCurrent = false;
      const builtAt = new Date(currentManifest.buildTime);
      const startedAt = new Date(startupManifest.buildTime);
      const driftMinutes = Math.round((builtAt.getTime() - startedAt.getTime()) / 60000);
      stalenessMessage =
        `Server is running stale code. ` +
        `Build at startup: ${startupManifest.buildHash.slice(0, 12)}… (${startupManifest.buildTime}). ` +
        `Current build: ${currentManifest.buildHash.slice(0, 12)}… (${currentManifest.buildTime}). ` +
        `Drift: ${driftMinutes} minute(s). Restart the MCP server to pick up changes.`;
    }
  } else if (!startupManifest && !currentManifest) {
    // No manifest at all — can't detect staleness
    stalenessMessage = null;
  } else if (!startupManifest && currentManifest) {
    // Server started without manifest, but one exists now
    codeIsCurrent = false;
    stalenessMessage =
      'Server started before build manifest existed. A build has since occurred. Restart recommended.';
  }

  return {
    uptimeSeconds,
    startedAt: startTime.toISOString(),
    memoryUsageMb,
    startupBuild: startupManifest,
    currentBuild: currentManifest,
    codeIsCurrent,
    stalenessMessage,
    pid: process.pid,
    nodeVersion: process.version,
  };
}

/**
 * Check if the server is running stale code.
 * Convenience wrapper for use in onboard/health flows.
 */
export function isServerStale(): boolean {
  const health = getServerHealth();
  return !health.codeIsCurrent;
}

/**
 * The project root whose build this server process tracks — i.e. the directory
 * containing the dist/.build-manifest.json captured at startup. The running-
 * server-stale signal compares THIS process's startup hash against THIS code's
 * manifest on disk; it has nothing to do with whatever project is calling. So
 * consumers use this to scope that signal to the server's OWN closeout and avoid
 * blaming a sibling project for a rebuild of the server itself. Returns null
 * when no manifest was located at startup (staleness detection disabled).
 */
export function getServerProjectRoot(): string | null {
  if (!manifestPath) return null;
  // manifestPath is <root>/dist/.build-manifest.json (server run from dist/) or,
  // in tests run from within dist, <dist>/.build-manifest.json. Either way the
  // project root is the parent of the dist/ directory.
  const dir = path.dirname(manifestPath);
  return path.basename(dir) === 'dist' ? path.dirname(dir) : dir;
}

/**
 * Get the startup manifest (for testing).
 */
export function getStartupManifest(): BuildManifest | null {
  return startupManifest;
}

/**
 * Reset server health state (for testing).
 */
export function resetServerHealth(): void {
  serverStartTime = null;
  startupManifest = null;
  manifestPath = null;
  initialSearchDir = undefined;
}
