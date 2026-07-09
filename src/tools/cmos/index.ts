/**
 * CMOS Tools - Barrel Export
 *
 * Central export point for all CMOS MCP tools.
 * Tools are organized by category:
 * - Database reads (query operations)
 * - Lifecycle mutations (state changes)
 * - Context operations
 * - Session management
 * - Administrative/utility
 *
 * @module tools/cmos
 */

// Type definitions
export type {
  CmosToolError,
  CmosToolResult,
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
  CMOS_ERROR_CODES,
  VALID_MISSION_STATUSES,
  VALID_STATE_TRANSITIONS,
  VALID_SESSION_TYPES,
  VALID_CONTEXT_TYPES,
  createError,
  createSuccess,
  CmosErrors,
} from './errors';

export type { CmosErrorCode, SessionType, ContextType } from './errors';

// Database client
export {
  CmosDatabaseClient,
  withClient,
  withClientAsync,
  withClientValidated,
  resolveProjectRoot,
  CMOS_PROJECT_ROOT_ENV,
  CMOS_PROJECT_ID_ENV,
} from './client';

export type { CmosDatabaseClientOptions, QueryParams, MutationResult } from './client';

// Tool implementations
// - cmos-db-health.ts (Sprint 12, Mission 04) - DONE
// - cmos-mission-list.ts (Sprint 12, Mission 05) - DONE
// - cmos-mission-show.ts (Sprint 12, Mission 06) - DONE
// - cmos-mission-status.ts (Sprint 12, Mission 07) - DONE
// - etc.

// Database health tool
export { cmosDbHealth, cmosDbHealthToolDefinition, formatHealthForLLM } from './cmos-db-health';

export type { CmosDbHealthParams, CmosDbHealthResult } from './cmos-db-health';

// Database snapshot tool
export {
  cmosDbSnapshot,
  cmosDbSnapshotToolDefinition,
  formatDbSnapshotForLLM,
} from './cmos-db-snapshot';

export type {
  CmosDbSnapshotParams,
  CmosDbSnapshotResult,
  DbSnapshotMetadata,
} from './cmos-db-snapshot';

// Database restore tool
export {
  cmosDbRestore,
  cmosDbRestoreToolDefinition,
  formatDbRestoreForLLM,
} from './cmos-db-restore';

export type { CmosDbRestoreParams, CmosDbRestoreResult } from './cmos-db-restore';

// Mission list tool
export {
  cmosMissionList,
  cmosMissionListToolDefinition,
  formatMissionListForLLM,
} from './cmos-mission-list';

export type {
  CmosMissionListParams,
  CmosMissionListResult,
  MissionListItem,
} from './cmos-mission-list';

// Mission show tool
export {
  cmosMissionShow,
  cmosMissionShowToolDefinition,
  formatMissionShowForLLM,
} from './cmos-mission-show';

export type { CmosMissionShowParams, MissionShowResult, SprintInfo } from './cmos-mission-show';

// Mission status tool
export {
  cmosMissionStatus,
  cmosMissionStatusToolDefinition,
  formatMissionStatusForLLM,
} from './cmos-mission-status';

export type {
  CmosMissionStatusParams,
  CmosMissionStatusResult,
  StatusMissionItem,
  SprintContext,
} from './cmos-mission-status';

// Mission lifecycle tools (Sprint 13, Mission 01)
export {
  cmosMissionStart,
  cmosMissionStartToolDefinition,
  formatMissionStartForLLM,
} from './cmos-mission-start';

export type { CmosMissionStartParams, MissionStartResult } from './cmos-mission-start';

export {
  cmosMissionComplete,
  cmosMissionCompleteToolDefinition,
  formatMissionCompleteForLLM,
} from './cmos-mission-complete';

export type { CmosMissionCompleteParams, MissionCompleteResult } from './cmos-mission-complete';

export {
  cmosMissionBlock,
  cmosMissionBlockToolDefinition,
  formatMissionBlockForLLM,
} from './cmos-mission-block';

export type { CmosMissionBlockParams, MissionBlockResult } from './cmos-mission-block';

