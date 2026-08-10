/**
 * CMOS Error Codes
 *
 * Standardized error codes for all CMOS tools.
 * Each code maps to a consistent error pattern with actionable suggestions.
 *
 * @module tools/cmos/errors
 */

import type { CmosToolError, CmosToolResult, MissionStatus, SanitizedFieldReport } from './types';

/**
 * CMOS-specific error codes.
 * Naming convention: ENTITY_ERROR_TYPE
 */
export const CMOS_ERROR_CODES = {
  // Database errors
  DB_NOT_FOUND: 'DB_NOT_FOUND',
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  DB_QUERY_FAILED: 'DB_QUERY_FAILED',
  DB_SCHEMA_MISMATCH: 'DB_SCHEMA_MISMATCH',

  // Mission errors
  MISSION_NOT_FOUND: 'MISSION_NOT_FOUND',
  MISSION_INVALID_STATE: 'MISSION_INVALID_STATE',
  MISSION_INVALID_TRANSITION: 'MISSION_INVALID_TRANSITION',
  MISSION_ALREADY_COMPLETED: 'MISSION_ALREADY_COMPLETED',
  MISSION_ALREADY_BLOCKED: 'MISSION_ALREADY_BLOCKED',

  // Context errors
  CONTEXT_NOT_FOUND: 'CONTEXT_NOT_FOUND',
  CONTEXT_INVALID_TYPE: 'CONTEXT_INVALID_TYPE',
  CONTEXT_PARSE_ERROR: 'CONTEXT_PARSE_ERROR',
  CONTEXT_CONDENSATION_FAILED: 'CONTEXT_CONDENSATION_FAILED',

  // Session errors
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_ALREADY_ACTIVE: 'SESSION_ALREADY_ACTIVE',
  SESSION_NOT_ACTIVE: 'SESSION_NOT_ACTIVE',
  SESSION_INVALID_TYPE: 'SESSION_INVALID_TYPE',

  // Sprint errors
  SPRINT_NOT_FOUND: 'SPRINT_NOT_FOUND',
  SPRINT_ID_EXISTS: 'SPRINT_ID_EXISTS',
  SPRINT_ALREADY_COMPLETED: 'SPRINT_ALREADY_COMPLETED',
  SPRINT_NOT_READY: 'SPRINT_NOT_READY',
  BUILD_STALE: 'BUILD_STALE',

  // Validation errors
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  INVALID_ACTION: 'INVALID_ACTION',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  PROJECT_ID_MISMATCH: 'PROJECT_ID_MISMATCH',

  // Snapshot errors
  SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',
  SNAPSHOT_CREATION_FAILED: 'SNAPSHOT_CREATION_FAILED',
  SNAPSHOT_RESTORE_FAILED: 'SNAPSHOT_RESTORE_FAILED',

  // CMOS detection errors
  CMOS_NOT_DETECTED: 'CMOS_NOT_DETECTED',

  // Dashboard errors (Sprint 28)
  DASHBOARD_UNREACHABLE: 'DASHBOARD_UNREACHABLE',
  DASHBOARD_AUTH_FAILED: 'DASHBOARD_AUTH_FAILED',
  // s84-m02: a 403 is an AUTHZ denial (e.g. "not the recipient"), distinct from a 401
  // token-expiry (DASHBOARD_AUTH_FAILED). Split out so the shared request() no longer
  // clears the cached token on a forbidden — clearing poisoned apiKey auth (Bearer null).
  DASHBOARD_FORBIDDEN: 'DASHBOARD_FORBIDDEN',
  DASHBOARD_NOT_FOUND: 'DASHBOARD_NOT_FOUND',
  DASHBOARD_ERROR: 'DASHBOARD_ERROR',
  DASHBOARD_NOT_CONFIGURED: 'DASHBOARD_NOT_CONFIGURED',
  DASHBOARD_UPGRADE_REQUIRED: 'DASHBOARD_UPGRADE_REQUIRED',

  // Device code flow errors (Sprint 58 m01)
  DEVICE_CODE_EXPIRED: 'DEVICE_CODE_EXPIRED',
  DEVICE_CODE_ACCESS_DENIED: 'DEVICE_CODE_ACCESS_DENIED',

  // Unhandled tool-execution exception surfaced at the MCP dispatch boundary (Sprint 74 m03).
  // A handler threw instead of returning a {success:false} envelope; the boundary wraps it
  // as a structured error rather than leaking a bare JSON-RPC -32603 to the caller.
  TOOL_EXECUTION_ERROR: 'TOOL_EXECUTION_ERROR',
} as const;

