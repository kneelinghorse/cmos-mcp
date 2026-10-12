/**
 * Reasonbook Tools - Barrel Export
 *
 * Central export point for all Reasonbook MCP tools.
 * Tools are organized by category:
 * - Database reads (query operations)
 * - Lifecycle mutations (state changes)
 * - Context operations
 * - Session management
 * - Administrative/utility
 *
 * @module tools/rbook
 */

// Type definitions
export type {
  RbookToolError,
  RbookToolResult,
  MissionStatus,
  Mission,
  Sprint,
  Context,
  Session,
  DbHealthResult,
  MissionListParams,
  MissionStateChange,
} from './types';

// Error handling utilities
export {
  RBOOK_ERROR_CODES,
  VALID_MISSION_STATUSES,
  VALID_STATE_TRANSITIONS,
  transitionsFrom,
  VALID_SESSION_TYPES,
  VALID_CONTEXT_TYPES,
  createError,
  createSuccess,
  RbookErrors,
} from './errors';

export type { RbookErrorCode, SessionType, ContextType } from './errors';

// Database client
export {
  RbookDatabaseClient,
  withClient,
  withClientAsync,
  withClientValidated,
  resolveProjectRoot,
  RBOOK_PROJECT_ROOT_ENV,
  RBOOK_PROJECT_ID_ENV,
} from './client';

export type { RbookDatabaseClientOptions, QueryParams, MutationResult } from './client';

// Tool implementations
// - rbook-db-health.ts (Sprint 12, Mission 04) - DONE
// - rbook-mission-list.ts (Sprint 12, Mission 05) - DONE
// - rbook-mission-show.ts (Sprint 12, Mission 06) - DONE
// - rbook-mission-status.ts (Sprint 12, Mission 07) - DONE
// - etc.

// Database health tool
export { rbookDbHealth, rbookDbHealthToolDefinition, formatHealthForLLM } from './rbook-db-health';

export type { RbookDbHealthParams, RbookDbHealthResult } from './rbook-db-health';

// Database snapshot tool
export {
  rbookDbSnapshot,
  rbookDbSnapshotToolDefinition,
  formatDbSnapshotForLLM,
} from './rbook-db-snapshot';

export type {
  RbookDbSnapshotParams,
  RbookDbSnapshotResult,
  DbSnapshotMetadata,
} from './rbook-db-snapshot';

// Database restore tool
export {
  rbookDbRestore,
  rbookDbRestoreToolDefinition,
  formatDbRestoreForLLM,
} from './rbook-db-restore';

export type { RbookDbRestoreParams, RbookDbRestoreResult } from './rbook-db-restore';

// Mission list tool
export {
  rbookMissionList,
  rbookMissionListToolDefinition,
  formatMissionListForLLM,
} from './rbook-mission-list';

export type {
  RbookMissionListParams,
  RbookMissionListResult,
  MissionListItem,
} from './rbook-mission-list';

// Mission show tool
export {
  rbookMissionShow,
  rbookMissionShowToolDefinition,
  formatMissionShowForLLM,
} from './rbook-mission-show';

export type { RbookMissionShowParams, MissionShowResult, SprintInfo } from './rbook-mission-show';

// Mission status tool
export {
  rbookMissionStatus,
  rbookMissionStatusToolDefinition,
  formatMissionStatusForLLM,
} from './rbook-mission-status';

export type {
  RbookMissionStatusParams,
  RbookMissionStatusResult,
  StatusMissionItem,
  SprintContext,
} from './rbook-mission-status';

// Mission lifecycle tools (Sprint 13, Mission 01)
export {
  rbookMissionStart,
  rbookMissionStartToolDefinition,
  formatMissionStartForLLM,
} from './rbook-mission-start';

export type { RbookMissionStartParams, MissionStartResult } from './rbook-mission-start';

export {
  rbookMissionComplete,
  rbookMissionCompleteToolDefinition,
  formatMissionCompleteForLLM,
} from './rbook-mission-complete';

export type { RbookMissionCompleteParams, MissionCompleteResult } from './rbook-mission-complete';

export {
  rbookMissionBlock,
  rbookMissionBlockToolDefinition,
  formatMissionBlockForLLM,
} from './rbook-mission-block';

export type { RbookMissionBlockParams, MissionBlockResult } from './rbook-mission-block';

export {
  rbookMissionUnblock,
  rbookMissionUnblockToolDefinition,
  formatMissionUnblockForLLM,
} from './rbook-mission-unblock';

export type { RbookMissionUnblockParams, MissionUnblockResult } from './rbook-mission-unblock';

