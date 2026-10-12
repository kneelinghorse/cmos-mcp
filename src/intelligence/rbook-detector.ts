// ABOUTME: Detects the selected legacy or renamed project record without moving its files.
// ABOUTME: Explicit custom layouts remain supported; migration guards precede cached discovery.
import path from 'path';
import { assertNoRecordMigration, resolveRecordPaths } from './legacy-compat';
import { DATABASE_FILE } from './product-names';

import { pathExists } from '../utils/fs';

export interface RbookDetectorOptions {
  readonly cacheTtlMs?: number;
  readonly rbookDirectoryName?: string;
  readonly sqliteRelativePath?: string;
  readonly nowProvider?: () => number;
}

export interface RbookDetectionOptions {
  readonly forceRefresh?: boolean;
}

export interface RbookDetectionResult {
  readonly projectRoot: string;
  readonly rbookDirectory: string;
  readonly hasRbookDirectory: boolean;
  readonly hasDatabase: boolean;
  readonly databasePath?: string;
  readonly checkedAt: string;
}

interface CacheEntry {
  readonly timestamp: number;
  readonly result: RbookDetectionResult;
}

/**
 * Lightweight detector for Reasonbook runtime assets.
 *
 * The detector is intentionally stateful (singleton) so that repeated checks
 * during a single run do not hammer the file system. Results are cached per
 * project root for a configurable TTL and can be force-refreshed when needed.
 */
export class RbookDetector {
  private static instance?: RbookDetector;

  private readonly cacheTtlMs: number;
  private readonly rbookDirectoryName?: string;
  private readonly sqliteRelativePath?: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  private constructor(options: RbookDetectorOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.rbookDirectoryName = options.rbookDirectoryName;
    this.sqliteRelativePath = options.sqliteRelativePath;
    this.now = options.nowProvider ?? (() => Date.now());
  }

  static getInstance(options: RbookDetectorOptions = {}): RbookDetector {
    if (!RbookDetector.instance) {
      RbookDetector.instance = new RbookDetector(options);
    }
    return RbookDetector.instance;
  }

  static resetInstance(): void {
    RbookDetector.instance = undefined;
  }

  async detect(
    projectRoot = process.cwd(),
    options: RbookDetectionOptions = {}
  ): Promise<RbookDetectionResult> {
    const root = path.resolve(projectRoot);
    assertNoRecordMigration(root);
    const { forceRefresh = false } = options;
    const cached = this.getCachedResult(root, forceRefresh);
    if (cached) {
      return cached;
    }

    const result = await this.performDetection(root);
    this.cache.set(root, { timestamp: this.now(), result });
    return result;
  }

  clearCache(projectRoot?: string): void {
    if (projectRoot) {
      this.cache.delete(path.resolve(projectRoot));
      return;
    }
    this.cache.clear();
  }

  private getCachedResult(
    projectRoot: string,
    forceRefresh: boolean
  ): RbookDetectionResult | undefined {
    if (forceRefresh) {
      return undefined;
    }

    const entry = this.cache.get(projectRoot);
    if (!entry) {
      return undefined;
    }

    const age = this.now() - entry.timestamp;
    if (age > this.cacheTtlMs) {
      this.cache.delete(projectRoot);
      return undefined;
    }

    return entry.result;
  }

  private async performDetection(projectRoot: string): Promise<RbookDetectionResult> {
    const rbookDirectory = this.resolveRbookDirectory(projectRoot);
    const hasRbookDirectory = await pathExists(rbookDirectory);

    const databasePath = this.resolveDatabasePath(rbookDirectory, projectRoot);
    const hasDatabase = hasRbookDirectory && (await pathExists(databasePath));

    return {
      projectRoot,
      rbookDirectory,
      hasRbookDirectory,
      hasDatabase,
      databasePath: hasDatabase ? databasePath : undefined,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  private resolveRbookDirectory(projectRoot: string): string {
    if (this.rbookDirectoryName === undefined) return resolveRecordPaths(projectRoot).directory;
    if (path.isAbsolute(this.rbookDirectoryName)) {
      return this.rbookDirectoryName;
    }
    return path.resolve(projectRoot, this.rbookDirectoryName);
  }

  private resolveDatabasePath(rbookDirectory: string, projectRoot: string): string {
    if (this.sqliteRelativePath === undefined) {
      return this.rbookDirectoryName === undefined
        ? resolveRecordPaths(projectRoot).dbPath
        : path.join(rbookDirectory, 'db', DATABASE_FILE);
    }
    if (path.isAbsolute(this.sqliteRelativePath)) {
      return this.sqliteRelativePath;
    }
    return path.resolve(rbookDirectory, this.sqliteRelativePath);
  }
}
