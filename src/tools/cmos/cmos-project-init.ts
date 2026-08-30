// ABOUTME: Initializes new CMOS workspaces from the seed bundle and creates the SQLite DB.
// ABOUTME: Also scaffolds top-level agent guidance such as CLAUDE.md for fresh projects.

/**
 * cmos_project_init Tool
 *
 * MCP tool for initializing a new CMOS project structure.
 * Copies the full cmos-seed directory and creates a fresh SQLite database.
 *
 * Features:
 * - Copies full seed structure (docs, templates, foundational-docs, context, tiers)
 * - Creates fresh SQLite database from schema.sql
 * - Sets project metadata (name, id, tracelab link)
 * - Optionally creates initial sprint and missions
 * - Idempotent - safe to call on existing project (won't overwrite existing files)
 *
 * @module tools/cmos/cmos-project-init
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CMOS_ERROR_CODES } from './errors';
import { CMOS_SCHEMA, CMOS_SCHEMA_VERSION } from './schema';
import { assertJestDbPathIsolated } from './real-store-guard';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { CmosDetector } from '../../intelligence/cmos-detector';
import { appendWarnings } from './format-warnings';

/**
 * Resolve the path to the cmos-seed directory.
 * Looks relative to the package root (one level up from dist/ or src/).
 */
export function resolveSeedPath(): string | null {
  // When running from dist/: __dirname is <root>/dist/tools/cmos
  // When running from src/: __dirname is <root>/src/tools/cmos
  // Seed is at <root>/cmos-seed/
  const candidates = [
    path.resolve(__dirname, '../../../cmos-seed'), // from dist/tools/cmos or src/tools/cmos
    path.resolve(__dirname, '../../cmos-seed'), // from dist/tools or src/tools
    path.resolve(__dirname, '../cmos-seed'), // from dist or src
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'db', 'schema.sql'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Recursively copy a directory, skipping files that already exist at the destination.
 * Returns lists of created directories and files (relative to cmosDir).
 */
function copySeedDir(
  srcDir: string,
  destDir: string,
  relativeTo: string
): { directories: string[]; files: string[] } {
  const created = { directories: [] as string[], files: [] as string[] };

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    created.directories.push(path.relative(relativeTo, destDir) + '/');
  }

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    // Skip .DS_Store, __pycache__, and SQLite runtime artifacts (we create the DB fresh).
    // -wal and -shm are runtime artifacts of WAL mode that have no business in a seed —
    // when they leak through, sqlite can recover stale state into the new DB.
    if (
      entry.name === '.DS_Store' ||
      entry.name === '__pycache__' ||
      entry.name === 'cmos.sqlite' ||
      entry.name === 'cmos.sqlite-wal' ||
      entry.name === 'cmos.sqlite-shm'
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      const sub = copySeedDir(srcPath, destPath, relativeTo);
      created.directories.push(...sub.directories);
      created.files.push(...sub.files);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
      created.files.push(path.relative(relativeTo, destPath));
    }
  }

  return created;
}

function buildClaudeMd(projectName: string): string {
  const title = projectName.trim().length > 0 ? projectName.trim() : 'This Project';

  return [
    '# CLAUDE.md',
    '',
    `## ${title}`,
    '',
    // s86-m05: this used to say "Read `agents.md` first" — but init does not create a
    // project-root agents.md. It copies the TEMPLATE to cmos/templates/agents.md, so point
    // there and say what to do with it, rather than sending every new project to a file that
    // is not going to be present.
    '- Copy `cmos/templates/agents.md` to this project root and fill it in — it holds the repository-specific rules.',
    '- Use the shared `mcp__cmos-mcp__*` tools for CMOS operations.',
    '- If sender attribution looks wrong, run `cmos_message(action="whoami")` before sending messages.',
    '',
    '## CMOS Attribution',
    '',
    'Note: you do not need a `.env` for CMOS attribution. The shared MCP server resolves your project via MCP roots.',
    'Only set `CMOS_PROJECT_ROOT` when the server itself needs help locating its own `.env` during bootstrap.',
    '',
  ].join('\n');
}

function ensureClaudeMd(projectRoot: string, projectName: string): boolean {
  const claudePath = path.join(projectRoot, 'CLAUDE.md');
  if (fs.existsSync(claudePath)) {
    return false;
  }

  fs.writeFileSync(claudePath, buildClaudeMd(projectName), 'utf-8');
  return true;
}