export {
  rbookMissionUpdate,
  rbookMissionUpdateToolDefinition,
  formatMissionUpdateForLLM,
} from './rbook-mission-update';

export type {
  RbookMissionUpdateParams,
  MissionUpdateResult,
  MissionUpdateFields,
} from './rbook-mission-update';

// Context tools (Sprint 13, Mission 02)
export {
  rbookContextView,
  rbookContextViewToolDefinition,
  formatContextViewForLLM,
} from './rbook-context-view';

export type {
  RbookContextViewParams,
  RbookContextViewResult,
  ParsedContext,
} from './rbook-context-view';

export {
  rbookContextUpdate,
  rbookContextUpdateToolDefinition,
  formatContextUpdateForLLM,
} from './rbook-context-update';

export type { RbookContextUpdateParams, RbookContextUpdateResult } from './rbook-context-update';

export {
  rbookContextCondense,
  rbookContextCondenseToolDefinition,
  formatContextCondenseForLLM,
} from './rbook-context-condense';

export type {
  RbookContextCondenseParams,
  RbookContextCondenseResult,
  SectionCondensation,
} from './rbook-context-condense';

export {
  rbookContextSnapshot,
  rbookContextSnapshotToolDefinition,
  formatContextSnapshotForLLM,
} from './rbook-context-snapshot';

export type {
  RbookContextSnapshotParams,
  RbookContextSnapshotResult,
} from './rbook-context-snapshot';

export {
  rbookContextHistory,
  rbookContextHistoryToolDefinition,
  formatContextHistoryForLLM,
} from './rbook-context-history';

export type {
  RbookContextHistoryParams,
  RbookContextHistoryResult,
  ContextSnapshotEntry,
} from './rbook-context-history';

// Session tools (Sprint 13, Mission 03)
// Note: VALID_SESSION_TYPES and SessionType are exported from ./errors
export {
  rbookSessionStart,
  rbookSessionStartToolDefinition,
  formatSessionStartForLLM,
} from './rbook-session-start';

export type { RbookSessionStartParams, RbookSessionStartResult } from './rbook-session-start';

export {
  rbookSessionCapture,
  rbookSessionCaptureToolDefinition,
  formatSessionCaptureForLLM,
  VALID_CAPTURE_CATEGORIES,
} from './rbook-session-capture';

export type {
  RbookSessionCaptureParams,
  RbookSessionCaptureResult,
  CaptureCategory,
} from './rbook-session-capture';

export {
  rbookSessionComplete,
  rbookSessionCompleteToolDefinition,
  formatSessionCompleteForLLM,
} from './rbook-session-complete';

export type {
  RbookSessionCompleteParams,
  RbookSessionCompleteResult,
} from './rbook-session-complete';

export {
  rbookSessionList,
  rbookSessionListToolDefinition,
  formatSessionListForLLM,
  VALID_SESSION_STATUSES,
} from './rbook-session-list';

export type {
  RbookSessionListParams,
  RbookSessionListResult,
  SessionListItem,
  SessionStatus,
} from './rbook-session-list';

// Consolidated mission tool (Sprint 24, Mission 01)
export { rbookMission, rbookMissionToolDefinition, formatMissionForLLM } from './rbook-mission';

export type { RbookMissionAction, RbookMissionParams, RbookMissionResult } from './rbook-mission';

// Consolidated mission transition tool (Sprint 24, Mission 01)
export {
  rbookMissionTransition,
  rbookMissionTransitionToolDefinition,
  formatMissionTransitionForLLM,
} from './rbook-mission-transition';

export type {
  RbookMissionTransitionAction,
  RbookMissionTransitionParams,
  RbookMissionTransitionResult,
} from './rbook-mission-transition';

// Consolidated sprint tool (Sprint 23, Mission 04 proof of concept)
export { rbookSprint, rbookSprintToolDefinition, formatSprintForLLM } from './rbook-sprint';

export type { RbookSprintAction, RbookSprintParams, RbookSprintResult } from './rbook-sprint';

// Consolidated context tool (Sprint 24, Mission 02)
export { rbookContext, rbookContextToolDefinition, formatContextForLLM } from './rbook-context';

export type { RbookContextAction, RbookContextParams, RbookContextResult } from './rbook-context';

// Next-steps lifecycle handler (Sprint 40, Mission 02)
export { rbookNextSteps, formatNextStepsForLLM } from './rbook-next-steps';
export type { NextStepsResult, NextStepRecord, RbookNextStepsParams } from './rbook-next-steps';

