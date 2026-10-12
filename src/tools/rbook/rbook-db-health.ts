/**
 * rbook_db_health Tool
 *
 * MCP tool for checking Reasonbook database connectivity and health.
 * Returns database stats including table counts and last activity.
 * Provides actionable errors when database is missing or corrupt.
 *
 * @module tools/rbook/rbook-db-health
 */

import { z } from 'zod';
import {
  semanticSearchStatus,
  type SemanticSearchStatus,
} from '../../intelligence/embedding-pipeline';
import { RbookDatabaseClient, withClient } from './client';
import type { RbookToolResult, DbHealthResult } from './types';
import { createSuccess } from './errors';
import { appendWarnings } from './format-warnings';

/**
 * Extended health result including last activity information.
 */
export interface RbookDbHealthResult extends DbHealthResult {
  /** Last mission activity timestamp */
  lastMissionActivity: string | null;

  /** Last session activity timestamp */
  lastSessionActivity: string | null;

  /** Last context update timestamp */
  lastContextUpdate: string | null;

  /** Database file size in bytes */
  fileSizeBytes: number | null;

  /** Whether WAL mode is enabled */
  walModeEnabled: boolean;

  /**
   * s92-m07: whether semantic (vector) search can take part in retrieval in this process. The
   * embedding package is an optional peer dependency; without it, search is keyword-only.
   */
  semanticSearch: SemanticSearchStatus;
}

/**
 * Input parameters schema for rbook_db_health tool.
 * This tool takes no parameters - it auto-detects the Reasonbook database.
 */
export const rbookDbHealthSchema = z.object({
  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookDbHealthParams = z.infer<typeof rbookDbHealthSchema>;

/**
 * MCP Tool Definition for rbook_db_health.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const rbookDbHealthToolDefinition = {
  name: 'rbook_db_health',
  description:
    'Check Reasonbook database connectivity and health. Returns database stats including table counts, last activity timestamps, and file information. Use this to verify Reasonbook is properly configured before running other Reasonbook operations.',
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_db_health tool.
 *
 * Checks database connectivity, retrieves table counts, and gathers
 * last activity information for missions, sessions, and contexts.
 *
 * @param params - Tool parameters (optional projectRoot)
 * @returns RbookToolResult with health information or actionable error
 */
export async function rbookDbHealth(
  params: RbookDbHealthParams = {}
): Promise<RbookToolResult<RbookDbHealthResult>> {
  return withClient(
    (client) => {
      // Get basic health info from client
      const healthResult = client.health();
      if (!healthResult.success || !healthResult.data) {
        return healthResult as RbookToolResult<RbookDbHealthResult>;
      }

      const baseHealth = healthResult.data;

      // Get last activity timestamps
      const lastMissionActivity = getLastMissionActivity(client);
      const lastSessionActivity = getLastSessionActivity(client);
      const lastContextUpdate = getLastContextUpdate(client);

      // Get file size
      const fileSizeBytes = getFileSizeBytes(client.path);

      // Check if WAL mode is enabled
      const walModeEnabled = checkWalMode(client);

      const result: RbookDbHealthResult = {
        ...baseHealth,
        lastMissionActivity,
        lastSessionActivity,
        lastContextUpdate,
        fileSizeBytes,
        walModeEnabled,
        semanticSearch: semanticSearchStatus(),
      };

      return createSuccess(result);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Get the most recent mission activity timestamp.
 */
function getLastMissionActivity(client: RbookDatabaseClient): string | null {
  try {
    // Try completed_at first (most reliable for activity)
    const completedResult = client.getOne<{ completed_at: string | null }>(
      `SELECT completed_at FROM missions
       WHERE completed_at IS NOT NULL
       ORDER BY julianday(completed_at) DESC
       LIMIT 1`
    );

    if (completedResult.success && completedResult.data?.completed_at) {
      return completedResult.data.completed_at;
    }

    // Fall back to checking for any missions in active states
    const activeResult = client.getOne<{ id: string }>(
      `SELECT id FROM missions WHERE status IN ('Current', 'In Progress') LIMIT 1`
    );

    if (activeResult.success && activeResult.data) {
      return 'active'; // Indicates there's current activity
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the most recent session activity timestamp.
 */
function getLastSessionActivity(client: RbookDatabaseClient): string | null {
  try {
    // Check completed sessions first
    const completedResult = client.getOne<{ completed_at: string | null }>(
      `SELECT completed_at FROM sessions
       WHERE completed_at IS NOT NULL
       ORDER BY julianday(completed_at) DESC
       LIMIT 1`
    );

    if (completedResult.success && completedResult.data?.completed_at) {
      return completedResult.data.completed_at;
    }

    // Check started_at for any session
    const startedResult = client.getOne<{ started_at: string }>(
      `SELECT started_at FROM sessions
       ORDER BY julianday(started_at) DESC
       LIMIT 1`
    );

    if (startedResult.success && startedResult.data?.started_at) {
      return startedResult.data.started_at;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the most recent context update timestamp.
 */
function getLastContextUpdate(client: RbookDatabaseClient): string | null {
  try {
    const result = client.getOne<{ updated_at: string | null }>(
      `SELECT updated_at FROM contexts
       WHERE updated_at IS NOT NULL
       ORDER BY julianday(updated_at) DESC
       LIMIT 1`
    );

    if (result.success && result.data?.updated_at) {
      return result.data.updated_at;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get database file size in bytes.
 */
function getFileSizeBytes(dbPath: string): number | null {
  try {
    const fs = require('fs');
    const stats = fs.statSync(dbPath);
    return stats.size;
  } catch {
    return null;
  }
}

/**
 * Check if WAL mode is enabled.
 */
function checkWalMode(client: RbookDatabaseClient): boolean {
  try {
    const result = client.getOne<{ journal_mode: string }>('PRAGMA journal_mode');
    return result.success && result.data?.journal_mode === 'wal';
  } catch {
    return false;
  }
}

/**
 * Format health result for LLM readability.
 *
 * @param result - Health check result
 * @returns Human-readable summary
 */
export function formatHealthForLLM(result: RbookToolResult<RbookDbHealthResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Reasonbook Database Health Check Failed',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const health = result.data;
  const lines = [
    '✓ Reasonbook Database Health Check',
    '',
    `**Database**: ${health.path}`,
    `**SQLite Version**: ${health.version}`,
    `**WAL Mode**: ${health.walModeEnabled ? 'Enabled ✓' : 'Disabled'}`,
    `**Semantic search**: ${health.semanticSearch.enabled ? 'on' : 'off'} — ${health.semanticSearch.detail}`,
  ];

  if (health.fileSizeBytes !== null) {
    const sizeKB = (health.fileSizeBytes / 1024).toFixed(1);
    lines.push(`**File Size**: ${sizeKB} KB`);
  }

  lines.push('');
  lines.push('**Tables**:');
  health.tables.forEach((table) => {
    lines.push(`  - ${table}`);
  });

  lines.push('');
  lines.push('**Record Counts**:');
  lines.push(`  - Missions: ${health.missionCount}`);
  lines.push(`  - Sessions: ${health.sessionCount}`);
  lines.push(`  - Contexts: ${health.contextCount}`);

  lines.push('');
  lines.push('**Last Activity**:');
  lines.push(`  - Mission: ${health.lastMissionActivity ?? 'No activity'}`);
  lines.push(`  - Session: ${health.lastSessionActivity ?? 'No activity'}`);
  lines.push(`  - Context: ${health.lastContextUpdate ?? 'Never updated'}`);

  appendWarnings(lines, result);

  return lines.join('\n');
}
