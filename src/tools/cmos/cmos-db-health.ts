/**
 * cmos_db_health Tool
 *
 * MCP tool for checking CMOS database connectivity and health.
 * Returns database stats including table counts and last activity.
 * Provides actionable errors when database is missing or corrupt.
 *
 * @module tools/cmos/cmos-db-health
 */

import { z } from 'zod';
import { CmosDatabaseClient, withClient } from './client';
import type { CmosToolResult, DbHealthResult } from './types';
import { createSuccess } from './errors';
import { appendWarnings } from './format-warnings';

/**
 * Extended health result including last activity information.
 */
export interface CmosDbHealthResult extends DbHealthResult {
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
}

/**
 * Input parameters schema for cmos_db_health tool.
 * This tool takes no parameters - it auto-detects the CMOS database.
 */
export const cmosDbHealthSchema = z.object({
  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosDbHealthParams = z.infer<typeof cmosDbHealthSchema>;

/**
 * MCP Tool Definition for cmos_db_health.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const cmosDbHealthToolDefinition = {
  name: 'cmos_db_health',
  description:
    'Check CMOS database connectivity and health. Returns database stats including table counts, last activity timestamps, and file information. Use this to verify CMOS is properly configured before running other CMOS operations.',
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_db_health tool.
 *
 * Checks database connectivity, retrieves table counts, and gathers
 * last activity information for missions, sessions, and contexts.
 *
 * @param params - Tool parameters (optional projectRoot)
 * @returns CmosToolResult with health information or actionable error
 */
export async function cmosDbHealth(
  params: CmosDbHealthParams = {}
): Promise<CmosToolResult<CmosDbHealthResult>> {
  return withClient(
    (client) => {
      // Get basic health info from client
      const healthResult = client.health();
      if (!healthResult.success || !healthResult.data) {
        return healthResult as CmosToolResult<CmosDbHealthResult>;
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

      const result: CmosDbHealthResult = {
        ...baseHealth,
        lastMissionActivity,
        lastSessionActivity,
        lastContextUpdate,
        fileSizeBytes,
        walModeEnabled,
      };

      return createSuccess(result);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Get the most recent mission activity timestamp.
 */
function getLastMissionActivity(client: CmosDatabaseClient): string | null {
  try {
    // Try completed_at first (most reliable for activity)
    const completedResult = client.getOne<{ completed_at: string | null }>(
      `SELECT completed_at FROM missions
       WHERE completed_at IS NOT NULL
       ORDER BY completed_at DESC
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
function getLastSessionActivity(client: CmosDatabaseClient): string | null {
  try {
    // Check completed sessions first
    const completedResult = client.getOne<{ completed_at: string | null }>(
      `SELECT completed_at FROM sessions
       WHERE completed_at IS NOT NULL
       ORDER BY completed_at DESC
       LIMIT 1`
    );

    if (completedResult.success && completedResult.data?.completed_at) {
      return completedResult.data.completed_at;
    }

    // Check started_at for any session
    const startedResult = client.getOne<{ started_at: string }>(
      `SELECT started_at FROM sessions
       ORDER BY started_at DESC
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
function getLastContextUpdate(client: CmosDatabaseClient): string | null {
  try {
    const result = client.getOne<{ updated_at: string | null }>(
      `SELECT updated_at FROM contexts
       WHERE updated_at IS NOT NULL
       ORDER BY updated_at DESC
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
function checkWalMode(client: CmosDatabaseClient): boolean {
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
export function formatHealthForLLM(result: CmosToolResult<CmosDbHealthResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ CMOS Database Health Check Failed',
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
    '✓ CMOS Database Health Check',
    '',
    `**Database**: ${health.path}`,
    `**SQLite Version**: ${health.version}`,
    `**WAL Mode**: ${health.walModeEnabled ? 'Enabled ✓' : 'Disabled'}`,
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