// Constraints lifecycle handler (Sprint 40, Mission 03)
export {
  rbookConstraints,
  formatConstraintsForLLM,
  getStaleConstraintCount,
} from './rbook-constraints';
export type {
  ConstraintsResult,
  ConstraintRecord,
  ConstraintReviewItem,
  RbookConstraintsParams,
} from './rbook-constraints';

// Consolidated session tool (Sprint 24, Mission 02)
export { rbookSession, rbookSessionToolDefinition, formatSessionForLLM } from './rbook-session';

export type { RbookSessionAction, RbookSessionParams, RbookSessionResult } from './rbook-session';

// Consolidated decisions tool (Sprint 24, Mission 02)
export {
  rbookDecisions,
  rbookDecisionsToolDefinition,
  formatDecisionsForLLM,
} from './rbook-decisions';

export type {
  RbookDecisionsAction,
  RbookDecisionsParams,
  RbookDecisionsResult,
} from './rbook-decisions';

// Consolidated learnings tool (Sprint 38, Mission 01)
export {
  rbookLearnings,
  rbookLearningsToolDefinition,
  formatLearningsForLLM,
} from './rbook-learnings';

// Consolidated feedback tool (Sprint 56, Mission 03)
export { rbookFeedback, rbookFeedbackToolDefinition, formatFeedbackForLLM } from './rbook-feedback';

// Sprint 62 m06: at-a-glance status payload, 5 frozen fields per dashboard team msg 416315a7.
export { rbookStatus, rbookStatusToolDefinition, formatStatusForLLM } from './rbook-status';
export type { RbookStatusResult, RbookStatusParams } from './rbook-status';
export {
  rbookAuth,
  rbookAuthToolDefinition,
  formatAuthForLLM,
  RBOOK_AUTH_ACTIONS,
} from './rbook-auth';
export type {
  RbookAuthParams,
  RbookAuthResult,
  RbookAuthAction,
  RbookAuthDependencies,
  RotateActionResult,
  RevokeActionResult,
  ListActionResult,
  ReissueActionResult,
} from './rbook-auth';

export type {
  RbookFeedbackAction,
  RbookFeedbackParams,
  RbookFeedbackResult,
  RbookFeedbackListResult,
  RbookFeedbackMutationResult,
  AgentFeedbackEntry,
} from './rbook-feedback';

export type {
  RbookLearningsAction,
  RbookLearningsParams,
  RbookLearningsResult,
} from './rbook-learnings';

export { rbookLearningsList, formatLearningsListForLLM } from './rbook-learnings-list';

export type {
  RbookLearningsListParams,
  RbookLearningsListResult,
  Learning,
} from './rbook-learnings-list';

export { rbookLearningsSearch, formatLearningsSearchForLLM } from './rbook-learnings-search';

export type {
  RbookLearningsSearchParams,
  RbookLearningsSearchResult,
  LearningSearchResult,
} from './rbook-learnings-search';

export { rbookLearningsUpdate, formatLearningsUpdateForLLM } from './rbook-learnings-update';

export type {
  RbookLearningsUpdateParams,
  RbookLearningsUpdateResult,
} from './rbook-learnings-update';

// Consolidated DB admin tool (Sprint 24, Mission 03)
export { rbookDb, rbookDbToolDefinition, formatDbForLLM } from './rbook-db';

export type { RbookDbAction, RbookDbParams, RbookDbResult } from './rbook-db';

// Consolidated project tool (Sprint 24, Mission 03)
export { rbookProject, rbookProjectToolDefinition, formatProjectForLLM } from './rbook-project';

export type { RbookProjectAction, RbookProjectParams, RbookProjectResult } from './rbook-project';

// Sprint tools (Sprint 14, Mission 02)
export {
  rbookSprintList,
  rbookSprintListToolDefinition,
  formatSprintListForLLM,
} from './rbook-sprint-list';

export type {
  RbookSprintListParams,
  RbookSprintListResult,
  SprintListItem,
} from './rbook-sprint-list';

export {
  rbookSprintShow,
  rbookSprintShowToolDefinition,
  formatSprintShowForLLM,
} from './rbook-sprint-show';

export type {
  RbookSprintShowParams,
  SprintShowResult,
  SprintMissionSummary,
} from './rbook-sprint-show';

export {
  rbookSprintAdd,
  rbookSprintAddToolDefinition,
  formatSprintAddForLLM,
} from './rbook-sprint-add';

export type { RbookSprintAddParams, SprintAddResult } from './rbook-sprint-add';

