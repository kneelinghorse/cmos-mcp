/**
 * cmos_db_restore Tool
 *
 * MCP tool for restoring the active CMOS SQLite database from a named snapshot.
 * This operation is destructive and requires explicit confirmation.
 *
 * @module tools/cmos/cmos-db-restore
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { withClient } from './client';
import type { CmosToolResult } from './types';
import { CMOS_ERROR_CODES, CmosErrors, createError, createSuccess } from './errors';

const SNAPSHOT_FILE_EXTENSION = '.sqlite';
const PRE_RESTORE_BACKUP_PREFIX = 'pre-restore-';
const REQUIRED_TABLES = ['missions', 'sessions', 'contexts'] as const;

/**
 * Restore result payload.
 */
export interface CmosDbRestoreResult {
  /** Snapshot ID used for restore */
  snapshotId: string;

  /** Resolved snapshot file path */
  snapshotPath: string;

  /** Auto-backup ID created before restore */
  backupId: string;

  /** Auto-backup file path */
  backupPath: string;

  /** Timestamp when restore finished */
  restoredAt: string;

  /** Post-restore mission count */
  missionCount: number;

  /** Post-restore session count */
  sessionCount: number;

  /** Post-restore context count */
  contextCount: number;

  /** Human-readable summary */
  message: string;
}

interface DbPathResult {
  dbPath: string;
}

interface HealthSummary {
  missionCount: number;
  sessionCount: number;
  contextCount: number;
}

/**
 * Input schema for cmos_db_restore.
 */
export const cmosDbRestoreSchema = z.object({
  /** Snapshot identifier (from cmos_db_snapshot output) */
  snapshotId: z
    .string()
    .min(1)
    .describe(
      'Snapshot ID to restore from. Use cmos_db(action="snapshot", listOnly=true) to list snapshots.'
    ),

  /** Explicit confirmation required for destructive restore */
  confirm: z
    .boolean()
    .describe(
      'Must be true to proceed. Restore is destructive and replaces the active cmos.sqlite database.'
    ),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosDbRestoreParams = z.infer<typeof cmosDbRestoreSchema>;

/**
 * MCP Tool Definition for cmos_db_restore.
 */
export const cmosDbRestoreToolDefinition = {
  name: 'cmos_db_restore',
  description:
    'Restore the active CMOS SQLite database from a named snapshot. ' +
    'Creates an automatic pre-restore backup, validates snapshot schema, and requires explicit confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      snapshotId: {
        type: 'string',
        description:
          'Snapshot ID to restore from. Use cmos_db(action="snapshot", listOnly=true) to view available snapshots.',
        minLength: 1,
      },
      confirm: {
        type: 'boolean',
        description:
          'Must be true to proceed. Restore is destructive and replaces the active database.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['snapshotId', 'confirm'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_db_restore tool.
 *
 * @param params - Tool parameters
 * @returns Restore status or actionable error
 */
export async function cmosDbRestore(
  params: CmosDbRestoreParams
): Promise<CmosToolResult<CmosDbRestoreResult>> {
  if (params.confirm !== true) {
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: 'Restore is destructive and requires confirm=true.',
      field: 'confirm',
      providedValue: params.confirm,
      suggestion: 'Retry with confirm=true after verifying the snapshotId.',
    });
  }

  const snapshotId = params.snapshotId.trim();
  if (!snapshotId) {
    return createError(CmosErrors.missingParameter('snapshotId'));
  }

  if (snapshotId.includes('/') || snapshotId.includes('\\')) {
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: 'snapshotId must be a filename or snapshot ID, not a path.',
      field: 'snapshotId',
      providedValue: params.snapshotId,
      suggestion:
        'Use cmos_db(action="snapshot", listOnly=true) and pass one of the listed snapshot IDs.',
    });
  }

  const dbPathResult = await resolveDbPath(params.projectRoot);
  if (!dbPathResult.success || !dbPathResult.data) {
    return createError(
      dbPathResult.error ?? {
        code: 'DB_CONNECTION_FAILED',
        message: 'Failed to resolve active CMOS database path.',
        suggestion: 'Check projectRoot or run cmos_db(action="health") for diagnostics.',
      }
    );
  }

  const dbPath = dbPathResult.data.dbPath;
  const snapshotDirectory = path.join(path.dirname(dbPath), 'snapshots');
  const preRestoreBackupDirectory = path.join(snapshotDirectory, 'pre-restore');
  fs.mkdirSync(preRestoreBackupDirectory, { recursive: true });

  const resolvedSnapshotPath = resolveSnapshotPath(snapshotDirectory, snapshotId);
  if (!resolvedSnapshotPath) {
    return createError(CmosErrors.snapshotNotFound(snapshotId));
  }

  const validationError = validateSnapshotDatabase(resolvedSnapshotPath);
  if (validationError) {
    return createError(validationError);
  }

  const backupId = generatePreRestoreBackupId();
  const backupPath = path.join(preRestoreBackupDirectory, `${backupId}${SNAPSHOT_FILE_EXTENSION}`);

  try {
    await backupDatabase(dbPath, backupPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backup failure';
    return createError({
      code: CMOS_ERROR_CODES.SNAPSHOT_RESTORE_FAILED,
      message: `Failed to create pre-restore backup: ${message}`,
      suggestion: 'Check disk space and filesystem permissions before retrying restore.',
    });
  }

  try {
    replaceActiveDatabase(dbPath, resolvedSnapshotPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown restore failure';
    return createError({
      code: CMOS_ERROR_CODES.SNAPSHOT_RESTORE_FAILED,
      message: `Failed to replace active database: ${message}`,
      suggestion: `Pre-restore backup saved at '${backupPath}'.`,
    });
  }

  const verificationResult = await verifyRestoredDatabase(dbPath);
  if (!verificationResult.success || !verificationResult.data) {
    const rollbackMessage = attemptRollback(backupPath, dbPath);
    return createError({
      code: CMOS_ERROR_CODES.SNAPSHOT_RESTORE_FAILED,
      message:
        verificationResult.error?.message ??
        'Restore verification failed. The database may not be a valid CMOS schema.',
      suggestion: `${rollbackMessage} Inspect snapshot integrity and retry restore.`,
    });
  }

  const restoredAt = new Date().toISOString();

  return createSuccess({
    snapshotId: normalizeSnapshotId(resolvedSnapshotPath),
    snapshotPath: resolvedSnapshotPath,
    backupId,
    backupPath,
    restoredAt,
    missionCount: verificationResult.data.missionCount,
    sessionCount: verificationResult.data.sessionCount,
    contextCount: verificationResult.data.contextCount,
    message: `Database restored from snapshot '${normalizeSnapshotId(resolvedSnapshotPath)}'.`,
  });
}

/**
 * Format restore result for LLM readability.
 */
export function formatDbRestoreForLLM(result: CmosToolResult<CmosDbRestoreResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to restore database snapshot',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];
    if (error?.suggestion) {
      lines.push('', `Suggestion: ${error.suggestion}`);
    }
    return lines.join('\n');
  }

  const data = result.data;
  return [
    '✅ Database restore complete',
    '',
    `**Snapshot ID**: ${data.snapshotId}`,
    `**Snapshot Path**: ${data.snapshotPath}`,
    `**Pre-Restore Backup**: ${data.backupPath}`,
    `**Restored At**: ${data.restoredAt}`,
    '',
    '**Post-Restore Counts**:',
    `- Missions: ${data.missionCount}`,
    `- Sessions: ${data.sessionCount}`,
    `- Contexts: ${data.contextCount}`,
    '',
    data.message,
  ].join('\n');
}