export {
  cmosMissionUnblock,
  cmosMissionUnblockToolDefinition,
  formatMissionUnblockForLLM,
} from './cmos-mission-unblock';

export type { CmosMissionUnblockParams, MissionUnblockResult } from './cmos-mission-unblock';

export {
  cmosMissionUpdate,
  cmosMissionUpdateToolDefinition,
  formatMissionUpdateForLLM,
} from './cmos-mission-update';

export type {
  CmosMissionUpdateParams,
  MissionUpdateResult,
  MissionUpdateFields,
} from './cmos-mission-update';

// Context tools (Sprint 13, Mission 02)
export {
  cmosContextView,
  cmosContextViewToolDefinition,
  formatContextViewForLLM,
} from './cmos-context-view';

export type {
  CmosContextViewParams,
  CmosContextViewResult,
  ParsedContext,
} from './cmos-context-view';

export {
  cmosContextUpdate,
  cmosContextUpdateToolDefinition,
  formatContextUpdateForLLM,
} from './cmos-context-update';

export type { CmosContextUpdateParams, CmosContextUpdateResult } from './cmos-context-update';

export {
  cmosContextCondense,
  cmosContextCondenseToolDefinition,
  formatContextCondenseForLLM,
} from './cmos-context-condense';

export type {
  CmosContextCondenseParams,
  CmosContextCondenseResult,
  SectionCondensation,
} from './cmos-context-condense';

export {
  cmosContextSnapshot,
  cmosContextSnapshotToolDefinition,
  formatContextSnapshotForLLM,
} from './cmos-context-snapshot';

export type { CmosContextSnapshotParams, CmosContextSnapshotResult } from './cmos-context-snapshot';

export {
  cmosContextHistory,
  cmosContextHistoryToolDefinition,
  formatContextHistoryForLLM,
} from './cmos-context-history';

export type {
  CmosContextHistoryParams,
  CmosContextHistoryResult,
  ContextSnapshotEntry,
} from './cmos-context-history';

// Session tools (Sprint 13, Mission 03)
// Note: VALID_SESSION_TYPES and SessionType are exported from ./errors
export {
  cmosSessionStart,
  cmosSessionStartToolDefinition,
  formatSessionStartForLLM,
} from './cmos-session-start';

export type { CmosSessionStartParams, CmosSessionStartResult } from './cmos-session-start';

export {
  cmosSessionCapture,
  cmosSessionCaptureToolDefinition,
  formatSessionCaptureForLLM,
  VALID_CAPTURE_CATEGORIES,
} from './cmos-session-capture';

export type {
  CmosSessionCaptureParams,
  CmosSessionCaptureResult,
  CaptureCategory,
} from './cmos-session-capture';

export {
  cmosSessionComplete,
  cmosSessionCompleteToolDefinition,
  formatSessionCompleteForLLM,
} from './cmos-session-complete';

export type { CmosSessionCompleteParams, CmosSessionCompleteResult } from './cmos-session-complete';

export {
  cmosSessionList,
  cmosSessionListToolDefinition,
  formatSessionListForLLM,
  VALID_SESSION_STATUSES,
} from './cmos-session-list';

export type {
  CmosSessionListParams,
  CmosSessionListResult,
  SessionListItem,
  SessionStatus,
} from './cmos-session-list';

// Consolidated mission tool (Sprint 24, Mission 01)
export { cmosMission, cmosMissionToolDefinition, formatMissionForLLM } from './cmos-mission';

export type { CmosMissionAction, CmosMissionParams, CmosMissionResult } from './cmos-mission';

// Consolidated mission transition tool (Sprint 24, Mission 01)
export {
  cmosMissionTransition,
  cmosMissionTransitionToolDefinition,
  formatMissionTransitionForLLM,
} from './cmos-mission-transition';

export type {
  CmosMissionTransitionAction,
  CmosMissionTransitionParams,
  CmosMissionTransitionResult,
} from './cmos-mission-transition';

