import { promises as fs } from 'fs';
import { constants as fsConstants } from 'fs';
import path from 'path';

import { pathExists } from '../utils/fs';

export type AgentsMdValidationLevel = 'info' | 'warning' | 'error';

export type AgentsMdValidationAction = 'continue' | 'block';

export interface AgentsMdValidation {
  readonly level: AgentsMdValidationLevel;
  readonly code: string;
  readonly message: string;
  readonly action: AgentsMdValidationAction;
}

export type AgentsMdSource = 'configured' | 'fallback';

export type AgentsMdLoadFailureReason = 'not_found' | 'not_readable' | 'empty';

export interface AgentsMdLoadResult {
  readonly path: string;
  readonly relativePath: string;
  readonly source: AgentsMdSource;
  readonly loaded: boolean;
  readonly reason?: AgentsMdLoadFailureReason;
  readonly content?: string;
  readonly sections?: Record<string, string>;
  readonly version?: string;
  readonly sizeBytes?: number;
  readonly validations: AgentsMdValidation[];
  readonly candidatePaths: readonly string[];
  readonly contextPatch: ProjectContextPatch;
  readonly loadedAt: string;
}

export interface AgentsMdLoaderOptions {
  readonly cacheTtlMs?: number;
  readonly defaultPath?: string;
  readonly recommendedSections?: readonly string[];
}

export interface AgentsMdLoadOptions {
  readonly forceRefresh?: boolean;
}

export interface ProjectContext {
  readonly working_memory?: {
    agents_md_path?: string;
    agents_md_loaded?: boolean;
    agents_md_version?: string;
  };
}

export interface ProjectContextPatch {
  readonly working_memory: {
    agents_md_path: string;
    agents_md_loaded: boolean;
    agents_md_version: string;
  };
}

interface CandidatePath {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly source: AgentsMdSource;
}

interface AttemptResult {
  readonly loaded: boolean;
  readonly reason?: AgentsMdLoadFailureReason;
  readonly content?: string;
  readonly sections?: Record<string, string>;
  readonly version?: string;
  readonly sizeBytes?: number;
  readonly validations: AgentsMdValidation[];
}

interface CacheEntry {
  readonly timestamp: number;
  readonly result: AttemptResult;
}

const DEFAULT_RECOMMENDED_SECTIONS: readonly string[] = [
  'Project Overview',
  'Build & Development Commands',
  'AI Agent Specific Instructions',
];

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

const VERSION_CAPTURE_REGEX = /\*\*Version\*\*:\s*([^\s]+)/i;

/**
 * Loader for CMOS-style agents.md files (B8.1).
 *
 * Resolves the configured path, validates file access, parses recommended sections,
 * and produces a context patch suitable for PROJECT_CONTEXT.json updates.
 */
export class AgentsMdLoader {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly defaultPath: string;
  private readonly recommendedSections: readonly string[];

  constructor(options: AgentsMdLoaderOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.defaultPath = options.defaultPath ?? './agents.md';
    this.recommendedSections = options.recommendedSections ?? DEFAULT_RECOMMENDED_SECTIONS;
  }