export {
  rbookSprintComplete,
  rbookSprintCompleteToolDefinition,
  formatSprintCompleteForLLM,
} from './rbook-sprint-complete';

export type { RbookSprintCompleteParams, RbookSprintCompleteResult } from './rbook-sprint-complete';

export {
  rbookSprintUpdate,
  rbookSprintUpdateToolDefinition,
  formatSprintUpdateForLLM,
} from './rbook-sprint-update';

export type {
  RbookSprintUpdateParams,
  SprintUpdateResult,
  SprintUpdateFields,
} from './rbook-sprint-update';

// Mission creation tools (Sprint 14, Mission 03)
export {
  rbookMissionAdd,
  rbookMissionAddToolDefinition,
  formatMissionAddForLLM,
} from './rbook-mission-add';

export type { RbookMissionAddParams, MissionAddResult } from './rbook-mission-add';

export {
  rbookMissionDepends,
  rbookMissionDependsToolDefinition,
  formatMissionDependsForLLM,
  VALID_DEPENDENCY_TYPES,
} from './rbook-mission-depends';

export type {
  RbookMissionDependsParams,
  MissionDependsResult,
  DependencyType,
} from './rbook-mission-depends';

export { rbookMissionUndepends, formatMissionUndependsForLLM } from './rbook-mission-undepends';

export type {
  RbookMissionUndependsParams,
  MissionUndependsResult,
} from './rbook-mission-undepends';

// Agent utility tools (Sprint 14, Mission 04)
export {
  rbookAgentOnboard,
  rbookAgentOnboardToolDefinition,
  formatAgentOnboardForLLM,
} from './rbook-agent-onboard';

export type {
  RbookAgentOnboardParams,
  RbookAgentOnboardResult,
  ProjectIdentity,
  ActiveSessionSummary,
  PendingMissionSummary,
  RecentDecisionSummary,
  SprintContext as AgentSprintContext,
  SuggestedAction,
  MessagingSummary,
  RecentMessageSummary,
} from './rbook-agent-onboard';

// Bundled session-opener digest (Sprint 64 m03)
export { rbookReview, rbookReviewToolDefinition, formatReviewForLLM } from './rbook-review';

// s86-m04: the per-action applicability contract, read by the TOOL_REFERENCE renderer from the
// COMPILED barrel (scripts/generate-tool-reference.js) and by its freshness gate from src.
export { RBOOK_ACTION_PARAMS } from './action-params';

export type {
  RbookReviewParams,
  RbookReviewResult,
  NextAction as ReviewNextAction,
  WorkItem as ReviewWorkItem,
  WorkQueueBucket as ReviewWorkQueueBucket,
} from './rbook-review';

// Orphan detection (Sprint 33, Mission 03)
export { detectOrphans, buildOrphanWarnings } from './orphan-detection';

export type {
  OrphanedSprint,
  OrphanedMission,
  StaleSession,
  OrphanDetectionResult,
} from './orphan-detection';

export {
  rbookDecisionsList,
  rbookDecisionsListToolDefinition,
  formatDecisionsListForLLM,
} from './rbook-decisions-list';

export type {
  RbookDecisionsListParams,
  RbookDecisionsListResult,
  StrategicDecision,
} from './rbook-decisions-list';

export {
  rbookDecisionsSearch,
  rbookDecisionsSearchToolDefinition,
  formatDecisionsSearchForLLM,
} from './rbook-decisions-search';

export type {
  RbookDecisionsSearchParams,
  RbookDecisionsSearchResult,
  DecisionSearchResult,
} from './rbook-decisions-search';

// Project init tool (Sprint 20)
export {
  rbookProjectInit,
  rbookProjectInitToolDefinition,
  formatProjectInitForLLM,
  resolveSeedPath,
} from './rbook-project-init';

export type { RbookProjectInitInput, RbookProjectInitResult } from './rbook-project-init';

// Project registry tools (Sprint 15, Mission 02)
export {
  rbookProjectRegister,
  rbookProjectRegisterToolDefinition,
  formatProjectRegisterForLLM,
} from './rbook-project-register';

export type { RbookProjectRegisterParams, ProjectRegisterResult } from './rbook-project-register';

export {
  rbookProjectList,
  rbookProjectListToolDefinition,
  formatProjectListForLLM,
} from './rbook-project-list';

export type {
  RbookProjectListParams,
  ProjectListResult,
  ProjectListItem,
  ProjectListSummary,
} from './rbook-project-list';

export {
  rbookProjectUnregister,
  rbookProjectUnregisterToolDefinition,
  formatProjectUnregisterForLLM,
} from './rbook-project-unregister';