// Consolidated sprint tool (Sprint 23, Mission 04 proof of concept)
export { cmosSprint, cmosSprintToolDefinition, formatSprintForLLM } from './cmos-sprint';

export type { CmosSprintAction, CmosSprintParams, CmosSprintResult } from './cmos-sprint';

// Consolidated context tool (Sprint 24, Mission 02)
export { cmosContext, cmosContextToolDefinition, formatContextForLLM } from './cmos-context';

export type { CmosContextAction, CmosContextParams, CmosContextResult } from './cmos-context';

// Next-steps lifecycle handler (Sprint 40, Mission 02)
export { cmosNextSteps, formatNextStepsForLLM } from './cmos-next-steps';
export type { NextStepsResult, NextStepRecord, CmosNextStepsParams } from './cmos-next-steps';

// Constraints lifecycle handler (Sprint 40, Mission 03)
export {
  cmosConstraints,
  formatConstraintsForLLM,
  getStaleConstraintCount,
} from './cmos-constraints';
export type {
  ConstraintsResult,
  ConstraintRecord,
  ConstraintReviewItem,
  CmosConstraintsParams,
} from './cmos-constraints';

// Consolidated session tool (Sprint 24, Mission 02)
export { cmosSession, cmosSessionToolDefinition, formatSessionForLLM } from './cmos-session';

export type { CmosSessionAction, CmosSessionParams, CmosSessionResult } from './cmos-session';

// Consolidated decisions tool (Sprint 24, Mission 02)
export {
  cmosDecisions,
  cmosDecisionsToolDefinition,
  formatDecisionsForLLM,
} from './cmos-decisions';

export type {
  CmosDecisionsAction,
  CmosDecisionsParams,
  CmosDecisionsResult,
} from './cmos-decisions';

// Consolidated learnings tool (Sprint 38, Mission 01)
export {
  cmosLearnings,
  cmosLearningsToolDefinition,
  formatLearningsForLLM,
} from './cmos-learnings';

// Consolidated feedback tool (Sprint 56, Mission 03)
export { cmosFeedback, cmosFeedbackToolDefinition, formatFeedbackForLLM } from './cmos-feedback';

// Sprint 62 m06: at-a-glance status payload, 5 frozen fields per dashboard team msg 416315a7.
export { cmosStatus, cmosStatusToolDefinition, formatStatusForLLM } from './cmos-status';
export type { CmosStatusResult, CmosStatusParams } from './cmos-status';
export { cmosAuth, cmosAuthToolDefinition, formatAuthForLLM, CMOS_AUTH_ACTIONS } from './cmos-auth';
export type {
  CmosAuthParams,
  CmosAuthResult,
  CmosAuthAction,
  CmosAuthDependencies,
  RotateActionResult,
  RevokeActionResult,
  ListActionResult,
  ReissueActionResult,
} from './cmos-auth';

export type {
  CmosFeedbackAction,
  CmosFeedbackParams,
  CmosFeedbackResult,
  CmosFeedbackListResult,
  CmosFeedbackMutationResult,
  AgentFeedbackEntry,
} from './cmos-feedback';

export type {
  CmosLearningsAction,
  CmosLearningsParams,
  CmosLearningsResult,
} from './cmos-learnings';

export { cmosLearningsList, formatLearningsListForLLM } from './cmos-learnings-list';

export type {
  CmosLearningsListParams,
  CmosLearningsListResult,
  Learning,
} from './cmos-learnings-list';

export { cmosLearningsSearch, formatLearningsSearchForLLM } from './cmos-learnings-search';

export type {
  CmosLearningsSearchParams,
  CmosLearningsSearchResult,
  LearningSearchResult,
} from './cmos-learnings-search';

export { cmosLearningsUpdate, formatLearningsUpdateForLLM } from './cmos-learnings-update';

export type { CmosLearningsUpdateParams, CmosLearningsUpdateResult } from './cmos-learnings-update';

// Consolidated DB admin tool (Sprint 24, Mission 03)
export { cmosDb, cmosDbToolDefinition, formatDbForLLM } from './cmos-db';