  /**
   * Load agents.md using PROJECT_CONTEXT overrides and graceful fallbacks.
   */
  async load(
    projectRoot: string,
    projectContext?: ProjectContext,
    options: AgentsMdLoadOptions = {}
  ): Promise<AgentsMdLoadResult> {
    const { forceRefresh = false } = options;
    const candidates = this.buildCandidatePaths(projectRoot, projectContext);
    const candidateRelativePaths = candidates.map((candidate) => candidate.relativePath);
    const aggregatedValidations: AgentsMdValidation[] = [];

    for (const candidate of candidates) {
      const cachedAttempt = this.getCachedAttempt(candidate.absolutePath, forceRefresh);
      if (cachedAttempt) {
        aggregatedValidations.push(...cachedAttempt.validations);
        const result = this.composeFinalResult(
          candidate,
          cachedAttempt,
          aggregatedValidations,
          candidateRelativePaths
        );
        return result;
      }

      const attempt = await this.attemptLoad(candidate);

      if (attempt.reason !== 'not_found') {
        this.cache.set(candidate.absolutePath, {
          timestamp: Date.now(),
          result: attempt,
        });
      }

      aggregatedValidations.push(...attempt.validations);

      const result = this.composeFinalResult(
        candidate,
        attempt,
        aggregatedValidations,
        candidateRelativePaths
      );

      if (attempt.loaded || this.hasBlockingValidation(attempt.validations)) {
        return result;
      }
    }

    // No candidates succeeded; synthesize a final result using aggregated validations.
    const fallbackCandidate =
      candidates[candidates.length - 1] ??
      ({
        absolutePath: path.resolve(projectRoot, this.defaultPath),
        relativePath: this.defaultPath,
        source: 'fallback',
      } as CandidatePath);

    const finalAttempt: AttemptResult = {
      loaded: false,
      reason: 'not_found',
      validations:
        aggregatedValidations.length > 0
          ? aggregatedValidations
          : [
              {
                level: 'warning',
                code: 'AGENTS_MD_NOT_FOUND',
                message: `agents.md not found at ${fallbackCandidate.absolutePath}`,
                action: 'continue',
              },
            ],
    };

    const result = this.composeFinalResult(
      fallbackCandidate,
      finalAttempt,
      aggregatedValidations.length > 0 ? aggregatedValidations : finalAttempt.validations,
      candidateRelativePaths.length > 0 ? candidateRelativePaths : [fallbackCandidate.relativePath]
    );

    return result;
  }

  /**
   * Clear cached load results. Useful for tests.
   */
  clearCache(pathToClear?: string): void {
    if (typeof pathToClear === 'string') {
      this.cache.delete(path.resolve(pathToClear));
      return;
    }
    this.cache.clear();
  }

  private buildCandidatePaths(
    projectRoot: string,
    projectContext?: ProjectContext
  ): CandidatePath[] {
    const base = projectRoot || '.';
    const candidates: CandidatePath[] = [];
    const seen = new Set<string>();

    const configured = projectContext?.working_memory?.agents_md_path;
    if (configured && typeof configured === 'string' && configured.trim().length > 0) {
      const relativePath = configured.trim();
      const absolutePath = path.resolve(base, relativePath);
      candidates.push({ absolutePath, relativePath, source: 'configured' });
      seen.add(absolutePath);
    }

    const fallbackRelative = this.defaultPath;
    const fallbackAbsolute = path.resolve(base, fallbackRelative);
    if (!seen.has(fallbackAbsolute)) {
      candidates.push({
        absolutePath: fallbackAbsolute,
        relativePath: fallbackRelative,
        source: 'fallback',
      });
    }

    return candidates;
  }

  private getCachedAttempt(pathKey: string, forceRefresh: boolean): AttemptResult | undefined {
    if (forceRefresh) {
      return undefined;
    }

    const entry = this.cache.get(pathKey);
    if (!entry) {
      return undefined;
    }

    if (Date.now() - entry.timestamp > this.cacheTtlMs) {
      this.cache.delete(pathKey);
      return undefined;
    }

    return entry.result;
  }

  private composeFinalResult(
    candidate: CandidatePath,
    attempt: AttemptResult,
    aggregatedValidations: readonly AgentsMdValidation[],
    candidateRelativePaths: readonly string[]
  ): AgentsMdLoadResult {
    const validations = [...aggregatedValidations];
    const version = attempt.version ?? '1.0.0';
    const loadedAt = new Date().toISOString();

    const result: AgentsMdLoadResult = {
      path: candidate.absolutePath,
      relativePath: candidate.relativePath,
      source: candidate.source,
      loaded: attempt.loaded,
      reason: attempt.reason,
      content: attempt.content,
      sections: attempt.sections,
      version,
      sizeBytes: attempt.sizeBytes,
      validations,
      candidatePaths: candidateRelativePaths,
      contextPatch: this.buildContextPatch(candidate.relativePath, {
        loaded: attempt.loaded,
        version,
        validations,
      }),
      loadedAt,
    };

    return result;
  }

