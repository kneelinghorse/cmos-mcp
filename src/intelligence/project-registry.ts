/**
 * ProjectRegistry - Persistent registry for CMOS project paths
 *
 * Eliminates cross-project contamination by maintaining a registry of known
 * CMOS projects. Used as fallback in resolveProjectRoot() when explicit
 * path and env var are not available (e.g., Claude Desktop scenario).
 *
 * Registry persists to ~/.config/cmos-mcp/project-registry.json
 *
 * @module intelligence/project-registry
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { pathExists, ensureDir, writeFileAtomic } from '../utils/fs';
import { CmosDetector } from './cmos-detector';

/**
 * Override the default `~/.config/cmos-mcp` config directory. When set (and
 * no explicit `configDir` option is passed), the registry reads/writes here
 * instead of the user's home-config path. Used by Jest globalSetup to keep
 * test runs from polluting the real registry.
 */
export const CMOS_CONFIG_DIR_ENV = 'CMOS_CONFIG_DIR';

/**
 * Registered project entry
 */
export interface RegisteredProject {
  /** Absolute path to project root */
  projectRoot: string;

  /** Optional human-readable name */
  name?: string;

  /** When the project was registered */
  registeredAt: string;

  /** When the project was last accessed */
  lastAccessedAt: string;

  /** Optional project metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Project validation result
 */
export interface ProjectValidation {
  /** The project entry */
  project: RegisteredProject;

  /** Whether the project root directory exists */
  exists: boolean;

  /** Whether the CMOS database exists */
  hasCmosDatabase: boolean;

  /** Validation status */
  status: 'active' | 'stale' | 'missing';

  /** Human-readable status message */
  message: string;
}

/**
 * Registry file structure
 */
interface RegistryFile {
  version: number;
  defaultProject?: string;
  projects: Record<string, RegisteredProject>;
  updatedAt: string;
}

/**
 * Options for ProjectRegistry
 */
export interface ProjectRegistryOptions {
  /** Override config directory (default: ~/.config/cmos-mcp) */
  configDir?: string;

  /** Override registry filename (default: project-registry.json) */
  registryFilename?: string;
}

/**
 * Result of project registration
 */
export interface RegisterResult {
  success: boolean;
  project?: RegisteredProject;
  message: string;
  wasAlreadyRegistered?: boolean;
}

/**
 * Result of project unregistration
 */
export interface UnregisterResult {
  success: boolean;
  message: string;
  wasDefault?: boolean;
}

/**
 * ProjectRegistry - Manages persistent registry of CMOS projects
 *
 * Usage:
 * ```typescript
 * const registry = await ProjectRegistry.create();
 *
 * // Register a project
 * await registry.register('/path/to/project');
 *
 * // List all registered projects
 * const projects = await registry.list();
 *
 * // Validate all projects
 * const validations = await registry.validate();
 *
 * // Get default project
 * const defaultProject = await registry.getDefault();
 *
 * // Set default project
 * await registry.setDefault('/path/to/project');
 * ```
 */
export class ProjectRegistry {
  private static instance?: ProjectRegistry;

  private readonly configDir: string;
  private readonly registryPath: string;
  private cache: RegistryFile | null = null;

  private constructor(options: ProjectRegistryOptions = {}) {
    this.configDir =
      options.configDir ??
      process.env[CMOS_CONFIG_DIR_ENV] ??
      path.join(os.homedir(), '.config', 'cmos-mcp');
    const registryFilename = options.registryFilename ?? 'project-registry.json';
    this.registryPath = path.join(this.configDir, registryFilename);
  }

  /**
   * Get singleton instance of ProjectRegistry
   */
  static getInstance(options?: ProjectRegistryOptions): ProjectRegistry {
    if (!ProjectRegistry.instance) {
      ProjectRegistry.instance = new ProjectRegistry(options);
    }
    return ProjectRegistry.instance;
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    ProjectRegistry.instance = undefined;
  }

  /**
   * Create a new ProjectRegistry instance (async factory)
   *
   * Ensures config directory exists.
   */
  static async create(options?: ProjectRegistryOptions): Promise<ProjectRegistry> {
    const registry = ProjectRegistry.getInstance(options);
    await ensureDir(registry.configDir);
    return registry;
  }

  /**
   * Get the registry file path
   */
  get path(): string {
    return this.registryPath;
  }