export type {
  RbookProjectUnregisterParams,
  ProjectUnregisterResult,
} from './rbook-project-unregister';

export {
  rbookProjectValidate,
  rbookProjectValidateToolDefinition,
  formatProjectValidateForLLM,
} from './rbook-project-validate';

export type {
  RbookProjectValidateParams,
  ProjectValidateResult,
  ProjectValidationItem,
  ValidationSummary,
} from './rbook-project-validate';

// Schema migrations
export {
  ensureStrategicDecisionsSchema,
  ensureMissionTimestamps,
  ensureLearningsTable,
  ensureDecisionsFts5,
  ensureVectorStorage,
  migrateStrategicDecisionsV21,
  DECISION_CATEGORIES,
  DECISION_STATUSES,
  LEARNING_CATEGORIES,
  migrateContentHash,
  computeContentHash,
} from './schema-migrations';

export type {
  MigrationResult,
  DecisionCategory,
  DecisionStatus,
  LearningCategory,
} from './schema-migrations';

// Consolidated message tool (Sprint 28)
export {
  rbookMessage,
  rbookMessageToolDefinition,
  formatMessageForLLM,
  getWhoamiDiagnostics,
} from './rbook-message';

export type {
  RbookMessageAction,
  RbookMessageParams,
  RbookMessageResult,
  MessageSendResult,
  MessageListResult,
  MessageRespondResult,
  MessageWhoamiResult,
} from './rbook-message';

// Dashboard client (Sprint 28, auth refactored Sprint 28 hotfix)
export {
  DashboardClient,
  RBOOK_DASHBOARD_URL_ENV,
  RBOOK_DASHBOARD_USER_ENV,
  RBOOK_DASHBOARD_PASSWORD_ENV,
} from './dashboard-client';

export type {
  DashboardClientConfig,
  LoginResponse,
  DashboardMessage,
  SendMessageParams,
  ListMessagesParams,
  ListMessagesResult as DashboardListMessagesResult,
  RespondToMessageParams,
  ResolveAddressParams,
  ResolveAddressResult,
  SyncStatusResult,
  SyncStatusTableCount,
  SyncProjectStateResult,
} from './dashboard-client';

// Sync health check (read-only diagnostics)
export { checkSyncHealth, formatSyncHealthForLLM } from './sync-health-check';

export type { SyncHealthCheckResult } from './sync-health-check';

import { rbookMissionToolDefinition as missionTool } from './rbook-mission';
import { rbookMissionTransitionToolDefinition as missionTransitionTool } from './rbook-mission-transition';
import { rbookSprintToolDefinition as sprintTool } from './rbook-sprint';
import { rbookContextToolDefinition as contextTool } from './rbook-context';
import { rbookSessionToolDefinition as sessionTool } from './rbook-session';
import { rbookDecisionsToolDefinition as decisionsTool } from './rbook-decisions';
import { rbookDbToolDefinition as dbTool } from './rbook-db';
import { rbookProjectToolDefinition as projectTool } from './rbook-project';
import { rbookAgentOnboardToolDefinition as agentOnboardTool } from './rbook-agent-onboard';
import { rbookMessageToolDefinition as messageTool } from './rbook-message';
import { rbookLearningsToolDefinition as learningsTool } from './rbook-learnings';
import { rbookFeedbackToolDefinition as feedbackTool } from './rbook-feedback';
import { rbookAuthToolDefinition as authTool } from './rbook-auth';
import { rbookStatusToolDefinition as statusTool } from './rbook-status';
import { rbookReviewToolDefinition as reviewTool } from './rbook-review';

/**
 * Reasonbook tool definitions for MCP registration.
 * Sprint 38: 11 consolidated tools + rbook_agent_onboard.
 */
export const RBOOK_TOOL_DEFINITIONS = [
  // Consolidated entity tools (Sprint 24)
  missionTool,
  missionTransitionTool,
  sprintTool,
  contextTool,
  sessionTool,
  decisionsTool,
  dbTool,
  projectTool,

  // Learnings (Sprint 38)
  learningsTool,

  // Agent feedback channel (Sprint 56 m03)
  feedbackTool,

  // Agent-callable credential lifecycle (Sprint 57 m03)
  authTool,

  // Messaging (Sprint 28)
  messageTool,

  // Agent utilities (standalone)
  agentOnboardTool,

  // At-a-glance status payload (Sprint 62 m06)
  statusTool,

  // Bundled session-opener digest (Sprint 64 m03)
  reviewTool,
] as const;