export type CmosErrorCode = (typeof CMOS_ERROR_CODES)[keyof typeof CMOS_ERROR_CODES];

/**
 * Valid mission statuses for validation.
 */
export const VALID_MISSION_STATUSES: MissionStatus[] = [
  'Queued',
  'Current',
  'In Progress',
  'Completed',
  'Blocked',
  'Dropped',
  'Deferred',
];

/**
 * Valid state transitions for missions.
 */
export const VALID_STATE_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  Queued: ['Current', 'In Progress', 'Dropped', 'Deferred'],
  Current: ['In Progress', 'Blocked', 'Dropped', 'Deferred'],
  'In Progress': ['Completed', 'Blocked', 'Dropped', 'Deferred'],
  Completed: [], // Terminal state
  Blocked: ['In Progress', 'Current', 'Dropped', 'Deferred'],
  Dropped: [], // Terminal state — soft parked, cannot be re-activated
  Deferred: ['Queued', 'Current', 'Dropped'], // Temporarily parked — can re-queue or drop
};

/**
 * Valid session types matching cmos/docs/archive/session-management-guide.md.
 */
export const VALID_SESSION_TYPES = [
  'onboarding',
  'planning',
  'review',
  'research',
  'check-in',
  'custom',
] as const;

export type SessionType = (typeof VALID_SESSION_TYPES)[number];

/**
 * Valid context types.
 */
export const VALID_CONTEXT_TYPES = ['project_context', 'master_context'] as const;

export type ContextType = (typeof VALID_CONTEXT_TYPES)[number];

/**
 * Create a standardized error result.
 */
export function createError<T = unknown>(error: CmosToolError): CmosToolResult<T> {
  return {
    success: false,
    error,
  };
}

/**
 * Create a success result.
 */
export function createSuccess<T>(
  data: T,
  warnings?: string[],
  sanitizedFields?: SanitizedFieldReport[]
): CmosToolResult<T> {
  const result: CmosToolResult<T> = {
    success: true,
    data,
  };
  if (warnings && warnings.length > 0) {
    result.warnings = warnings;
  }
  if (sanitizedFields && sanitizedFields.length > 0) {
    result.sanitizedFields = sanitizedFields;
  }
  return result;
}

/**
 * Attach sanitizedFields to an already-constructed result, preserving the rest
 * of the shape. No-op when the sanitization surfaced nothing.
 *
 * Useful for wrapping existing handlers where restructuring createSuccess call
 * sites would be invasive — the handler computes its result, then calls this.
 */
export function withSanitizedFields<T>(
  result: CmosToolResult<T>,
  sanitizedFields: SanitizedFieldReport[] | undefined
): CmosToolResult<T> {
  if (!sanitizedFields || sanitizedFields.length === 0) {
    return result;
  }
  return { ...result, sanitizedFields };
}

/**
 * Error factory functions for common error patterns.
 */