  /**
   * Register a project in the registry
   *
   * @param projectRoot - Absolute path to project root
   * @param options - Optional registration options
   * @returns Registration result
   */
  async register(
    projectRoot: string,
    options: { name?: string; setAsDefault?: boolean; metadata?: Record<string, unknown> } = {}
  ): Promise<RegisterResult> {
    const resolvedPath = path.resolve(projectRoot);

    // Verify the project has CMOS
    const detector = CmosDetector.getInstance();
    const detection = await detector.detect(resolvedPath, { forceRefresh: true });

    if (!detection.hasCmosDirectory || !detection.hasDatabase) {
      return {
        success: false,
        message: `No CMOS database found at ${resolvedPath}. Ensure cmos/db/cmos.sqlite exists.`,
      };
    }

    const registry = await this.loadRegistry();
    const existing = registry.projects[resolvedPath];
    const now = new Date().toISOString();

    const project: RegisteredProject = {
      projectRoot: resolvedPath,
      name: options.name ?? existing?.name ?? path.basename(resolvedPath),
      registeredAt: existing?.registeredAt ?? now,
      lastAccessedAt: now,
      metadata: options.metadata ?? existing?.metadata,
    };

    registry.projects[resolvedPath] = project;
    registry.updatedAt = now;

    if (options.setAsDefault) {
      registry.defaultProject = resolvedPath;
    }

    await this.saveRegistry(registry);

    return {
      success: true,
      project,
      message: existing
        ? `Updated project registration: ${project.name}`
        : `Registered project: ${project.name}`,
      wasAlreadyRegistered: !!existing,
    };
  }

  /**
   * Unregister a project from the registry
   *
   * @param projectRoot - Absolute path to project root
   * @returns Unregistration result
   */
  async unregister(projectRoot: string): Promise<UnregisterResult> {
    const resolvedPath = path.resolve(projectRoot);
    const registry = await this.loadRegistry();

    if (!registry.projects[resolvedPath]) {
      return {
        success: false,
        message: `Project not found in registry: ${resolvedPath}`,
      };
    }

    const wasDefault = registry.defaultProject === resolvedPath;
    delete registry.projects[resolvedPath];

    if (wasDefault) {
      registry.defaultProject = undefined;
    }

    registry.updatedAt = new Date().toISOString();
    await this.saveRegistry(registry);

    return {
      success: true,
      message: `Unregistered project: ${resolvedPath}`,
      wasDefault,
    };
  }

  /**
   * List all registered projects
   *
   * @returns Array of registered projects
   */
  async list(): Promise<RegisteredProject[]> {
    const registry = await this.loadRegistry();
    return Object.values(registry.projects);
  }

  /**
   * Get a specific project by path
   *
   * @param projectRoot - Absolute path to project root
   * @returns The project if found, undefined otherwise
   */
  async getProject(projectRoot: string): Promise<RegisteredProject | undefined> {
    const resolvedPath = path.resolve(projectRoot);
    const registry = await this.loadRegistry();
    return registry.projects[resolvedPath];
  }

  /**
   * Get the default project
   *
   * @returns The default project if set, undefined otherwise
   */
  async getDefault(): Promise<RegisteredProject | undefined> {
    const registry = await this.loadRegistry();
    if (!registry.defaultProject) {
      return undefined;
    }
    return registry.projects[registry.defaultProject];
  }

  /**
   * Set the default project
   *
   * @param projectRoot - Absolute path to project root (must be registered)
   * @returns True if successful, false if project not registered
   */
  async setDefault(projectRoot: string): Promise<boolean> {
    const resolvedPath = path.resolve(projectRoot);
    const registry = await this.loadRegistry();

    if (!registry.projects[resolvedPath]) {
      return false;
    }

    registry.defaultProject = resolvedPath;
    registry.updatedAt = new Date().toISOString();
    await this.saveRegistry(registry);

    return true;
  }

  /**
   * Clear the default project
   */
  async clearDefault(): Promise<void> {
    const registry = await this.loadRegistry();
    registry.defaultProject = undefined;
    registry.updatedAt = new Date().toISOString();
    await this.saveRegistry(registry);
  }