  private buildContextPatch(
    relativePath: string,
    summary: { loaded: boolean; version: string; validations: readonly AgentsMdValidation[] }
  ): ProjectContextPatch {
    const blocking = this.hasBlockingValidation(summary.validations);

    return {
      working_memory: {
        agents_md_path: relativePath,
        agents_md_loaded: summary.loaded && !blocking,
        agents_md_version: summary.version ?? '1.0.0',
      },
    };
  }

  private hasBlockingValidation(validations: readonly AgentsMdValidation[]): boolean {
    return validations.some(
      (validation) => validation.action === 'block' || validation.level === 'error'
    );
  }

  private async attemptLoad(candidate: CandidatePath): Promise<AttemptResult> {
    const validations: AgentsMdValidation[] = [];

    if (!(await pathExists(candidate.absolutePath))) {
      validations.push({
        level: 'warning',
        code: 'AGENTS_MD_NOT_FOUND',
        message: `agents.md not found at ${candidate.absolutePath}`,
        action: 'continue',
      });

      return {
        loaded: false,
        reason: 'not_found',
        validations,
      };
    }

    try {
      await fs.access(candidate.absolutePath, fsConstants.R_OK);
    } catch (error) {
      validations.push({
        level: 'error',
        code: 'AGENTS_MD_NOT_READABLE',
        message: `Cannot read agents.md at ${candidate.absolutePath}: ${this.toErrorMessage(error)}`,
        action: 'block',
      });

      return {
        loaded: false,
        reason: 'not_readable',
        validations,
      };
    }

    const started = Date.now();
    const content = await fs.readFile(candidate.absolutePath, 'utf-8');
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const trimmed = content.trim();

    if (trimmed.length === 0) {
      validations.push({
        level: 'warning',
        code: 'AGENTS_MD_EMPTY',
        message: 'agents.md is empty',
        action: 'continue',
      });
    }

    const sections = parseMarkdownSections(content);

    if (Object.keys(sections).length === 0) {
      validations.push({
        level: 'warning',
        code: 'AGENTS_MD_NO_SECTIONS',
        message: 'agents.md has no parseable sections',
        action: 'continue',
      });
    }

    for (const section of this.recommendedSections) {
      if (!sections[section]) {
        validations.push({
          level: 'info',
          code: 'AGENTS_MD_MISSING_SECTION',
          message: `Recommended section missing: ${section}`,
          action: 'continue',
        });
      }
    }

    const rawVersion = extractVersion(content) ?? '1.0.0';
    let version = rawVersion;
    if (!VERSION_PATTERN.test(rawVersion)) {
      validations.push({
        level: 'warning',
        code: 'AGENTS_MD_INVALID_VERSION',
        message: `agents.md version "${rawVersion}" is not a valid semantic version; defaulting to 1.0.0`,
        action: 'continue',
      });
      version = '1.0.0';
    }

    const durationMs = Date.now() - started;

    validations.push({
      level: 'info',
      code: 'AGENTS_MD_LOAD_METRICS',
      message: `agents.md loaded (${sizeBytes} bytes) in ${durationMs}ms`,
      action: 'continue',
    });

    return {
      loaded: true,
      content,
      sections,
      version,
      sizeBytes,
      validations,
    };
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

/**
 * Parse markdown content into a "section" map keyed by "##" headings.
 */
export function parseMarkdownSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  let currentTitle: string | null = null;
  let buffer: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = /^##\s+(.+)$/.exec(line);

    if (headingMatch) {
      if (currentTitle) {
        sections[currentTitle] = buffer.join('\n').trim();
      }
      currentTitle = headingMatch[1].trim();
      buffer = [];
      continue;
    }

    if (currentTitle) {
      buffer.push(rawLine);
    }
  }

  if (currentTitle) {
    sections[currentTitle] = buffer.join('\n').trim();
  }

  return sections;
}

export function extractVersion(content: string): string | undefined {
  const match = VERSION_CAPTURE_REGEX.exec(content);
  return match ? match[1].trim() : undefined;
}