export const CmosErrors = {
  dbNotFound(path: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.DB_NOT_FOUND,
      message: `CMOS database not found at '${path}'`,
      suggestion: 'Ensure the cmos/ directory exists and contains db/cmos.sqlite',
    };
  },

  dbConnectionFailed(path: string, reason: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.DB_CONNECTION_FAILED,
      message: `Failed to connect to database at '${path}': ${reason}`,
      suggestion: 'Check file permissions and ensure the database is not locked',
    };
  },

  missionNotFound(missionId: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.MISSION_NOT_FOUND,
      message: `Mission '${missionId}' not found`,
      suggestion: 'Use cmos_mission(action="list") to see available missions',
    };
  },

  missionInvalidTransition(
    missionId: string,
    currentStatus: MissionStatus,
    targetStatus: MissionStatus
  ): CmosToolError {
    const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
    return {
      code: CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION,
      message: `Cannot transition mission '${missionId}' from '${currentStatus}' to '${targetStatus}'`,
      currentState: currentStatus,
      validTransitions,
      suggestion:
        validTransitions.length > 0
          ? `Valid transitions from '${currentStatus}': ${validTransitions.join(', ')}`
          : `Mission is in terminal state '${currentStatus}' and cannot be changed`,
    };
  },

  contextNotFound(contextType: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.CONTEXT_NOT_FOUND,
      message: `Context '${contextType}' not found`,
      suggestion: 'Use cmos_context(action="view") to list available contexts',
      validValues: VALID_CONTEXT_TYPES as unknown as string[],
    };
  },

  invalidParameter(field: string, providedValue: unknown, validValues?: string[]): CmosToolError {
    const error: CmosToolError = {
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: `Invalid value for parameter '${field}'`,
      field,
      providedValue,
    };
    if (validValues) {
      error.validValues = validValues;
      error.suggestion = `Valid values: ${validValues.join(', ')}`;
    }
    return error;
  },

  invalidAction(
    tool: string,
    providedValue: unknown,
    availableActions: readonly string[]
  ): CmosToolError {
    const normalizedValue = typeof providedValue === 'string' ? providedValue.trim() : '';

    return {
      code: CMOS_ERROR_CODES.INVALID_ACTION,
      message: normalizedValue
        ? `Action '${normalizedValue}' is not supported for ${tool}`
        : `Action is required for ${tool}`,
      suggestion: `Use one of the available actions: ${availableActions.join(', ')}`,
      field: 'action',
      providedValue,
      validValues: [...availableActions],
      availableActions: [...availableActions],
      available_actions: [...availableActions],
    };
  },

  missingParameter(field: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.MISSING_PARAMETER,
      message: `Required parameter '${field}' is missing`,
      field,
      suggestion: `Please provide a value for '${field}'`,
    };
  },

  sessionNotFound(sessionId: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.SESSION_NOT_FOUND,
      message: `Session '${sessionId}' not found`,
      suggestion: 'Use cmos_session(action="list") to see available sessions',
    };
  },

  sessionNotActive(sessionId: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.SESSION_NOT_ACTIVE,
      message: `Session '${sessionId}' is not active`,
      suggestion: 'Only active sessions can be captured to or completed',
    };
  },

  cmosNotDetected(searchPath: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.CMOS_NOT_DETECTED,
      message: `CMOS directory not found starting from '${searchPath}'`,
      suggestion:
        'CMOS tools require a cmos/ directory with db/cmos.sqlite. Create one or navigate to a CMOS-enabled project.',
    };
  },

  snapshotNotFound(snapshotId: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.SNAPSHOT_NOT_FOUND,
      message: `Snapshot '${snapshotId}' not found`,
      suggestion: 'Use cmos_db(action="snapshot") to create a new snapshot',
    };
  },

  sprintNotFound(sprintId: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.SPRINT_NOT_FOUND,
      message: `Sprint '${sprintId}' not found`,
      suggestion: 'Use cmos_sprint with action="list" to see available sprints',
    };
  },

  sprintIdExists(sprintId: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.SPRINT_ID_EXISTS,
      message: `Sprint '${sprintId}' already exists`,
      suggestion:
        'Choose a different sprint ID or use cmos_sprint with action="update" to modify it',
    };
  },

  /**
   * Sprint 70 m02 — the enforced build-freshness gate fired at sprint close. Takes
   * pre-extracted primitives (not the BuildFreshnessReport type) so errors.ts keeps
   * no dependency on build-freshness.ts. `reason`/`staleFiles` describe the
   * source-newer-than-dist signal; `serverStaleMessage` describes the
   * running-server-on-stale-code signal. Either or both may be present.
   */
  buildStale(args: {
    reason?: string;
    staleFiles?: string[];
    serverStaleMessage?: string | null;
  }): CmosToolError {
    const parts: string[] = [];
    if (args.reason) {
      parts.push(`Build is stale (${args.reason}).`);
      if (args.staleFiles && args.staleFiles.length > 0) {
        parts.push(`Source files newer than the last build: ${args.staleFiles.join(', ')}.`);
      }
    }
    if (args.serverStaleMessage) {
      parts.push(args.serverStaleMessage);
    }
    return {
      code: CMOS_ERROR_CODES.BUILD_STALE,
      message: parts.join(' ') || 'Build is stale.',
      suggestion:
        "Run 'npm run build' and restart the MCP server, then retry. If this is an intentional dist-only/packaged install, pass forceComplete:true to override.",
    };
  },

  dashboardUnreachable(url: string, reason: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.DASHBOARD_UNREACHABLE,
      message: `Dashboard unreachable at '${url}': ${reason}`,
      suggestion:
        'Ensure the cmos-dashboard is running and CMOS_DASHBOARD_URL is correctly configured',
    };
  },

  dashboardAuthFailed(url: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.DASHBOARD_AUTH_FAILED,
      message: `Authentication failed for dashboard at '${url}'`,
      suggestion: 'Verify CMOS_DASHBOARD_USER and CMOS_DASHBOARD_PASSWORD are correct',
    };
  },

  /**
   * s84-m02 — a 403 Forbidden: the caller authenticated but is not authorized for
   * this resource (e.g. respond/ack on a message where they are not the recipient,
   * or an owner-gated route hit by a non-owner member after the dashboard m04
   * cutover returns 403 not 404). Distinct from DASHBOARD_AUTH_FAILED (401 token
   * expiry) so the client does NOT clear its cached token on a forbidden.
   */
  dashboardForbidden(resource: string, detail?: string, hint?: string): CmosToolError {
    const message = detail
      ? `Dashboard 403 on ${resource}: ${detail}`
      : `Dashboard access forbidden: ${resource}`;
    return {
      code: CMOS_ERROR_CODES.DASHBOARD_FORBIDDEN,
      message,
      suggestion:
        hint ??
        'You are authenticated but not authorized for this resource — verify you own or are the recipient of the target, or that the target id/address is correct.',
    };
  },

  dashboardNotFound(resource: string, detail?: string, hint?: string): CmosToolError {
    const message = detail
      ? `Dashboard 404 on ${resource}: ${detail}`
      : `Dashboard resource not found: ${resource}`;
    return {
      code: CMOS_ERROR_CODES.DASHBOARD_NOT_FOUND,
      message,
      suggestion: hint ?? 'Verify the resource ID or address is correct',
    };
  },

  dashboardError(message: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.DASHBOARD_ERROR,
      message: `Dashboard error: ${message}`,
      suggestion: 'Check the dashboard logs for more details',
    };
  },

  dashboardNotConfigured(): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.DASHBOARD_NOT_CONFIGURED,
      message:
        'This feature requires a dashboard account. Sign up at https://cmos.aquex.ai/register to enable sync, messaging, and cross-project features.',
      suggestion:
        'Set CMOS_DASHBOARD_URL=https://cmos.aquex.ai (or your dashboard host) and run cmos_auth(action="login") to bootstrap credentials. Local-only CMOS works without this.',
    };
  },

  dashboardUpgradeRequired(detail?: string): CmosToolError {
    const detailSuffix = detail ? `: ${detail}` : '';
    return {
      code: CMOS_ERROR_CODES.DASHBOARD_UPGRADE_REQUIRED,
      message: `This feature requires a paid dashboard tier${detailSuffix}. Upgrade at https://cmos.aquex.ai/register to access it.`,
      suggestion:
        'Visit https://cmos.aquex.ai/register to view tier options and upgrade. Local-only CMOS features remain unaffected.',
    };
  },
};
