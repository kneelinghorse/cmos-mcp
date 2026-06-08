import path from 'path';

import { pathExists } from '../utils/fs';

export interface CmosDetectorOptions {
  readonly cacheTtlMs?: number;
  readonly cmosDirectoryName?: string;
  readonly sqliteRelativePath?: string;
  readonly nowProvider?: () => number;
}

export interface CmosDetectionOptions {
  readonly forceRefresh?: boolean;
}

export interface CmosDetectionResult {
  readonly projectRoot: string;
  readonly cmosDirectory: string;
  readonly hasCmosDirectory: boolean;
  readonly hasDatabase: boolean;
  readonly databasePath?: string;
  readonly checkedAt: string;
}

interface CacheEntry {
  readonly timestamp: number;
  readonly result: CmosDetectionResult;
}

/**
 * Lightweight detector for CMOS runtime assets.
 *
 * The detector is intentionally stateful (singleton) so that repeated checks
 * during a single run do not hammer the file system. Results are cached per
 * project root for a configurable TTL and can be force-refreshed when needed.
 */
export class CmosDetector {
  private static instance?: CmosDetector;

  private readonly cacheTtlMs: number;
  private readonly cmosDirectoryName: string;
  private readonly sqliteRelativePath: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  private constructor(options: CmosDetectorOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.cmosDirectoryName = options.cmosDirectoryName ?? 'cmos';
    this.sqliteRelativePath = options.sqliteRelativePath ?? path.join('db', 'cmos.sqlite');
    this.now = options.nowProvider ?? (() => Date.now());
  }

  static getInstance(options: CmosDetectorOptions = {}): CmosDetector {
    if (!CmosDetector.instance) {
      CmosDetector.instance = new CmosDetector(options);
    }
    return CmosDetector.instance;
  }

  static resetInstance(): void {
    CmosDetector.instance = undefined;
  }

  async detect(
    projectRoot = process.cwd(),
    options: CmosDetectionOptions = {}
  ): Promise<CmosDetectionResult> {
    const root = path.resolve(projectRoot);
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
  ): CmosDetectionResult | undefined {
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

  private async performDetection(projectRoot: string): Promise<CmosDetectionResult> {
    const cmosDirectory = this.resolveCmosDirectory(projectRoot);
    const hasCmosDirectory = await pathExists(cmosDirectory);

    const databasePath = this.resolveDatabasePath(cmosDirectory);
    const hasDatabase = hasCmosDirectory && (await pathExists(databasePath));

    return {
      projectRoot,
      cmosDirectory,
      hasCmosDirectory,
      hasDatabase,
      databasePath: hasDatabase ? databasePath : undefined,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  private resolveCmosDirectory(projectRoot: string): string {
    if (path.isAbsolute(this.cmosDirectoryName)) {
      return this.cmosDirectoryName;
    }
    return path.resolve(projectRoot, this.cmosDirectoryName);
  }

  private resolveDatabasePath(cmosDirectory: string): string {
    if (path.isAbsolute(this.sqliteRelativePath)) {
      return this.sqliteRelativePath;
    }
    return path.resolve(cmosDirectory, this.sqliteRelativePath);
  }
}