/**
 * Initial sprint definition for project setup.
 */
export interface InitialSprint {
  id: string;
  title: string;
  focus?: string;
  status?: string;
}

/**
 * Initial mission definition for project setup.
 */
export interface InitialMission {
  id: string;
  name: string;
  sprintId: string;
  objective?: string;
  successCriteria?: string[];
  deliverables?: string[];
  status?: 'Queued' | 'Current';
}

/**
 * Input parameters schema for cmos_project_init tool.
 */
export const cmosProjectInitSchema = z.object({
  /** Root directory where cmos/ will be created (required) */
  projectRoot: z.string().min(1).describe('Root directory where cmos/ will be created'),

  /** Human-readable project name */
  projectName: z.string().optional().describe('Human-readable project name'),

  /** Unique project identifier (auto-generated if not provided) */
  projectId: z
    .string()
    .optional()
    .describe('Unique project identifier (UUID or slug, auto-generated if not provided)'),

  /** Linked TraceLab project UUID for cross-referencing */
  tracelabProjectId: z
    .string()
    .optional()
    .describe('Linked TraceLab project UUID for cross-referencing'),

  /** Optional initial sprint to create */
  initialSprint: z
    .object({
      id: z.string().describe('Sprint ID (e.g., "sprint-01")'),
      title: z.string().describe('Sprint title'),
      focus: z.string().optional().describe('Sprint focus/theme'),
      status: z.string().optional().default('Active').describe('Sprint status'),
    })
    .optional()
    .describe('Optional initial sprint to create'),

  /** Optional initial missions to create */
  initialMissions: z
    .array(
      z.object({
        id: z.string().describe('Mission ID (e.g., "s01-m01")'),
        name: z.string().describe('Mission name'),
        sprintId: z.string().describe('Sprint ID this mission belongs to'),
        objective: z.string().optional().describe('Mission objective'),
        successCriteria: z.array(z.string()).optional().describe('Success criteria'),
        deliverables: z.array(z.string()).optional().describe('Expected deliverables'),
        status: z.enum(['Queued', 'Current']).optional().default('Queued'),
      })
    )
    .optional()
    .describe('Optional initial missions to create'),

  /** Project tier/type written to metadata at init (FORK-E6 default: build) */
  projectType: z
    .enum(['general', 'managed', 'build'])
    .optional()
    .describe(
      'Project tier/type (general | managed | build). Written to metadata so onboarding ' +
        'surfaces the matching tier prompt. Defaults to build for new projects.'
    ),
});

/**
 * Input type (before defaults applied) - use this for function parameters.
 */
export type CmosProjectInitInput = z.input<typeof cmosProjectInitSchema>;

/**
 * Output type (after defaults applied) - use this internally.
 */
export type CmosProjectInitParams = z.infer<typeof cmosProjectInitSchema>;

/**
 * Result of project initialization.
 */
export interface CmosProjectInitResult {
  /** Path to the created cmos/ directory */
  cmosDirectory: string;

  /** Path to the created database */
  databasePath: string;

  /** Whether this was a new initialization or update to existing */
  isNewProject: boolean;

  /** Project ID (generated or provided) */
  projectId: string;

  /** Project name */
  projectName: string;

  /** Schema version applied */
  schemaVersion: string;

  /** Files and directories created */
  created: {
    directories: string[];
    files: string[];
  };

  /** Sprint created (if any) */
  sprintCreated?: string;

  /** Missions created (if any) */
  missionsCreated?: string[];
}

/**
 * MCP Tool Definition for cmos_project_init.
 */
