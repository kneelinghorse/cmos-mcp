import { promises as fs } from 'fs';
import * as path from 'path';

import { SecureYAMLLoader } from '../loaders/yaml-loader';
import { IOError } from '../errors/io-error';
import { PathTraversalError, SchemaValidationError, UnsafeYAMLError } from '../types/errors';

export type WorkerManifestValidationLevel = 'info' | 'warning' | 'error';

export interface WorkerManifestValidation {
  readonly level: WorkerManifestValidationLevel;
  readonly code: string;
  readonly message: string;
  readonly workerId?: string;
}

export interface WorkerPatternSupport {
  readonly mutuallyExclusive: boolean;
  readonly allowedPatterns: readonly string[];
  readonly fallbackPattern?: string;
}

export interface WorkerConstraints {
  readonly requiredTools: readonly string[];
  readonly maxConcurrent: number;
  readonly timeoutSeconds?: number;
  readonly tokenBudget?: number;
}

export interface WorkerTelemetry {
  readonly emits: readonly string[];
}

export interface WorkerPatterns {
  readonly supports: readonly string[];
}

export interface WorkerDefinition {
  readonly workerId: string;
  readonly name: string;
  readonly description?: string;
  readonly templatePath: string;
  readonly capabilities: readonly string[];
  readonly patterns: WorkerPatterns;
  readonly constraints: WorkerConstraints;
  readonly telemetry?: WorkerTelemetry;
}

export interface WorkerManifest {
  readonly version: string;
  readonly patternSupport: WorkerPatternSupport;
  readonly workers: readonly WorkerDefinition[];
}

export interface WorkerManifestLoadResult {
  readonly manifestPath: string;
  readonly relativePath: string;
  readonly loaded: boolean;
  readonly manifest?: WorkerManifest;
  readonly validations: readonly WorkerManifestValidation[];
  readonly sizeBytes?: number;
  readonly loadedAt: string;
}

export interface WorkerManifestLoaderOptions {
  readonly manifestPath?: string;
  readonly allowedPatterns?: readonly string[];
  readonly maxWorkers?: number;
}