async function resolveDbPath(projectRoot?: string): Promise<CmosToolResult<DbPathResult>> {
  return withClient(
    (client) =>
      createSuccess({
        dbPath: client.path,
      }),
    { projectRoot }
  );
}

function resolveSnapshotPath(snapshotDirectory: string, snapshotId: string): string | null {
  const normalized = path.basename(snapshotId);
  const candidates = normalized.endsWith(SNAPSHOT_FILE_EXTENSION)
    ? [normalized]
    : [`${normalized}${SNAPSHOT_FILE_EXTENSION}`, normalized];

  for (const candidate of candidates) {
    const candidatePath = path.join(snapshotDirectory, candidate);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }

  return null;
}

function normalizeSnapshotId(snapshotPath: string): string {
  const filename = path.basename(snapshotPath);
  return filename.endsWith(SNAPSHOT_FILE_EXTENSION)
    ? filename.slice(0, -SNAPSHOT_FILE_EXTENSION.length)
    : filename;
}

function validateSnapshotDatabase(snapshotPath: string) {
  let db: DatabaseType | null = null;
  try {
    db = new Database(snapshotPath, { readonly: true, fileMustExist: true });

    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableSet = new Set(tableRows.map((row) => row.name));
    const missingTables = REQUIRED_TABLES.filter((table) => !tableSet.has(table));

    if (missingTables.length > 0) {
      return {
        code: CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH,
        message: `Snapshot is not a valid CMOS database. Missing tables: ${missingTables.join(', ')}`,
        suggestion:
          'Use cmos_db(action="snapshot") to create a valid snapshot from a CMOS database.',
      };
    }

    const integrityCheck = db.pragma('integrity_check', { simple: true }) as string;
    if (integrityCheck !== 'ok') {
      return {
        code: CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH,
        message: `Snapshot integrity check failed: ${integrityCheck}`,
        suggestion: 'Select a different snapshot or recreate snapshots from a healthy database.',
      };
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown SQLite error';
    return {
      code: CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH,
      message: `Snapshot validation failed: ${message}`,
      suggestion: 'Ensure snapshot file exists and is a readable SQLite database.',
    };
  } finally {
    db?.close();
  }
}

async function backupDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  if (fs.existsSync(destinationPath)) {
    fs.rmSync(destinationPath, { force: true });
  }

  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destinationPath);
  } finally {
    db.close();
  }
}

function replaceActiveDatabase(activeDbPath: string, snapshotPath: string): void {
  const tempPath = `${activeDbPath}.restore-${Date.now()}-${randomBytes(2).toString('hex')}`;
  try {
    fs.copyFileSync(snapshotPath, tempPath);
    fs.renameSync(tempPath, activeDbPath);
    cleanupWalFiles(activeDbPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

async function verifyRestoredDatabase(dbPath: string): Promise<CmosToolResult<HealthSummary>> {
  return withClient(
    (client) => {
      const healthResult = client.health();
      if (!healthResult.success || !healthResult.data) {
        return healthResult as CmosToolResult<HealthSummary>;
      }

      return createSuccess({
        missionCount: healthResult.data.missionCount,
        sessionCount: healthResult.data.sessionCount,
        contextCount: healthResult.data.contextCount,
      });
    },
    { dbPath }
  );
}

function cleanupWalFiles(dbPath: string): void {
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function attemptRollback(backupPath: string, dbPath: string): string {
  try {
    fs.copyFileSync(backupPath, dbPath);
    cleanupWalFiles(dbPath);
    return `Restore verification failed; rolled back from '${backupPath}'.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown rollback failure';
    return `Restore verification failed and rollback also failed: ${message}.`;
  }
}

function generatePreRestoreBackupId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '$1Z');
  const suffix = randomBytes(2).toString('hex');
  return `${PRE_RESTORE_BACKUP_PREFIX}${timestamp}-${suffix}`;
}
