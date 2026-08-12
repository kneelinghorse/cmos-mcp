/**
 * CMOS Tool Types
 *
 * Shared type definitions for all CMOS MCP tools.
 * All tools return CmosToolResult<T> for consistent agent-friendly responses.
 *
 * @module tools/cmos/types
 */

/**
 * Structured error response for CMOS tools.
 * Designed to be actionable - agents can self-correct from these errors.
 */
export interface CmosToolError {
  /** Machine-readable error code (e.g., 'MISSION_NOT_FOUND', 'INVALID_STATE') */
  code: string;

  /** Human-readable explanation of what went wrong */
  message: string;

  /** Actionable suggestion for how to fix the error */
  suggestion?: string;

  /** For validation errors: list of valid values the agent can use */
  validValues?: string[];

  /** For consolidated action tools: list of valid actions */
  availableActions?: string[];

  /** Snake_case alias for MCP-facing structured content compatibility */
  available_actions?: string[];

  /** For state errors: the current state that caused the error */
  currentState?: string;

  /** For state errors: valid transitions from current state */
  validTransitions?: string[];

  /** Field that caused the error (for validation errors) */
  field?: string;

  /** Value that was provided (for validation errors) */
  providedValue?: unknown;

  /** Additional diagnostic context for debugging or remediation */
  details?: string;

  /** Processing phase where the failure occurred */
  phase?: string;

  /** Specific operation that failed within a phase */
  operation?: string;
}

/**
 * One sanitized field entry surfaced on a tool response.
 * Sprint 56 m02: CMOS write-path handlers scan free-text fields for XML
 * marshalling artifacts and strip-and-surface when detected, so the caller
 * can tell which field was altered and why.
 */
export interface SanitizedFieldReport {
  /** The field name (or array path like `decisions[2]`) that was sanitized. */
  field: string;
  /** Short human-readable explanation of what was stripped. */
  reason: string;
}

/**
 * Standard result type for all CMOS tools.
 * Follows the pattern: { success: boolean, data?: T, error?: CmosToolError }
 *
 * @template T - The type of data returned on success
 */
export interface CmosToolResult<T = unknown> {
  /** Whether the operation succeeded */
  success: boolean;

  /** The result data (present when success is true) */
  data?: T;

  /** Error details (present when success is false) */
  error?: CmosToolError;

  /** Optional warnings that don't prevent success but should be noted */
  warnings?: string[];

  /** Per-field entries for free-text fields that were sanitized on write. */
  sanitizedFields?: SanitizedFieldReport[];
}

/**
 * Mission status values as stored in the database.
 */
export type MissionStatus =
  | 'Queued'
  | 'Current'
  | 'In Progress'
  | 'Completed'
  | 'Blocked'
  | 'Dropped'
  | 'Deferred';

/**
 * Mission record from the database.
 */
export interface Mission {
  id: string;
  sprint_id: string | null;
  name: string;
  status: MissionStatus;
  completed_at: string | null;
  notes: string | null;
  objective: string | null;
  context: string | null;
  success_criteria: string | null; // JSON array
  deliverables: string | null; // JSON array
  reference_docs: string | null; // JSON array
  domain_fields: string | null; // JSON object
  metadata: string | null; // JSON object
}

/**
 * Sprint record from the database.
 */
export interface Sprint {
  id: string;
  title: string;
  focus: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  total_missions: number | null;
  completed_missions: number | null;
}

/**
 * Context record from the database.
 */
export interface Context {
  id: string;
  source_path: string;
  content: string; // JSON object
  updated_at: string | null;
}

/**
 * Session record from the database.
 */
export interface Session {
  id: string;
  type: string;
  title: string;
  sprint_id: string | null;
  started_at: string;
  completed_at: string | null;
  agent: string;
  summary: string | null;
  status: string;
  captures: string | null; // JSON array
  next_steps: string | null; // JSON array
  metadata: string | null; // JSON object
}

/**
 * Database health check result.
 */
export interface DbHealthResult {
  connected: boolean;
  version: string;
  path: string;
  tables: string[];
  missionCount: number;
  sessionCount: number;
  contextCount: number;
}

/**
 * Mission list query parameters.
 */
export interface MissionListParams {
  status?: MissionStatus;
  sprintId?: string;
  limit?: number;
  includeDeleted?: boolean;
}

/**
 * Mission state transition event.
 */
export interface MissionStateChange {
  missionId: string;
  fromStatus: MissionStatus | null;
  toStatus: MissionStatus;
  changedAt: string;
  changedBy: string;
  notes?: string;
}

/**
 * Per-action parameter lists for one action-bearing tool — s86-m04's applicability contract.
 *
 * Keyed by the tool's action union and constrained to its own parameter type, so naming a
 * parameter the tool does not declare (or leaving one behind after a rename) is a COMPILE error
 * rather than a row that silently fails to render. Lives here, not beside the registry in
 * action-params.ts, so a tool module can type its map without importing the module that imports it.
 *
 * See src/tools/cmos/action-params.ts for why the maps are authored rather than generated.
 */
export type ActionParamMap<Action extends string, Params> = Readonly<
  Record<Action, readonly (keyof Params & string)[]>
>;