  /**
   * Validate all registered projects
   *
   * Checks each project for:
   * - Directory existence
   * - CMOS database presence
   *
   * @returns Array of validation results
   */
  async validate(): Promise<ProjectValidation[]> {
    const registry = await this.loadRegistry();
    const detector = CmosDetector.getInstance();
    const validations: ProjectValidation[] = [];

    for (const project of Object.values(registry.projects)) {
      const dirExists = await pathExists(project.projectRoot);

      if (!dirExists) {
        validations.push({
          project,
          exists: false,
          hasCmosDatabase: false,
          status: 'missing',
          message: `Project directory does not exist: ${project.projectRoot}`,
        });
        continue;
      }

      const detection = await detector.detect(project.projectRoot, { forceRefresh: true });

      if (!detection.hasCmosDirectory || !detection.hasDatabase) {
        validations.push({
          project,
          exists: true,
          hasCmosDatabase: false,
          status: 'stale',
          message: `CMOS database no longer exists at: ${project.projectRoot}`,
        });
        continue;
      }

      validations.push({
        project,
        exists: true,
        hasCmosDatabase: true,
        status: 'active',
        message: `Project is active: ${project.name ?? project.projectRoot}`,
      });
    }

    return validations;
  }

  /**
   * Remove stale and missing projects from registry
   *
   * @returns Number of projects removed
   */
  async prune(): Promise<number> {
    const validations = await this.validate();
    const registry = await this.loadRegistry();
    let removed = 0;

    for (const validation of validations) {
      if (validation.status !== 'active') {
        delete registry.projects[validation.project.projectRoot];
        if (registry.defaultProject === validation.project.projectRoot) {
          registry.defaultProject = undefined;
        }
        removed++;
      }
    }

    if (removed > 0) {
      registry.updatedAt = new Date().toISOString();
      await this.saveRegistry(registry);
    }

    return removed;
  }

  /**
   * Update last accessed time for a project
   *
   * @param projectRoot - Absolute path to project root
   */
  async touch(projectRoot: string): Promise<void> {
    const resolvedPath = path.resolve(projectRoot);
    const registry = await this.loadRegistry();

    if (registry.projects[resolvedPath]) {
      registry.projects[resolvedPath].lastAccessedAt = new Date().toISOString();
      registry.updatedAt = new Date().toISOString();
      await this.saveRegistry(registry);
    }
  }

  /**
   * Clear the in-memory cache (for testing)
   */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * Load registry from disk
   */
  private async loadRegistry(): Promise<RegistryFile> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const exists = await pathExists(this.registryPath);
      if (!exists) {
        this.cache = this.createEmptyRegistry();
        return this.cache;
      }

      const content = await fs.readFile(this.registryPath, 'utf-8');
      const data = JSON.parse(content) as RegistryFile;

      // Validate structure
      if (!data.version || !data.projects) {
        this.cache = this.createEmptyRegistry();
        return this.cache;
      }

      this.cache = data;
      return this.cache;
    } catch {
      // If file is corrupted, start fresh
      this.cache = this.createEmptyRegistry();
      return this.cache;
    }
  }

  /**
   * Save registry to disk
   */
  private async saveRegistry(registry: RegistryFile): Promise<void> {
    this.cache = registry;
    await ensureDir(this.configDir);
    const content = JSON.stringify(registry, null, 2);
    await writeFileAtomic(this.registryPath, content, { mode: 0o600 });
  }

  /**
   * Create empty registry structure
   */
  private createEmptyRegistry(): RegistryFile {
    return {
      version: 1,
      projects: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

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
 * 3. Registry fallback (default project)
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

    // Auto-register if enabled
    if (autoRegister) {
      try {
        const registry = await ProjectRegistry.create();
        const existing = await registry.getProject(cwd);
        if (!existing) {
          await registry.register(cwd);
          result.autoRegistered = true;
          if (!silent) {
            console.error(`[CMOS] Auto-registered project: ${cwd}`);
          }
        } else {
          await registry.touch(cwd);
        }
      } catch {
        // Ignore registry errors during auto-discovery
      }
    }

    return result;
  }

  // Step 4: Registry fallback
  try {
    const registry = await ProjectRegistry.create();
    const defaultProject = await registry.getDefault();

    if (defaultProject) {
      // Verify the default project still has CMOS
      const defaultDetection = await detector.detect(defaultProject.projectRoot, {
        forceRefresh: true,
      });
      if (defaultDetection.hasCmosDirectory && defaultDetection.hasDatabase) {
        await registry.touch(defaultProject.projectRoot);
        return {
          projectRoot: defaultProject.projectRoot,
          source: 'registry',
          message: `Using default project from registry: ${defaultProject.name ?? defaultProject.projectRoot}`,
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