export type { CmosDbAction, CmosDbParams, CmosDbResult } from './cmos-db';

// Consolidated project tool (Sprint 24, Mission 03)
export { cmosProject, cmosProjectToolDefinition, formatProjectForLLM } from './cmos-project';

export type { CmosProjectAction, CmosProjectParams, CmosProjectResult } from './cmos-project';

// Sprint tools (Sprint 14, Mission 02)
export {
  cmosSprintList,
  cmosSprintListToolDefinition,
  formatSprintListForLLM,
} from './cmos-sprint-list';

export type {
  CmosSprintListParams,
  CmosSprintListResult,
  SprintListItem,
} from './cmos-sprint-list';

export {
  cmosSprintShow,
  cmosSprintShowToolDefinition,
  formatSprintShowForLLM,
} from './cmos-sprint-show';

export type {
  CmosSprintShowParams,
  SprintShowResult,
  SprintMissionSummary,
} from './cmos-sprint-show';

export {
  cmosSprintAdd,
  cmosSprintAddToolDefinition,
  formatSprintAddForLLM,
} from './cmos-sprint-add';

export type { CmosSprintAddParams, SprintAddResult } from './cmos-sprint-add';

export {
  cmosSprintComplete,
  cmosSprintCompleteToolDefinition,
  formatSprintCompleteForLLM,
} from './cmos-sprint-complete';

export type { CmosSprintCompleteParams, CmosSprintCompleteResult } from './cmos-sprint-complete';

export {
  cmosSprintUpdate,
  cmosSprintUpdateToolDefinition,
  formatSprintUpdateForLLM,
} from './cmos-sprint-update';

export type {
  CmosSprintUpdateParams,
  SprintUpdateResult,
  SprintUpdateFields,
} from './cmos-sprint-update';

// Mission creation tools (Sprint 14, Mission 03)
export {
  cmosMissionAdd,
  cmosMissionAddToolDefinition,
  formatMissionAddForLLM,
} from './cmos-mission-add';

export type { CmosMissionAddParams, MissionAddResult } from './cmos-mission-add';

export {
  cmosMissionDepends,
  cmosMissionDependsToolDefinition,
  formatMissionDependsForLLM,
  VALID_DEPENDENCY_TYPES,
} from './cmos-mission-depends';

export type {
  CmosMissionDependsParams,
  MissionDependsResult,
  DependencyType,
} from './cmos-mission-depends';

export { cmosMissionUndepends, formatMissionUndependsForLLM } from './cmos-mission-undepends';

export type { CmosMissionUndependsParams, MissionUndependsResult } from './cmos-mission-undepends';

// Agent utility tools (Sprint 14, Mission 04)
export {
  cmosAgentOnboard,
  cmosAgentOnboardToolDefinition,
  formatAgentOnboardForLLM,
} from './cmos-agent-onboard';

export type {
  CmosAgentOnboardParams,
  CmosAgentOnboardResult,
  ProjectIdentity,
  ActiveSessionSummary,
  PendingMissionSummary,
  RecentDecisionSummary,
  SprintContext as AgentSprintContext,
  SuggestedAction,
  MessagingSummary,
  RecentMessageSummary,
} from './cmos-agent-onboard';

// Bundled session-opener digest (Sprint 64 m03)
export { cmosReview, cmosReviewToolDefinition, formatReviewForLLM } from './cmos-review';

export type {
  CmosReviewParams,
  CmosReviewResult,
  NextAction as ReviewNextAction,
  WorkItem as ReviewWorkItem,
  WorkQueueBucket as ReviewWorkQueueBucket,
} from './cmos-review';

// Orphan detection (Sprint 33, Mission 03)
export { detectOrphans, buildOrphanWarnings } from './orphan-detection';

export type {
  OrphanedSprint,
  OrphanedMission,
  StaleSession,
  OrphanDetectionResult,
} from './orphan-detection';

export {
  cmosDecisionsList,
  cmosDecisionsListToolDefinition,
  formatDecisionsListForLLM,
} from './cmos-decisions-list';

