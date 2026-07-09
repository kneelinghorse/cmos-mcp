// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s80-m01 — the graph-native project-root resolver, relocated out of the
// ABOUTME: doomed JSON project-registry.ts. Reads/writes ONLY ProjectGraphRegistry.

/**
 * Project-root resolution (s80-m01).
 *
 * `resolveProjectRootEnhanced` is the 4-step priority chain the tool clients fall
 * back to when no explicit `projectRoot`/`dbPath` is supplied. It was carved out of
 * `intelligence/project-registry.ts` in Sprint 80 so the resolver reads/writes ONLY
 * the authoritative {@link ProjectGraphRegistry} — the JSON `ProjectRegistry` and
 * its derivation layer are deleted in s80-m02. That relocation also dissolves the
 * former module cycle (the resolver used to lazy-`import()` the graph registry to
 * avoid `project-registry.ts` ↔ `project-graph-registry.ts` recursion); a static
 * import is safe now that the resolver no longer lives in `project-registry.ts`.
 *
 * @module intelligence/project-resolution
 */

import path from 'path';
import { CmosDetector } from './cmos-detector';
import { ProjectGraphRegistry } from './project-graph-registry';

/**
 * Result of project root resolution
 */
export interface ProjectResolutionResult {
  /** Resolved project root path */
  projectRoot: string;

  /** How the project root was resolved */
  source: 'explicit' | 'env' | 'auto-discover' | 'registry' | 'cwd';

  /** Whether a new project was auto-registered */
  autoRegistered?: boolean;

  /** Human-readable explanation */
  message: string;
}

/**
 * Error thrown when project resolution fails
 */
export class ProjectResolutionError extends Error {
  constructor(
    message: string,
    public readonly suggestion: string
  ) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}

/**
 * Resolve project root with a 4-step priority chain.
 *
 * Priority:
 * 1. Explicit parameter
 * 2. Auto-discover from cwd (detect cmos/db/cmos.sqlite)
 * 3. Registry fallback (graph default project)
 * 4. Error with actionable guidance
 *
 * @deprecated Use `resolveSenderContext` from `src/intelligence/sender-context.ts`
 *   for any dispatcher or dashboard-bound call site. This function remains
 *   available for direct `CmosDatabaseClient.create` fallbacks and for tests,
 *   but should not be called from tool dispatchers. Sprint 53 m02 removed the
 *   former Step 2 (`CMOS_PROJECT_ROOT` env var) because it was the structural
 *   source of cross-project mis-attribution (Sprint 32 / 52 / 53 P0s).
 *
 * @param explicitRoot - Explicitly provided project root
 * @param options - Resolution options
 * @returns Resolution result with source and path
 * @throws ProjectResolutionError if no project can be resolved
 */
export async function resolveProjectRootEnhanced(
  explicitRoot?: string,
  options: { autoRegister?: boolean; silent?: boolean } = {}
): Promise<ProjectResolutionResult> {
  const { autoRegister = true, silent = false } = options;

  // Step 1: Explicit parameter
  if (explicitRoot) {
    const resolvedPath = path.resolve(explicitRoot);
    return {
      projectRoot: resolvedPath,
      source: 'explicit',
      message: `Using explicitly provided project root: ${resolvedPath}`,
    };
  }

  // Step 2 (removed): CMOS_PROJECT_ROOT env-var fallback. See Sprint 53 m02
  // rationale in the function docblock. The env var is still read at
  // `src/index.ts:17` for .env bootstrap but is never consulted here.

  // Step 3: Auto-discover from cwd
  const cwd = process.cwd();
  const detector = CmosDetector.getInstance();
  const detection = await detector.detect(cwd);

  if (detection.hasCmosDirectory && detection.hasDatabase) {
    const result: ProjectResolutionResult = {
      projectRoot: cwd,
      source: 'auto-discover',
      message: `Auto-discovered CMOS project at: ${cwd}`,
    };

    // Auto-register if enabled. s80-m01: write the AUTHORITATIVE project-graph
    // registry directly — the JSON mirror + its deriveJson() re-materialization
    // are gone (m02). A store already present at this path just gets touched.
    if (autoRegister) {
      try {
        const graph = await ProjectGraphRegistry.create();
        const existingId = graph.getByStorePath(cwd);
        if (!existingId) {
          graph.registerStore(cwd);
          result.autoRegistered = true;
          if (!silent) {
            console.error(`[CMOS] Auto-registered project: ${cwd}`);
          }
        } else {
          graph.touch(existingId);
        }
      } catch {
        // Ignore registry errors during auto-discovery
      }
    }

    return result;
  }

  // Step 3: Registry fallback (the graph's default project)
  try {
    const graph = await ProjectGraphRegistry.create();
    const defaultProject = graph.getDefault();

    if (defaultProject) {
      // Verify the default project still has CMOS
      const defaultDetection = await detector.detect(defaultProject.store_path, {
        forceRefresh: true,
      });
      if (defaultDetection.hasCmosDirectory && defaultDetection.hasDatabase) {
        graph.touch(defaultProject.project_id);
        return {
          projectRoot: defaultProject.store_path,
          source: 'registry',
          message: `Using default project from registry: ${defaultProject.name ?? defaultProject.store_path}`,
        };
      }
    }
  } catch {
    // Ignore registry errors
  }

  // Step 4: Error with actionable guidance
  throw new ProjectResolutionError(
    'No CMOS project found. Could not resolve project root.',
    `Options:
  1. Run from a directory containing cmos/db/cmos.sqlite
  2. Provide projectRoot parameter explicitly
  3. Register a default project: cmos_project_register(path, setAsDefault=true)`
  );
}

/**
 * Backward-compatible wrapper that returns just the path
 *
 * For existing code that expects a string return type.
 *
 * @param explicitRoot - Explicitly provided project root
 * @returns Resolved project root path
 * @throws ProjectResolutionError if no project can be resolved
 */
export async function resolveProjectRootPath(explicitRoot?: string): Promise<string> {
  const result = await resolveProjectRootEnhanced(explicitRoot);
  return result.projectRoot;
}