const DEFAULT_MANIFEST_PATH = 'cmos/workers/manifest.yaml';
const DEFAULT_ALLOWED_PATTERNS = ['rsip', 'delegation', 'boomerang'] as const;
const MANIFEST_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const DEFAULT_MAX_WORKERS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export class WorkerManifestLoader {
  private readonly manifestPath: string;
  private readonly allowedPatterns: readonly string[];
  private readonly maxWorkers: number;

  constructor(options: WorkerManifestLoaderOptions = {}) {
    this.manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
    this.allowedPatterns = options.allowedPatterns ?? DEFAULT_ALLOWED_PATTERNS;
    this.maxWorkers = Math.max(1, options.maxWorkers ?? DEFAULT_MAX_WORKERS);
  }

  async load(projectRoot: string): Promise<WorkerManifestLoadResult> {
    const loader = new SecureYAMLLoader({ baseDir: projectRoot });
    let absoluteManifestPath: string;
    const validations: WorkerManifestValidation[] = [];

    try {
      absoluteManifestPath = loader.sanitizePath(this.manifestPath);
    } catch (error) {
      if (error instanceof PathTraversalError) {
        return {
          manifestPath: this.manifestPath,
          relativePath: this.manifestPath,
          loaded: false,
          validations: [
            {
              level: 'error',
              code: 'WORKER_MANIFEST_PATH_INVALID',
              message: `Manifest path escapes project root: ${this.manifestPath}`,
            },
          ],
          loadedAt: new Date().toISOString(),
        };
      }
      throw error;
    }

    let rawManifest: unknown;
    try {
      rawManifest = await loader.load<unknown>(this.manifestPath);
    } catch (error) {
      const loadError = error as Error;
      if (loadError instanceof IOError && loadError.code === 'IO_NOT_FOUND') {
        return {
          manifestPath: absoluteManifestPath,
          relativePath: path.relative(projectRoot, absoluteManifestPath) || this.manifestPath,
          loaded: false,
          validations: [
            {
              level: 'error',
              code: 'WORKER_MANIFEST_NOT_FOUND',
              message: `Worker manifest not found at ${absoluteManifestPath}`,
            },
          ],
          loadedAt: new Date().toISOString(),
        };
      }

      if (
        loadError instanceof PathTraversalError ||
        loadError instanceof UnsafeYAMLError ||
        loadError instanceof SchemaValidationError
      ) {
        return {
          manifestPath: absoluteManifestPath,
          relativePath: path.relative(projectRoot, absoluteManifestPath) || this.manifestPath,
          loaded: false,
          validations: [
            {
              level: 'error',
              code: 'WORKER_MANIFEST_LOAD_FAILED',
              message: loadError.message,
            },
          ],
          loadedAt: new Date().toISOString(),
        };
      }

      return {
        manifestPath: absoluteManifestPath,
        relativePath: path.relative(projectRoot, absoluteManifestPath) || this.manifestPath,
        loaded: false,
        validations: [
          {
            level: 'error',
            code: 'WORKER_MANIFEST_LOAD_FAILED',
            message: loadError.message,
          },
        ],
        loadedAt: new Date().toISOString(),
      };
    }

    const { manifest, manifestValidations } = this.normalizeManifest(rawManifest);
    validations.push(...manifestValidations);

    if (manifest && manifest.workers.length > this.maxWorkers) {
      validations.push({
        level: 'warning',
        code: 'WORKER_MANIFEST_MAX_WORKERS_EXCEEDED',
        message: `Manifest defines ${manifest.workers.length} workers (recommended <= ${this.maxWorkers}).`,
      });
    }

    const loaded = manifest !== null && !validations.some((entry) => entry.level === 'error');
    const sizeBytes = await this.safeStatSize(absoluteManifestPath);

    return {
      manifestPath: absoluteManifestPath,
      relativePath: path.relative(projectRoot, absoluteManifestPath) || this.manifestPath,
      loaded,
      manifest: loaded ? (manifest ?? undefined) : undefined,
      validations,
      sizeBytes: sizeBytes ?? undefined,
      loadedAt: new Date().toISOString(),
    };
  }

  private normalizeManifest(raw: unknown): {
    manifest: WorkerManifest | null;
    manifestValidations: WorkerManifestValidation[];
  } {
    const validations: WorkerManifestValidation[] = [];
    if (!isRecord(raw)) {
      return {
        manifest: null,
        manifestValidations: [
          {
            level: 'error',
            code: 'WORKER_MANIFEST_INVALID_FORMAT',
            message: 'Worker manifest must be an object.',
          },
        ],
      };
    }

    const manifestVersion = typeof raw.manifest_version === 'string' ? raw.manifest_version : '';
    if (!MANIFEST_VERSION_PATTERN.test(manifestVersion)) {
      validations.push({
        level: 'error',
        code: 'WORKER_MANIFEST_VERSION_INVALID',
        message: 'manifest_version must be a SemVer string.',
      });
    }

    const patternSupportRaw = isRecord(raw.pattern_support) ? raw.pattern_support : {};
    const mutuallyExclusive = Boolean(patternSupportRaw.mutually_exclusive);
    const allowedPatterns = toStringArray(patternSupportRaw.allowed_patterns);
    const fallbackPatternRaw =
      typeof patternSupportRaw.fallback_pattern === 'string'
        ? patternSupportRaw.fallback_pattern.trim()
        : undefined;

    if (allowedPatterns.length === 0) {
      validations.push({
        level: 'error',
        code: 'WORKER_MANIFEST_PATTERNS_EMPTY',
        message: 'pattern_support.allowed_patterns must include at least one pattern.',
      });
    }

    const unsupportedPatterns = allowedPatterns.filter(
      (pattern) => !this.allowedPatterns.includes(pattern)
    );
    for (const pattern of unsupportedPatterns) {
      validations.push({
        level: 'warning',
        code: 'WORKER_MANIFEST_PATTERN_UNRECOGNIZED',
        message: `Pattern "${pattern}" is not recognized by this runtime.`,
      });
    }

    const patternSupport: WorkerPatternSupport = {
      mutuallyExclusive,
      allowedPatterns,
      fallbackPattern:
        fallbackPatternRaw && fallbackPatternRaw.length > 0 ? fallbackPatternRaw : undefined,
    };

    const workerEntries = Array.isArray(raw.workers) ? raw.workers : [];
    if (workerEntries.length === 0) {
      validations.push({
        level: 'error',
        code: 'WORKER_MANIFEST_NO_WORKERS',
        message: 'Worker manifest must define at least one worker.',
      });
    }

    const workers: WorkerDefinition[] = [];
    const seenWorkerIds = new Set<string>();

    for (const entry of workerEntries) {
      if (!isRecord(entry)) {
        validations.push({
          level: 'error',
          code: 'WORKER_ENTRY_INVALID',
          message: 'Worker entry must be an object.',
        });
        continue;
      }

      const rawWorkerId = typeof entry.workerId === 'string' ? entry.workerId : '';
      const workerId = rawWorkerId.trim();
      const workerLabel = workerId.length > 0 ? workerId : '(unknown)';
      let entryHasError = false;

      if (workerId.length === 0) {
        validations.push({
          level: 'error',
          code: 'WORKER_ID_MISSING',
          message: 'Worker entry missing workerId.',
        });
        entryHasError = true;
      } else if (seenWorkerIds.has(workerId)) {
        validations.push({
          level: 'error',
          code: 'WORKER_ID_DUPLICATE',
          message: `Duplicate workerId "${workerId}" detected.`,
          workerId,
        });
        entryHasError = true;
      } else {
        seenWorkerIds.add(workerId);
      }

      const name =
        typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : '';
      if (name.length === 0) {
        validations.push({
          level: 'error',
          code: 'WORKER_NAME_MISSING',
          message: `Worker "${workerLabel}" missing name.`,
          workerId: workerId.length > 0 ? workerId : undefined,
        });
        entryHasError = true;
      }

      const description =
        typeof entry.description === 'string' && entry.description.trim().length > 0
          ? entry.description.trim()
          : undefined;

      const templatePath =
        typeof entry.template_path === 'string' ? entry.template_path.trim() : '';
      if (!templatePath || templatePath.includes('..') || path.isAbsolute(templatePath)) {
        validations.push({
          level: 'error',
          code: 'WORKER_TEMPLATE_PATH_INVALID',
          message: `Worker "${workerLabel}" has invalid template_path "${entry.template_path}".`,
          workerId: workerId.length > 0 ? workerId : undefined,
        });
        entryHasError = true;
      } else if (!templatePath.startsWith('cmos/workers/')) {
        validations.push({
          level: 'warning',
          code: 'WORKER_TEMPLATE_PATH_NONSTANDARD',
          message: `Worker "${workerLabel}" template_path should reside under cmos/workers/.`,
          workerId: workerId.length > 0 ? workerId : undefined,
        });
      }

      const capabilities = toStringArray(entry.capabilities);
      if (capabilities.length === 0) {
        validations.push({
          level: 'warning',
          code: 'WORKER_CAPABILITIES_EMPTY',
          message: `Worker "${workerLabel}" defines no capabilities.`,
          workerId: workerId.length > 0 ? workerId : undefined,
        });
      }

      const patternsRaw = isRecord(entry.patterns) ? entry.patterns : {};
      const supports = toStringArray(patternsRaw.supports);

      const unsupportedWorkerPatterns = supports.filter(
        (pattern) => !allowedPatterns.includes(pattern)
      );
      for (const pattern of unsupportedWorkerPatterns) {
        validations.push({
          level: 'error',
          code: 'WORKER_PATTERN_UNSUPPORTED',
          message: `Worker "${workerLabel}" references unsupported pattern "${pattern}".`,
          workerId: workerId.length > 0 ? workerId : undefined,
        });
        entryHasError = true;
      }

      const constraintsRaw = isRecord(entry.constraints) ? entry.constraints : {};
      const maxConcurrent =
        typeof constraintsRaw.max_concurrent === 'number' &&
        Number.isFinite(constraintsRaw.max_concurrent)
          ? Math.floor(constraintsRaw.max_concurrent)
          : NaN;
      if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
        validations.push({
          level: 'error',
          code: 'WORKER_MAX_CONCURRENT_INVALID',
          message: `Worker "${workerLabel}" must specify constraints.max_concurrent >= 1.`,
          workerId: workerId.length > 0 ? workerId : undefined,
        });
        entryHasError = true;
      }

      const requiredTools = toStringArray(constraintsRaw.required_tools);
      const timeoutSeconds =
        typeof constraintsRaw.timeout_seconds === 'number' &&
        Number.isFinite(constraintsRaw.timeout_seconds) &&
        constraintsRaw.timeout_seconds > 0
          ? Math.floor(constraintsRaw.timeout_seconds)
          : undefined;
      const tokenBudget =
        typeof constraintsRaw.token_budget === 'number' &&
        Number.isFinite(constraintsRaw.token_budget) &&
        constraintsRaw.token_budget > 0
          ? Math.floor(constraintsRaw.token_budget)
          : undefined;

      const telemetryRaw = isRecord(entry.telemetry) ? entry.telemetry : undefined;
      const telemetryEmits = telemetryRaw ? toStringArray(telemetryRaw.emits) : [];
      if (telemetryRaw && telemetryEmits.length === 0) {
        validations.push({
          level: 'warning',
          code: 'WORKER_TELEMETRY_EMPTY',
          message: `Worker "${workerLabel}" defines telemetry but no events.`,
          workerId: workerId.length > 0 ? workerId : undefined,
        });
      }

      if (!entryHasError && workerId.length > 0) {
        workers.push({
          workerId,
          name,
          description,
          templatePath,
          capabilities,
          patterns: {
            supports,
          },
          constraints: {
            requiredTools,
            maxConcurrent: Number.isFinite(maxConcurrent) ? maxConcurrent : 1,
            timeoutSeconds,
            tokenBudget,
          },
          telemetry: telemetryEmits.length > 0 ? { emits: telemetryEmits } : undefined,
        });
      }
    }

    return {
      manifest:
        validations.some((entry) => entry.level === 'error') ||
        !MANIFEST_VERSION_PATTERN.test(manifestVersion)
          ? null
          : {
              version: manifestVersion,
              patternSupport,
              workers,
            },
      manifestValidations: validations,
    };
  }

  private async safeStatSize(absolutePath: string): Promise<number | undefined> {
    try {
      const stats = await fs.stat(absolutePath);
      return stats.size;
    } catch {
      return undefined;
    }
  }
}

export const __test__ = {
  toStringArray,
  isRecord,
};