export type {
  CmosDecisionsListParams,
  CmosDecisionsListResult,
  StrategicDecision,
} from './cmos-decisions-list';

export {
  cmosDecisionsSearch,
  cmosDecisionsSearchToolDefinition,
  formatDecisionsSearchForLLM,
} from './cmos-decisions-search';

export type {
  CmosDecisionsSearchParams,
  CmosDecisionsSearchResult,
  DecisionSearchResult,
} from './cmos-decisions-search';

// Project init tool (Sprint 20)
export {
  cmosProjectInit,
  cmosProjectInitToolDefinition,
  formatProjectInitForLLM,
  resolveSeedPath,
} from './cmos-project-init';

export type { CmosProjectInitInput, CmosProjectInitResult } from './cmos-project-init';

// Project registry tools (Sprint 15, Mission 02)
export {
  cmosProjectRegister,
  cmosProjectRegisterToolDefinition,
  formatProjectRegisterForLLM,
} from './cmos-project-register';

export type { CmosProjectRegisterParams, ProjectRegisterResult } from './cmos-project-register';

export {
  cmosProjectList,
  cmosProjectListToolDefinition,
  formatProjectListForLLM,
} from './cmos-project-list';

export type {
  CmosProjectListParams,
  ProjectListResult,
  ProjectListItem,
  ProjectListSummary,
} from './cmos-project-list';

export {
  cmosProjectUnregister,
  cmosProjectUnregisterToolDefinition,
  formatProjectUnregisterForLLM,
} from './cmos-project-unregister';

export type {
  CmosProjectUnregisterParams,
  ProjectUnregisterResult,
} from './cmos-project-unregister';

export {
  cmosProjectValidate,
  cmosProjectValidateToolDefinition,
  formatProjectValidateForLLM,
} from './cmos-project-validate';

export type {
  CmosProjectValidateParams,
  ProjectValidateResult,
  ProjectValidationItem,
  ValidationSummary,
} from './cmos-project-validate';

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
  cmosMessage,
  cmosMessageToolDefinition,
  formatMessageForLLM,
  getWhoamiDiagnostics,
} from './cmos-message';

export type {
  CmosMessageAction,
  CmosMessageParams,
  CmosMessageResult,
  MessageSendResult,
  MessageListResult,
  MessageRespondResult,
  MessageWhoamiResult,
} from './cmos-message';

// Dashboard client (Sprint 28, auth refactored Sprint 28 hotfix)
export {
  DashboardClient,
  CMOS_DASHBOARD_URL_ENV,
  CMOS_DASHBOARD_USER_ENV,
  CMOS_DASHBOARD_PASSWORD_ENV,
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

import { cmosMissionToolDefinition as missionTool } from './cmos-mission';
import { cmosMissionTransitionToolDefinition as missionTransitionTool } from './cmos-mission-transition';
import { cmosSprintToolDefinition as sprintTool } from './cmos-sprint';
import { cmosContextToolDefinition as contextTool } from './cmos-context';
import { cmosSessionToolDefinition as sessionTool } from './cmos-session';
import { cmosDecisionsToolDefinition as decisionsTool } from './cmos-decisions';
import { cmosDbToolDefinition as dbTool } from './cmos-db';
import { cmosProjectToolDefinition as projectTool } from './cmos-project';
import { cmosAgentOnboardToolDefinition as agentOnboardTool } from './cmos-agent-onboard';
import { cmosMessageToolDefinition as messageTool } from './cmos-message';
import { cmosLearningsToolDefinition as learningsTool } from './cmos-learnings';
import { cmosFeedbackToolDefinition as feedbackTool } from './cmos-feedback';
import { cmosAuthToolDefinition as authTool } from './cmos-auth';
import { cmosStatusToolDefinition as statusTool } from './cmos-status';
import { cmosReviewToolDefinition as reviewTool } from './cmos-review';

/**
 * CMOS tool definitions for MCP registration.
 * Sprint 38: 11 consolidated tools + cmos_agent_onboard.
 */
export const CMOS_TOOL_DEFINITIONS = [
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