export const cmosProjectInitToolDefinition = {
  name: 'cmos_project_init',
  description:
    "Initialize a new CMOS project structure. Copies the full cmos-seed (tiers, docs, templates, foundational-docs, context, schema) and creates a fresh SQLite database. Safe to call on existing projects (idempotent - won't overwrite existing files).",
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Root directory where cmos/ will be created',
      },
      projectName: {
        type: 'string',
        description: 'Human-readable project name',
      },
      projectId: {
        type: 'string',
        description: 'Unique project identifier (UUID or slug, auto-generated if not provided)',
      },
      tracelabProjectId: {
        type: 'string',
        description: 'Linked TraceLab project UUID for cross-referencing',
      },
      initialSprint: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Sprint ID (e.g., "sprint-01")' },
          title: { type: 'string', description: 'Sprint title' },
          focus: { type: 'string', description: 'Sprint focus/theme' },
          status: { type: 'string', description: 'Sprint status (default: Active)' },
        },
        required: ['id', 'title'],
        description: 'Optional initial sprint to create',
      },
      initialMissions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Mission ID' },
            name: { type: 'string', description: 'Mission name' },
            sprintId: { type: 'string', description: 'Sprint ID' },
            objective: { type: 'string', description: 'Mission objective' },
            successCriteria: {
              type: 'array',
              items: { type: 'string' },
              description: 'Success criteria',
            },
            deliverables: {
              type: 'array',
              items: { type: 'string' },
              description: 'Expected deliverables',
            },
            status: {
              type: 'string',
              enum: ['Queued', 'Current'],
              description: 'Initial status',
            },
          },
          required: ['id', 'name', 'sprintId'],
        },
        description: 'Optional initial missions to create',
      },
    },
    required: ['projectRoot'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_project_init tool.
 *
 * Copies the full cmos-seed directory to <projectRoot>/cmos/ and creates
 * a fresh SQLite database with project metadata.
 */
export async function cmosProjectInit(
  input: CmosProjectInitInput
): Promise<CmosToolResult<CmosProjectInitResult>> {
  // Parse input to apply defaults and validate
  const parseResult = cmosProjectInitSchema.safeParse(input);
  if (!parseResult.success) {
    const firstError = parseResult.error.errors[0];
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: `Validation error: ${firstError?.message ?? 'Unknown error'}`,
      field: firstError?.path.join('.') || undefined,
      providedValue: firstError?.path.length
        ? (input as Record<string, unknown>)[String(firstError.path[0])]
        : undefined,
    });
  }

  const params = parseResult.data;
  const {
    projectRoot,
    projectName = '',
    projectId: providedProjectId,
    tracelabProjectId = '',
    initialSprint,
    initialMissions,
    projectType,
  } = params;

  // Validate project root exists and is a directory
  if (!fs.existsSync(projectRoot)) {
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: `Project root does not exist: ${projectRoot}`,
      suggestion: 'Provide a valid directory path where the project will be initialized.',
      field: 'projectRoot',
      providedValue: projectRoot,
    });
  }

  const projectRootStat = fs.statSync(projectRoot);
  if (!projectRootStat.isDirectory()) {
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: `Project root is not a directory: ${projectRoot}`,
      suggestion: 'Provide a directory path, not a file path.',
      field: 'projectRoot',
      providedValue: projectRoot,
    });
  }

  // Find the seed directory
  const seedPath = resolveSeedPath();
  if (!seedPath) {
    return createError({
      code: CMOS_ERROR_CODES.DB_CONNECTION_FAILED,
      message: 'Could not find cmos-seed directory. The CMOS-MCP package may be incomplete.',
      suggestion:
        'Ensure cmos-seed/ exists in the cmos-mcp package root. If installed via npm, reinstall the package.',
    });
  }

  const cmosDir = path.join(projectRoot, 'cmos');
  const dbPath = path.join(cmosDir, 'db', 'cmos.sqlite');
  let isNewProject = !fs.existsSync(cmosDir);

  // Generate project ID if not provided
  const projectId = providedProjectId || crypto.randomUUID();

  try {
    // Copy full seed directory to <projectRoot>/cmos/
    // Idempotent — existing files are NOT overwritten
    const { directories: createdDirs, files: createdFiles } = copySeedDir(
      seedPath,
      cmosDir,
      cmosDir
    );
    if (ensureClaudeMd(projectRoot, projectName)) {
      createdFiles.push(path.join('..', 'CLAUDE.md'));
    }

    // Create fresh SQLite database if it doesn't exist
    const dbExisted = fs.existsSync(dbPath);
    if (!dbExisted) {
      isNewProject = true;
      const dbDir = path.join(cmosDir, 'db');
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
    }

    // Sprint 70 m01: this raw open takes a caller-supplied projectRoot and is
    // WRITE-capable (creates/initializes the store), so a test calling
    // cmosProjectInit with the repo root would mutate the real dogfood store.
    // Guard it like the CmosDatabaseClient chokepoint. No-op outside Jest. (#754)
    assertJestDbPathIsolated(dbPath);
    const db = new Database(dbPath);

    try {
      db.pragma('journal_mode = WAL');

      // Execute schema (all CREATE IF NOT EXISTS, safe on existing DB)
      db.exec(CMOS_SCHEMA);

      // Set project metadata
      const now = new Date().toISOString();
      const updateMetadata = db.prepare(
        'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
      );

      updateMetadata.run('project_id', projectId);
      updateMetadata.run('project_name', projectName);
      updateMetadata.run('tracelab_project_id', tracelabProjectId);
      const readMetadata = db.prepare('SELECT value FROM metadata WHERE key = ?');
      const currentSchemaVersion = (
        readMetadata.get('schema_version') as { value: string } | undefined
      )?.value;
      const currentVersionParts = /^(\d+)\.(\d+)$/.exec(currentSchemaVersion ?? '');
      const bundledVersionParts = /^(\d+)\.(\d+)$/.exec(CMOS_SCHEMA_VERSION)!;
      const currentVersionIsLower =
        !currentVersionParts ||
        Number(currentVersionParts[1]) < Number(bundledVersionParts[1]) ||
        (Number(currentVersionParts[1]) === Number(bundledVersionParts[1]) &&
          Number(currentVersionParts[2]) < Number(bundledVersionParts[2]));
      if (currentVersionIsLower) {
        // The read is only a fast path. Re-check the row in the mutation so a concurrent init or
        // migration cannot raise the label between these statements and then be overwritten here.
        db.prepare(
          `INSERT OR REPLACE INTO metadata (key, value)
           SELECT ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM metadata
             WHERE key = ?
               AND value <> ''
               AND value NOT GLOB '*[^0-9.]*'
               AND length(value) - length(replace(value, '.', '')) = 1
               AND instr(value, '.') > 1
               AND instr(value, '.') < length(value)
               AND (
                 CAST(substr(value, 1, instr(value, '.') - 1) AS INTEGER) > ${Number(bundledVersionParts[1])}
                 OR (
                   CAST(substr(value, 1, instr(value, '.') - 1) AS INTEGER) = ${Number(bundledVersionParts[1])}
                   AND CAST(substr(value, instr(value, '.') + 1) AS INTEGER) >= ${Number(bundledVersionParts[2])}
                 )
               )
           )`
        ).run('schema_version', CMOS_SCHEMA_VERSION, 'schema_version');
      }

      // s83-m05: persist the tier/type so onboard's tierSelectionPrompt and
      // getProjectType read the operator's choice. An explicit projectType always
      // wins; a brand-new project with no explicit choice gets the 'build' default
      // (FORK-E6, kept in lockstep with getProjectType's fallback). An idempotent
      // re-init WITHOUT projectType leaves any existing project_type row untouched
      // so a later cmos_project(update) is not clobbered.
      if (projectType) {
        updateMetadata.run('project_type', projectType);
      } else if (isNewProject) {
        updateMetadata.run('project_type', 'build');
      }

      if (isNewProject) {
        updateMetadata.run('created_at', now);
      }

      // Initialize contexts if they don't exist
      const existingProjectContext = db
        .prepare('SELECT id FROM contexts WHERE id = ?')
        .get('project_context');

      if (!existingProjectContext) {
        // Read from the seed's context file
        const seedProjectContext = path.join(seedPath, 'context', 'project_context.json');
        let contextContent = '{}';
        if (fs.existsSync(seedProjectContext)) {
          contextContent = fs.readFileSync(seedProjectContext, 'utf-8');
        }

        db.prepare(
          'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
        ).run('project_context', 'cmos/context/project_context.json', contextContent, now);
      }

      const existingMasterContext = db
        .prepare('SELECT id FROM contexts WHERE id = ?')
        .get('master_context');

      if (!existingMasterContext) {
        // Read from the seed's context file and inject project name
        const seedMasterContext = path.join(seedPath, 'context', 'master_context.json');
        let masterObj: Record<string, unknown> = {};
        if (fs.existsSync(seedMasterContext)) {
          try {
            masterObj = JSON.parse(fs.readFileSync(seedMasterContext, 'utf-8'));
          } catch {
            masterObj = {};
          }
        }
        // Set project identity
        masterObj.project_identity = {
          name: projectName || '',
          description: '',
          status: 'active_development',
        };

        db.prepare(
          'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
        ).run('master_context', 'cmos/context/master_context.json', JSON.stringify(masterObj), now);
      }

      // Create initial sprint if provided
      let sprintCreated: string | undefined;
      if (initialSprint) {
        const existingSprint = db
          .prepare('SELECT id FROM sprints WHERE id = ?')
          .get(initialSprint.id);

        if (!existingSprint) {
          db.prepare(
            `INSERT INTO sprints (id, title, focus, status, start_date)
             VALUES (?, ?, ?, ?, ?)`
          ).run(
            initialSprint.id,
            initialSprint.title,
            initialSprint.focus || null,
            initialSprint.status || 'Active',
            now.split('T')[0]
          );
          sprintCreated = initialSprint.id;
        }
      }

      // Create initial missions if provided
      const missionsCreated: string[] = [];
      if (initialMissions && initialMissions.length > 0) {
        const insertMission = db.prepare(
          `INSERT OR IGNORE INTO missions
           (id, sprint_id, name, status, objective, success_criteria, deliverables)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );

        for (const mission of initialMissions) {
          const result = insertMission.run(
            mission.id,
            mission.sprintId,
            mission.name,
            mission.status || 'Queued',
            mission.objective || null,
            mission.successCriteria ? JSON.stringify(mission.successCriteria) : null,
            mission.deliverables ? JSON.stringify(mission.deliverables) : null
          );

          if (result.changes > 0) {
            missionsCreated.push(mission.id);
          }
        }
      }

      if (!dbExisted) {
        createdFiles.push('db/cmos.sqlite');
      }

      const storedSchemaVersion = (
        readMetadata.get('schema_version') as { value: string } | undefined
      )?.value;
      db.close();

      const result: CmosProjectInitResult = {
        cmosDirectory: cmosDir,
        databasePath: dbPath,
        isNewProject,
        projectId,
        projectName: projectName || '(not set)',
        schemaVersion: storedSchemaVersion ?? CMOS_SCHEMA_VERSION,
        created: {
          directories: createdDirs,
          files: createdFiles,
        },
        sprintCreated,
        missionsCreated: missionsCreated.length > 0 ? missionsCreated : undefined,
      };

      // Auto-register the project into the project-graph registry (s79-m02, the
      // sole discovery store). Clear the detector cache first so a stale negative
      // result (from any pre-init tool call on this path) doesn't cause registration
      // to fail. The store was just created with a UUID project_id, so registerStore
      // reuses that id. (s80-m02: no JSON mirror to re-derive — graph is the source.)
      try {
        CmosDetector.getInstance().clearCache(projectRoot);
        const graph = await ProjectGraphRegistry.create();
        graph.registerStore(projectRoot, { name: projectName || undefined });
      } catch {
        // Non-critical — init succeeded; user can run cmos_project register manually
      }

      return createSuccess(result);
    } catch (dbError) {
      db.close();
      throw dbError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return createError({
      code: CMOS_ERROR_CODES.DB_CONNECTION_FAILED,
      message: `Failed to initialize CMOS project: ${message}`,
      suggestion: 'Check file permissions and ensure the directory is writable.',
    });
  }
}

/**
 * Format initialization result for LLM readability.
 */
export function formatProjectInitForLLM(result: CmosToolResult<CmosProjectInitResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      'CMOS Project Initialization Failed',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines = [
    data.isNewProject ? 'CMOS Project Initialized' : 'CMOS Project Updated',
    '',
    `**Project ID**: ${data.projectId}`,
    `**Project Name**: ${data.projectName}`,
    `**Schema Version**: ${data.schemaVersion}`,
    '',
    `**Database**: ${data.databasePath}`,
  ];

  if (data.created.directories.length > 0 || data.created.files.length > 0) {
    lines.push('');
    lines.push('**Created**:');
    data.created.directories.forEach((dir) => lines.push(`  - ${dir}`));
    data.created.files.forEach((file) => lines.push(`  - ${file}`));
  }

  if (data.sprintCreated) {
    lines.push('');
    lines.push(`**Initial Sprint**: ${data.sprintCreated}`);
  }

  if (data.missionsCreated && data.missionsCreated.length > 0) {
    lines.push('');
    lines.push('**Initial Missions**:');
    data.missionsCreated.forEach((m) => lines.push(`  - ${m}`));
  }

  lines.push('');
  lines.push('Next: Run cmos_agent_onboard to get project context');

  appendWarnings(lines, result);

  return lines.join('\n');
}
