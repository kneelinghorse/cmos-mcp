// ABOUTME: Aggregates CMOS project state into the cold-start onboarding payload.
// ABOUTME: Also surfaces sender-attribution ambiguity so agents can verify whoami early.

/**
 * cmos_agent_onboard Tool
 *
 * MCP tool for agent onboarding/context initialization.
 * Returns an aggregated payload optimized for agent context windows (<4KB).
 * Combines data from contexts, missions, sessions, and decisions.
 *
 * @module tools/cmos/cmos-agent-onboard
 */

import { z } from 'zod';
import path from 'path';
import { withClientAsync, type CmosDatabaseClient } from './client';
import {
  calculateSelfCaptureGap,
  buildSelfCaptureWarning,
  type SelfCaptureGap,
} from './self-capture-guard';
import { CMOS_PROJECT_ROOT_ENV } from './client';
import type { CmosToolResult, Mission, Session, SanitizedFieldReport } from './types';
import { createSuccess } from './errors';
import { recordAgentFeedback } from './agent-feedback';
import { DashboardClient, type DashboardMessage } from './dashboard-client';
import { attributionSource } from './cmos-message';
import {
  foreignDescriptor,
  frameForeignInline,
  frameInlineIfForeign,
  isForeignProject,
  UNTRUSTED_CONTENT_CONTRACT,
  type ProvenanceDescriptor,
} from '../../intelligence/provenance-frame';
import { getProjectId, tableHasColumn } from './genesis-columns';
import {
  calculateContextFreshness,
  buildContextStalenessWarning,
  type ContextFreshness,
} from './context-freshness';
import {
  getProjectIdentity as getProjectIdentityData,
  backfillUnknownCmosAddress,
  type ProjectIdentityData,
  deriveProjectSlug,
} from './project-identity';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { SERVER_INSTALL_ROOT } from '../../intelligence/sender-context';
import { resolveAndPersistOwner } from './owner-resolution';
import {
  buildContextSizeWarning,
  calculateContextSizeMetrics,
  resolveContextSizeSettings,
  type ContextSizeMetrics,
} from './context-retention';
import { detectAndFlagStaleness } from './staleness-detection';
import { detectOrphans, buildOrphanWarnings, type OrphanDetectionResult } from './orphan-detection';
import { resolveCurrentSprintId } from './current-sprint';
import {
  getServerHealth,
  getServerProjectRoot,
  type ServerHealthStatus,
} from '../../server-health';
import { computeAuthState, type AuthState } from '../../auth/auth-state';
import { getStaleConstraintCount as getStaleConstraintCountFromConstraints } from './cmos-constraints';
import { loadTierConfig, type TierConfig } from './tier-config';
import { appendWarnings } from './format-warnings';

/**
 * Project identity from master context.
 */
export interface ProjectIdentity {
  /** Project name */
  name: string;

  /** Project description */
  description: string | null;

  /** Project status */
  status: string | null;

  /** Project type / tier: general, managed, or build */
  projectType: string;
}

/**
 * Active session summary.
 */
export interface ActiveSessionSummary {
  /** Session ID */
  id: string;

  /** Session type */
  type: string;

  /** Session title */
  title: string;

  /** When it started */
  startedAt: string;

  /** Capture count so far */
  captureCount: number;

  /** s84-m03: the session's own project_id (guarded read). Foreign → title framed. */
  projectId?: string | null;
}

/**
 * Pending mission summary.
 */
export interface PendingMissionSummary {
  /** Mission ID */
  id: string;

  /** Mission name */
  name: string;

  /** Mission status */
  status: string;

  /** Sprint ID if assigned */
  sprintId: string | null;

  /** s84-m03: the mission's own project_id (guarded read). Foreign → name framed untrusted. */
  projectId?: string | null;
}

/**
 * Recent decision summary.
 */
export interface RecentDecisionSummary {
  /** Decision text */
  decision: string;

  /** Domain (e.g., 'ai-studio', 'general') */
  domain: string | null;

  /** When the decision was made */
  createdAt: string;

  /** s83-m06: genesis project_id (null on ancient stores); a pull-merged FOREIGN
   *  decision carries the origin's id and is framed as untrusted in the render. */
  projectId: string | null;
}

/**
 * Tier-aware last session memory (Layer 2 — Session Memory).
 * Content depth varies by tier: general gets minimal, build gets full.
 */
export interface LastSessionData {
  /** Session ID */
  id: string;

  /** Session title */
  title: string;

  /** Session summary */
  summary: string | null;

  /** When the session completed */
  completedAt: string;

  /** Decisions captured in the session (managed + build tiers) */
  decisions?: string[];

  /** Next-steps captured in the session (managed + build tiers) */
  nextSteps?: string[];

  /** Open items from the next_steps table, status=pending (general + build tiers) */
  openItems?: string[];
}

/**
 * Sprint context for onboarding.
 */
export interface SprintContext {
  /** Sprint ID */
  id: string;

  /** Sprint title */
  title: string;

  /** Sprint status */
  status: string | null;

  /** Sprint focus area */
  focus: string | null;

  /** s84-m03: the sprint's own project_id (guarded read). Foreign → title/focus framed. */
  projectId?: string | null;
}

/**
 * Suggested action for the agent.
 */
export interface SuggestedAction {
  /** Action description */
  action: string;

  /** Command or tool to use */
  command: string;

  /** Priority (1 = highest) */
  priority: number;
}

/**
 * Result of agent onboard operation.
 * Optimized for agent context window consumption (<4KB).
 */
export interface CmosAgentOnboardResult {
  /** Project identity from master_context */
  project: ProjectIdentity;

  /** Current sprint context */
  currentSprint: SprintContext | null;

  /** Active session if any */
  activeSession: ActiveSessionSummary | null;

  /** Pending missions (In Progress, Current, Queued - limited) */
  pendingMissions: PendingMissionSummary[];

  /** Blocked missions that need attention */
  blockedMissions: PendingMissionSummary[];

  /** Recent strategic decisions (last 5-10) */
  recentDecisions: RecentDecisionSummary[];

  /**
   * s83-m06: the local project_id, so the renderer (and the cmos_review digest that
   * reuses recentDecisions) can frame any recent decision whose project_id differs
   * (a pull-merged FOREIGN row) as untrusted data.
   */
  localProjectId: string | null;

  /** Aggregated next steps from project_context */
  nextSteps: string[];

  /** Suggested first actions for the agent */
  suggestedActions: SuggestedAction[];

  /**
   * Sprint 57 m04 — local credential store + last deliveryAck snapshot, so
   * agents see auth state at first turn without an extra cmos_auth call.
   * `authState.warning` is also threaded into a suggestedAction when set.
   */
  authState?: AuthState;

  /** Session statistics */
  sessionStats: {
    totalSessions: number;
    lastActivity: string | null;
  };

  /** Context size telemetry for master/project contexts */
  contextSizes: {
    masterContext: ContextSizeMetrics | null;
    projectContext: ContextSizeMetrics | null;
    totalSizeKb: number;
    totalSizeBytes: number;
  };

  /** Freshness of master_context relative to completed mission/session activity */
  contextFreshness: ContextFreshness;

  /** s80-m07 — self-capture gap: are local commits ahead of the last CMOS write? */
  selfCapture: SelfCaptureGap;

  /** Staleness detection results for decisions and learnings */
  staleness: {
    staleDecisions: number;
    staleLearnings: number;
    threshold: number;
  };

  /** Messaging context from dashboard (null if dashboard unreachable) */
  messaging: MessagingSummary | null;

  /** Sync health reconciliation (null if dashboard unreachable) */
  syncHealth: SyncHealthSummary | null;

  /** Orphan detection results (orphaned sprints, missions, stale sessions) */
  orphans: OrphanDetectionResult;

  /** Server process health (uptime, memory, build staleness) */
  serverHealth: ServerHealthStatus;

  /** Tier configuration injected from cmos/tiers/{projectType}.md */
  tierConfig: TierConfig | null;

  /**
   * Whether this is a fresh project: zero active missions AND no PROJECT BRIEF marker
   * in master_context. Signals to the agent that first-session onboarding should run.
   */
  freshProject: boolean;

  /**
   * Tier-appropriate first-session prompt. Present when freshProject is true.
   * The agent should use this as the basis for the opening conversation.
   */
  tierSelectionPrompt?: string;

  /**
   * Present when tier=managed AND freshProject=true. Signals the agent to run
   * the Sprint Zero intake interview flow without any further instruction.
   */
  sprintZeroReady?: boolean;

  /**
   * Layer 0: Full project identity from the project_identity contexts row.
   * Null if the row doesn't exist yet (seeded on first access).
   * Added in Context v2 Sprint 50.
   */
  projectIdentity?: ProjectIdentityData | null;

  /**
   * Layer 2: Tier-aware last session memory.
   * Shows where we left off without preloading the full blob.
   * Null if no completed sessions exist.
   * Added in Context v2 Sprint 50.
   */
  lastSession?: LastSessionData | null;

  /**
   * Persisted agent_feedback.id when the caller supplied agentFeedback
   * (Sprint 56 m03). Undefined on the normal read path.
   */
  feedbackId?: number;

  /**
   * Entry context for Sprint Zero (managed tier). Includes the three entry modes
   * and the opening question so the agent can start without reading the snippet file.
   */
  sprintZeroContext?: SprintZeroContext;

  /**
   * Detailed first-session guide for general-tier fresh projects.
   * Tells the agent what to ask, what to capture, and what the user should leave with.
   * Present when tier=general AND freshProject=true.
   */
  firstSessionPrompt?: string;
}

/**
 * Sprint Zero entry context for managed-tier fresh projects.
 */
export interface SprintZeroContext {
  /** Brief description of what Sprint Zero is */
  description: string;

  /** The three entry modes based on what the user arrives with */
  entryModes: Array<{
    situation: string;
    entry: string;
    openingQuestion: string;
  }>;

  /** Opening question to ask the user to identify their situation */
  routingQuestion: string;
}

/**
 * Sync health summary comparing SQLite source counts with PG mirror.
 */
export interface SyncHealthSummary {
  /** Whether all table counts match */
  allMatch: boolean;

  /** Number of tables with count mismatches */
  totalMismatches: number;

  /** Tables with count differences (only included if mismatched) */
  mismatches: SyncHealthMismatch[];

  /** Failed sync log entries on dashboard side */
  failedEntries: number;

  /** Last sync timestamp from dashboard */
  lastSyncAt: string | null;
}

export interface SyncHealthMismatch {
  table: string;
  sqliteCount: number;
  pgCount: number;
  delta: number;
}

/**
 * Messaging summary for onboarding payload.
 */
export interface MessagingSummary {
  /**
   * s87-m05 — THIS PROJECT'S unread count, or `null` when the dashboard did not scope the query.
   *
   * The field this replaces was `unreadCount`, and it carried the USER-WIDE number on a digest
   * whose every other field is project-scoped. An agent opening a session was told to review N
   * unread messages, where N counted messages belonging to other projects it cannot clear from
   * here. `null` means "not scoped" and is rendered as unknown — never as zero, which would be a
   * different claim.
   */
  unreadCountScoped: number | null;

  /** s87-m05 — the user-wide number, kept and LABELLED rather than dropped: it is real, it is
   *  just not this project's. */
  unreadCountUserWide: number;

  /** s87-m05 — which scope the dashboard applied, so the renderer never has to guess. */
  unreadScope: 'project' | 'user';

  /** Up to 5 most recent pending messages */
  recentMessages: RecentMessageSummary[];
}

/**
 * Individual message summary for onboarding.
 */
export interface RecentMessageSummary {
  /** Message ID */
  id: string;

  /** Message type */
  type: string;

  /** Short description */
  summary: string;

  /** Sender address */
  from: string | null;

  /** Message status */
  status: string;

  /** When the message was sent */
  createdAt: string;

  /** s78-m05: additive provenance descriptor — inbound messages are untrusted foreign content. */
  provenance?: ProvenanceDescriptor;
}

/**
 * Input parameters schema for cmos_agent_onboard tool.
 */
export const cmosAgentOnboardSchema = z
  .object({
    /** Optional free-text UX feedback from the agent (Sprint 56 m03). */
    agentFeedback: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Optional free-text UX feedback. Use this to report rough edges, improvement ideas, or surprising tool behavior you hit during the prior session. Reviewed periodically via cmos_feedback(action="list").'
      ),

    /** Optional: explicit project root to search from */
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  // s86-m04: `.strict()` so the zod schema states what the published inputSchema has always
  // stated (additionalProperties: false), matching the other 12 tools. INERT AT RUNTIME — the
  // consolidated schemas are never parsed (src/index.ts casts every case), so this rejects
  // nothing previously accepted; it aligns the two declarations.
  .strict();

export type CmosAgentOnboardParams = z.infer<typeof cmosAgentOnboardSchema>;

interface InternalCmosAgentOnboardParams extends CmosAgentOnboardParams {
  /**
   * @internal MCP-boundary seam: the roots the CLIENT advertised, read by src/index.ts from the
   * transport and passed inward. An agent cannot supply it — it describes the caller, not the
   * request — so it is deliberately absent from the cmos_agent_onboard inputSchema.
   */
  advertisedRoots?: readonly string[];
  /**
   * @internal MCP-boundary seam: whether the CALLER named a projectRoot, which only src/index.ts
   * can know (an inward-passed `projectRoot` is indistinguishable from a resolved default once it
   * is inside the handler). Not a caller decision, so not published.
   */
  callerProvidedProjectRoot?: boolean;
}

/**
 * MCP Tool Definition for cmos_agent_onboard.
 */
export const cmosAgentOnboardToolDefinition = {
  name: 'cmos_agent_onboard',
  description:
    'Get aggregated onboarding payload for agent cold-start. Returns project identity, active session, pending missions, recent decisions, and suggested actions. Optimized for context windows (<4KB). ' +
    UNTRUSTED_CONTENT_CONTRACT,
  inputSchema: {
    type: 'object',
    properties: {
      agentFeedback: {
        type: 'string',
        maxLength: 2000,
        description:
          'Optional free-text UX feedback. Use this to report rough edges, improvement ideas, or surprising tool behavior you hit during the prior session. Reviewed periodically via cmos_feedback(action="list").',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_agent_onboard tool.
 *
 * Aggregates data from multiple sources into a single optimized payload
 * for agent context initialization.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with onboarding data
 */
export async function cmosAgentOnboard(
  params: InternalCmosAgentOnboardParams = {}
): Promise<CmosToolResult<CmosAgentOnboardResult>> {
  return withClientAsync(
    async (client) => {
      const warnings: string[] = [];

      // Sprint 52 m01: seed metadata.owner from dashboard identity if absent, then
      // rewrite any legacy `cmos://unknown/*` address before project_identity is read.
      // Best-effort — a THROWN failure is swallowed below; the identity row keeps an
      // empty cmos_address until a later checkpoint resolves the owner.
      //
      // s86-m02b: a failed `metadata.owner` / `dashboard_slug` write is NOT swallowed.
      // It leaves the store minting `cmos://unknown/*` addresses while this payload's
      // projectIdentity reports a resolved identity, so the DB error rides the envelope.
      try {
        const ownerResult = await resolveAndPersistOwner(client);
        warnings.push(...(ownerResult.warnings ?? []));
        backfillUnknownCmosAddress(client);
      } catch {
        // never block onboard on identity resolution
      }

      // Get project identity from master_context + metadata
      const project = getProjectIdentity(client);

      // Load tier config for the project's tier. s83-m05: feed the RESOLVED store
      // root (dirname^3 of the connected DB path — {root}/cmos/db/cmos.sqlite), not
      // raw params.projectRoot. On auto-discovery params.projectRoot is undefined,
      // which previously made loadTierConfig fall back to the server install dir
      // (no cmos/ for npm consumers) and silently return null. An explicit
      // projectRoot still wins; loadTierConfig's bundled cmos-seed/tiers fallback
      // covers a store that has no copied cmos/tiers.
      const tierRoot = params.projectRoot ?? path.resolve(client.path, '..', '..', '..');
      const tierConfig = loadTierConfig(project.projectType, tierRoot);
      const hiddenFields = new Set(tierConfig?.onboardFieldsHide ?? []);

      // Conditionally fetch sprint/mission data based on tier
      const currentSprint = hiddenFields.has('currentSprint') ? null : getCurrentSprint(client);

      // Get active session
      const activeSession = getActiveSession(client);

      // Get pending missions (suppressed for tiers that hide them)
      const pendingMissions = hiddenFields.has('pendingMissions')
        ? []
        : getPendingMissions(client, currentSprint?.id ?? null);

      // Get blocked missions (suppressed for tiers that hide them)
      const blockedMissions = hiddenFields.has('blockedMissions') ? [] : getBlockedMissions(client);

      // Get recent decisions
      const recentDecisions = getRecentDecisions(client);

      // Get next steps from project_context
      const nextSteps = getNextSteps(client);

      // Get session statistics
      const sessionStats = getSessionStats(client);

      // Get context size telemetry
      const contextSizes = getContextSizes(client);
      const masterSizeWarning = contextSizes.masterContext
        ? buildContextSizeWarning('master_context', contextSizes.masterContext)
        : null;
      const projectSizeWarning = contextSizes.projectContext
        ? buildContextSizeWarning('project_context', contextSizes.projectContext)
        : null;
      if (masterSizeWarning) {
        warnings.push(masterSizeWarning);
      }
      if (projectSizeWarning) {
        warnings.push(projectSizeWarning);
      }

      // Calculate context freshness
      const freshnessResult = calculateContextFreshness(client, {
        contextId: 'master_context',
      });
      warnings.push(...freshnessResult.warnings);
      const staleWarning = buildContextStalenessWarning(freshnessResult.freshness);
      if (staleWarning) {
        warnings.push(staleWarning);
      }

      // Detect and flag stale decisions/learnings. s86-m02b: an errored
      // `UPDATE ... SET status='stale'` folds into the same zero as "nothing matched", so
      // without this splice `staleness.staleDecisions: 0` would read as a clean pass over a
      // store where the flagging statement never ran.
      const stalenessResult = detectAndFlagStaleness(client);
      warnings.push(...(stalenessResult.warnings ?? []));
      if (stalenessResult.totalStaleDecisions > 0 || stalenessResult.totalStaleLearnings > 0) {
        warnings.push(
          `${stalenessResult.totalStaleDecisions} stale decision(s) and ${stalenessResult.totalStaleLearnings} stale learning(s) detected (threshold: ${stalenessResult.threshold} sprints). ` +
            `Run cmos_decisions(action="review") for per-decision triage with suggested actions.`
        );
      }

      // Detect orphaned entities (sprints with no missions, missions with no sprint, stale sessions)
      const orphans = detectOrphans(client);
      const orphanWarnings = buildOrphanWarnings(orphans);
      warnings.push(...orphanWarnings);

      // Layer 0: Full project identity from the project_identity contexts row
      const fullProjectIdentity = getFullProjectIdentity(client);

      // Layer 2: Tier-aware last session memory
      const tier = project.projectType;
      const lastSession = getLastSession(client, tier);

      // Detect fresh project: zero active missions AND no PROJECT BRIEF in master_context
      const freshProject = detectFreshProject(client);
      const tierSelectionPrompt = freshProject
        ? buildTierSelectionPrompt(project.projectType)
        : undefined;

      // Managed Sprint Zero trigger: fresh project + managed tier
      const sprintZeroReady = freshProject && project.projectType === 'managed' ? true : undefined;
      const sprintZeroContext = sprintZeroReady ? buildSprintZeroContext() : undefined;

      // General tier first-session prompt: fresh project + general tier
      const firstSessionPrompt =
        freshProject && project.projectType === 'general' ? buildFirstSessionPrompt() : undefined;

      // Fetch messaging context and sync health (non-blocking — gracefully degrades)
      // Skip syncHealth fetch if tier config hides it (avoids unnecessary network calls)
      const [messaging, syncHealth] = await Promise.all([
        fetchMessagingContext(warnings, tierRoot),
        hiddenFields.has('syncHealth')
          ? Promise.resolve(null)
          : fetchSyncHealth(client, warnings, tierRoot),
      ]);

      // Server health (build staleness). The server-stale signal tracks THIS
      // server's OWN build (cmos-mcp-pro), not the onboarding project's — so it is
      // only actionable for our own project. For a sibling project it is noise it
      // cannot act on (its host session does not own our server), and surfacing it made
      // every sibling digest squawk after any cmos-mcp-pro rebuild. Scope it to the
      // server's own root, and (parity with the sprint-close advisory) require a
      // startup manifest — a null startup yields codeIsCurrent=false for an
      // unrelated reason and must not warn.
      const serverHealth = getServerHealth();
      const serverRoot = getServerProjectRoot();
      const onboardRoot = params.projectRoot ?? process.cwd();
      const serverCodeStaleActionable =
        serverRoot != null &&
        path.resolve(serverRoot) === path.resolve(onboardRoot) &&
        serverHealth.startupBuild != null &&
        !serverHealth.codeIsCurrent;
      if (serverCodeStaleActionable && serverHealth.stalenessMessage) {
        warnings.push(serverHealth.stalenessMessage);
      }

      // s80-m07 — self-capture guard: are local commits running ahead of the last CMOS
      // write? Project-local, fail-open (never throws, no advisory when a signal is
      // absent). onboardRoot is the project we're onboarding (defined above).
      const selfCapture = calculateSelfCaptureGap(client, onboardRoot);
      const selfCaptureWarning = buildSelfCaptureWarning(selfCapture);
      if (selfCaptureWarning) {
        warnings.push(selfCaptureWarning);
      }

      // Detect stale next-steps (pending from >1 sprint ago)
      const staleNextStepsCount = getStaleNextStepsCount(client, currentSprint?.id ?? null);

      // Detect stale/expired constraints
      const staleConstraintCount = getStaleConstraintCountForOnboard(client);

      const senderAttributionAmbiguity = await detectSenderAttributionAmbiguity(
        params,
        params.projectRoot ?? process.cwd()
      );

      // Sprint 57 m04: pull authState so the agent sees it on first turn.
      // Best-effort — never block onboard on credential-store I/O hiccups.
      let authState: AuthState | undefined;
      try {
        const authProjectRoot = params.projectRoot ?? undefined;
        authState = await computeAuthState(authProjectRoot ? { projectRoot: authProjectRoot } : {});
      } catch {
        authState = undefined;
      }

      // Generate suggested actions based on current state (filtered by tier)
      const suggestedActions = generateSuggestedActions({
        activeSession,
        pendingMissions,
        blockedMissions,
        currentSprint,
        contextFreshness: freshnessResult.freshness,
        messaging,
        syncHealth,
        orphans,
        serverHealth,
        staleCounts: {
          decisions: stalenessResult.totalStaleDecisions,
          learnings: stalenessResult.totalStaleLearnings,
        },
        staleNextStepsCount,
        staleConstraintCount,
        contextSizes,
        senderAttributionAmbiguity,
        toolsSkip: tierConfig?.toolsSkip ?? [],
        freshProject,
        authState,
        projectRootSupplied: !!params.projectRoot,
        serverCodeStaleActionable,
        localProjectId: getProjectId(client),
      });

      // s80-m07 — surface the self-capture gap as a priority-2 action when it fires,
      // so it flows into cmos_review's promoted next_actions (the structured path). The
      // action must be re-sorted into priority order (generateSuggestedActions already
      // sorted, and a bare push would tail the array — s80-m07 review — so a p2 nudge
      // could be sliced out of cmos_review's top-3 by lower-priority actions).
      if (selfCapture.fires) {
        suggestedActions.push({
          action: `Local commits are ~${Math.round(selfCapture.gapDays)}d ahead of the last CMOS write — capture recent decisions/learnings/mission progress`,
          command: 'cmos_session(action="capture", category="decision", content="...")',
          priority: 2,
        });
        suggestedActions.sort((a, b) => a.priority - b.priority);
      }

      const result: CmosAgentOnboardResult = {
        project,
        currentSprint,
        activeSession,
        pendingMissions,
        blockedMissions,
        recentDecisions,
        localProjectId: getProjectId(client),
        nextSteps,
        suggestedActions,
        sessionStats,
        contextSizes,
        contextFreshness: freshnessResult.freshness,
        selfCapture,
        staleness: {
          staleDecisions: stalenessResult.totalStaleDecisions,
          staleLearnings: stalenessResult.totalStaleLearnings,
          threshold: stalenessResult.threshold,
        },
        messaging,
        syncHealth,
        orphans,
        serverHealth,
        tierConfig,
        freshProject,
        ...(authState ? { authState } : {}),
      };

      if (tierSelectionPrompt !== undefined) {
        result.tierSelectionPrompt = tierSelectionPrompt;
      }
      if (sprintZeroReady !== undefined) {
        result.sprintZeroReady = sprintZeroReady;
      }
      if (sprintZeroContext !== undefined) {
        result.sprintZeroContext = sprintZeroContext;
      }
      if (firstSessionPrompt !== undefined) {
        result.firstSessionPrompt = firstSessionPrompt;
      }

      // Context v2 Sprint 50: Layer 0 + Layer 2
      result.projectIdentity = fullProjectIdentity;
      result.lastSession = lastSession;

      // Sprint 56 m03: persist optional agent UX feedback if supplied.
      const feedbackSanitized: SanitizedFieldReport[] = [];
      if (params.agentFeedback && params.agentFeedback.trim().length > 0) {
        const fb = recordAgentFeedback(client, params.agentFeedback, {
          toolName: 'cmos_agent_onboard',
          sessionId: activeSession?.id ?? null,
          sprintId: currentSprint?.id ?? null,
        });
        if (fb.feedbackId !== null) {
          result.feedbackId = fb.feedbackId;
        }
        feedbackSanitized.push(...fb.sanitizedFields);
        // s86-m02b: a failed INSERT leaves feedbackId absent, which is also what an empty
        // body produces — surface the DB error so the answer never implies the feedback
        // was recorded.
        warnings.push(...fb.warnings);
      }

      return createSuccess<CmosAgentOnboardResult>(result, warnings, feedbackSanitized);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Read project_type from metadata table. Defaults to 'build' for backward compatibility.
 */
export function getProjectType(client: CmosDatabaseClient): string {
  const result = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    'project_type',
  ]);
  if (result.success && result.data?.value) {
    const normalized = result.data.value.trim();
    if (normalized.length > 0) return normalized;
  }
  return 'build';
}

/**
 * Extract project identity from master_context + metadata.
 */
function getProjectIdentity(client: CmosDatabaseClient): ProjectIdentity {
  const projectType = getProjectType(client);

  const result = client.getOne<{ content: string }>('SELECT content FROM contexts WHERE id = ?', [
    'master_context',
  ]);

  if (!result.success || !result.data) {
    return { name: 'CMOS Project', description: null, status: null, projectType };
  }

  try {
    const content = JSON.parse(result.data.content);
    const projectIdentity = content.project_identity || content.project || {};
    return {
      name: projectIdentity.name || content.project?.name || 'CMOS Project',
      description: projectIdentity.description || content.project?.description || null,
      status: projectIdentity.status || content.project?.status || null,
      projectType,
    };
  } catch {
    return { name: 'CMOS Project', description: null, status: null, projectType };
  }
}

/**
 * Get the full project identity from the project_identity contexts row (Layer 0).
 * Auto-seeds the row if absent. Returns null on failure.
 */
function getFullProjectIdentity(client: CmosDatabaseClient): ProjectIdentityData | null {
  try {
    return getProjectIdentityData(client);
  } catch {
    return null;
  }
}

/**
 * Build tier-aware last session memory (Layer 2).
 *
 * Depth by tier:
 * - general: {title, summary, openItems}
 * - managed: {title, summary, decisions, nextSteps}
 * - build:   {title, summary, decisions, nextSteps, openItems}
 */
function getLastSession(client: CmosDatabaseClient, tier: string): LastSessionData | null {
  const result = client.getOne<{
    id: string;
    title: string;
    type: string;
    summary: string | null;
    captures: string | null;
    completed_at: string;
  }>(
    `SELECT id, title, type, summary, captures, completed_at
     FROM sessions
     WHERE status = 'completed'
     ORDER BY completed_at DESC
     LIMIT 1`,
    []
  );

  if (!result.success || !result.data) return null;
  const session = result.data;

  const base: LastSessionData = {
    id: session.id,
    title: session.title,
    summary: session.summary,
    completedAt: session.completed_at,
  };

  // Parse captures for decisions and next-steps
  let decisions: string[] = [];
  let nextSteps: string[] = [];
  if (session.captures) {
    try {
      const captures = JSON.parse(session.captures) as Array<{
        category?: string;
        content?: string;
      }>;
      if (Array.isArray(captures)) {
        decisions = captures
          .filter((c) => c.category === 'decision' && typeof c.content === 'string')
          .map((c) => c.content as string);
        nextSteps = captures
          .filter((c) => c.category === 'next-step' && typeof c.content === 'string')
          .map((c) => c.content as string);
      }
    } catch {
      // ignore parse errors
    }
  }

  // Fetch open items from next_steps table (table may not exist on older DBs)
  const nextStepsTableExists = client.getOne<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='next_steps'`,
    []
  );
  const openItems: string[] = [];
  if (nextStepsTableExists.success && nextStepsTableExists.data) {
    const openItemsResult = client.getMany<{ content: string }>(
      `SELECT content FROM next_steps WHERE status = 'pending' ORDER BY id DESC LIMIT 10`,
      []
    );
    if (openItemsResult.success && openItemsResult.data) {
      openItems.push(...openItemsResult.data.map((r) => r.content));
    }
  }

  // Apply tier-aware depth
  if (tier === 'general') {
    return { ...base, openItems };
  } else if (tier === 'managed') {
    return { ...base, decisions, nextSteps };
  } else {
    // build (default) — all fields
    return { ...base, decisions, nextSteps, openItems };
  }
}

// s77-m02: the six-step current-sprint cascade + its helpers were lifted into
// src/tools/cmos/current-sprint.ts so onboard, mission-status, session-start and
// capture all name the SAME current sprint. getCurrentSprint now = resolve the id
// (canonical resolver) + build the SprintContext locally.

/**
 * Get current sprint context: the canonical resolveCurrentSprintId cascade plus
 * this module's SprintContext shape (title/status/focus).
 */
function getCurrentSprint(client: CmosDatabaseClient): SprintContext | null {
  const sprintId = resolveCurrentSprintId(client);
  if (!sprintId) {
    return null;
  }
  return getSprintContextById(client, sprintId);
}

/**
 * Get sprint context by ID.
 */
function getSprintContextById(client: CmosDatabaseClient, sprintId: string): SprintContext | null {
  // s84-m03: guarded project_id read (NULL AS on an ancient store lacking the column).
  const projExpr = tableHasColumn(client, 'sprints', 'project_id')
    ? 'project_id'
    : 'NULL AS project_id';
  const result = client.getOne<{
    id: string;
    title: string;
    status: string | null;
    focus: string | null;
    project_id: string | null;
  }>(`SELECT id, title, status, focus, ${projExpr} FROM sprints WHERE id = ?`, [sprintId]);

  if (!result.success || !result.data) {
    return null;
  }

  return {
    id: result.data.id,
    title: result.data.title,
    status: result.data.status,
    focus: result.data.focus,
    projectId: result.data.project_id ?? null,
  };
}

/**
 * Get active session if any.
 */
function getActiveSession(client: CmosDatabaseClient): ActiveSessionSummary | null {
  // s84-m03: guarded project_id read (NULL AS on an ancient store lacking the column).
  const projExpr = tableHasColumn(client, 'sessions', 'project_id')
    ? 'project_id'
    : 'NULL AS project_id';
  const result = client.getOne<Session & { project_id?: string | null }>(
    `SELECT id, type, title, started_at, captures, ${projExpr}
       FROM sessions
      WHERE status = 'active'
      ORDER BY started_at DESC
      LIMIT 1`,
    []
  );

  if (!result.success || !result.data) {
    return null;
  }

  const session = result.data;
  let captureCount = 0;
  try {
    const captures = JSON.parse(session.captures || '[]');
    captureCount = Array.isArray(captures) ? captures.length : 0;
  } catch {
    captureCount = 0;
  }

  return {
    id: session.id,
    type: session.type,
    title: session.title,
    startedAt: session.started_at,
    captureCount,
    projectId: session.project_id ?? null,
  };
}

/**
 * Get pending missions (In Progress, Current, Queued).
 * Queued missions are scoped to the active sprint when identified.
 */
function getPendingMissions(
  client: CmosDatabaseClient,
  activeSprintId: string | null
): PendingMissionSummary[] {
  // s84-m03: guarded project_id read (NULL AS on an ancient store lacking the column).
  const projExpr = tableHasColumn(client, 'missions', 'project_id')
    ? 'project_id'
    : 'NULL AS project_id';
  // Show In Progress/Current from any sprint, but scope Queued to active sprint
  const query = activeSprintId
    ? `SELECT id, name, status, sprint_id, ${projExpr}
         FROM missions
        WHERE status IN ('In Progress', 'Current')
           OR (status = 'Queued' AND sprint_id = ?)
        ORDER BY CASE status
          WHEN 'In Progress' THEN 0
          WHEN 'Current' THEN 1
          ELSE 2
        END, rowid
        LIMIT 5`
    : `SELECT id, name, status, sprint_id, ${projExpr}
         FROM missions
        WHERE status IN ('In Progress', 'Current', 'Queued')
        ORDER BY CASE status
          WHEN 'In Progress' THEN 0
          WHEN 'Current' THEN 1
          ELSE 2
        END, rowid
        LIMIT 5`;
  const params = activeSprintId ? [activeSprintId] : [];

  const result = client.getMany<Mission & { project_id?: string | null }>(query, params);

  if (!result.success || !result.data) {
    return [];
  }

  return result.data.map((m) => ({
    id: m.id,
    name: m.name,
    status: m.status,
    sprintId: m.sprint_id,
    projectId: m.project_id ?? null,
  }));
}

/**
 * Get blocked missions.
 */
function getBlockedMissions(client: CmosDatabaseClient): PendingMissionSummary[] {
  // s84-m03: guarded project_id read (NULL AS on an ancient store lacking the column).
  const projExpr = tableHasColumn(client, 'missions', 'project_id')
    ? 'project_id'
    : 'NULL AS project_id';
  const result = client.getMany<Mission & { project_id?: string | null }>(
    `SELECT id, name, status, sprint_id, ${projExpr}
       FROM missions
      WHERE status = 'Blocked'
      ORDER BY rowid
      LIMIT 3`,
    []
  );

  if (!result.success || !result.data) {
    return [];
  }

  return result.data.map((m) => ({
    id: m.id,
    name: m.name,
    status: m.status,
    sprintId: m.sprint_id,
    projectId: m.project_id ?? null,
  }));
}

/**
 * Strategic decision row from database.
 */
interface StrategicDecisionRow {
  decision_text: string;
  project_domain: string | null;
  created_at: string;
  project_id: string | null;
}

/**
 * Get recent strategic decisions.
 */
function getRecentDecisions(client: CmosDatabaseClient): RecentDecisionSummary[] {
  // s83-m06: project_id guarded to NULL on ancient stores that predate genesis cols.
  const projCols = client.getMany<{ name: string }>("PRAGMA table_info('strategic_decisions')", []);
  const projExpr =
    projCols.success && projCols.data?.some((c) => c.name === 'project_id') ? 'project_id' : 'NULL';
  const result = client.getMany<StrategicDecisionRow>(
    `SELECT decision_text, project_domain, created_at, ${projExpr} AS project_id
       FROM strategic_decisions
      ORDER BY created_at DESC
      LIMIT 10`,
    []
  );

  if (!result.success || !result.data) {
    return [];
  }

  return result.data.map((d: StrategicDecisionRow) => ({
    decision: d.decision_text,
    domain: d.project_domain,
    createdAt: d.created_at,
    projectId: d.project_id,
  }));
}

/**
 * Count stale next-steps: pending next-steps from sprints older than the current one.
 * Returns 0 if the next_steps table doesn't exist.
 */
function getStaleNextStepsCount(
  client: CmosDatabaseClient,
  currentSprintId: string | null
): number {
  // Check if next_steps table exists
  const tableCheck = client.getOne<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='next_steps'`
  );
  if (!tableCheck.success || !tableCheck.data) return 0;

  if (!currentSprintId) {
    // No active sprint — all pending next-steps are stale
    const result = client.getOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM next_steps WHERE status = 'pending'`
    );
    return result.success && result.data ? result.data.count : 0;
  }

  // Pending next-steps from sprints other than the current one
  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM next_steps
     WHERE status = 'pending'
       AND (sprint_id IS NOT NULL AND sprint_id != ?)`,
    [currentSprintId]
  );
  return result.success && result.data ? result.data.count : 0;
}

/**
 * Count stale/expired constraints using the constraints module.
 */
function getStaleConstraintCountForOnboard(client: CmosDatabaseClient): number {
  return getStaleConstraintCountFromConstraints(client);
}

/**
 * Get next steps from project_context.
 */
function getNextSteps(client: CmosDatabaseClient): string[] {
  const result = client.getOne<{ content: string }>('SELECT content FROM contexts WHERE id = ?', [
    'project_context',
  ]);

  if (!result.success || !result.data) {
    return [];
  }

  try {
    const content = JSON.parse(result.data.content);
    const workingMemory = content.working_memory || {};
    const nextSessionContext = content.next_session_context || {};
    const candidateSteps = [
      ...readOnboardSteps(workingMemory.next_steps),
      ...readOnboardSteps(nextSessionContext.when_we_resume),
      ...readOnboardSteps(content.next_steps),
    ];

    const completedMissionIds = loadCompletedMissionIds(client);
    const completedSprintIds = loadCompletedSprintIds(client);
    const sessionReferenceIndex = loadSessionReferenceIndex(client);
    const nextSteps: string[] = [];
    const seen = new Set<string>();

    for (const step of candidateSteps) {
      if (referencesCompletedMission(step, completedMissionIds)) {
        continue;
      }

      if (referencesCompletedSprint(step, completedSprintIds)) {
        continue;
      }

      const sessionReference = extractValidSessionReference(step, sessionReferenceIndex.all);
      if (
        sessionReference &&
        sessionReferenceIndex.recent.size > 0 &&
        !sessionReferenceIndex.recent.has(sessionReference)
      ) {
        continue;
      }

      const dedupeKey = stripSessionReference(step, sessionReferenceIndex.all).toLowerCase();
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      nextSteps.push(step);

      if (nextSteps.length >= 5) {
        break;
      }
    }

    return nextSteps;
  } catch {
    return [];
  }
}

function readOnboardSteps(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function loadCompletedMissionIds(client: CmosDatabaseClient): Set<string> {
  const result = client.getMany<{ id: string }>(
    `SELECT id
       FROM missions
      WHERE status = 'Completed'`,
    []
  );

  return new Set(result.success && result.data ? result.data.map((row) => row.id) : []);
}

function loadCompletedSprintIds(client: CmosDatabaseClient): Set<string> {
  const result = client.getMany<{ id: string }>(
    `SELECT id
       FROM sprints
      WHERE status = 'Completed'`,
    []
  );

  return new Set(result.success && result.data ? result.data.map((row) => row.id) : []);
}

function loadSessionReferenceIndex(client: CmosDatabaseClient): {
  all: Set<string>;
  recent: Set<string>;
} {
  const result = client.getMany<{ id: string }>(
    `SELECT id
       FROM sessions
      ORDER BY COALESCE(completed_at, started_at) DESC, rowid DESC`,
    []
  );

  if (!result.success || !result.data) {
    return { all: new Set(), recent: new Set() };
  }

  const orderedIds = result.data.map((row) => row.id).filter(Boolean);
  return {
    all: new Set(orderedIds),
    recent: new Set(orderedIds.slice(0, 2)),
  };
}

function extractValidSessionReference(step: string, knownSessionIds: Set<string>): string | null {
  const separatorIndex = step.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }

  const candidate = step.slice(0, separatorIndex).trim();
  return knownSessionIds.has(candidate) ? candidate : null;
}

function stripSessionReference(step: string, knownSessionIds: Set<string>): string {
  const reference = extractValidSessionReference(step, knownSessionIds);
  if (!reference) {
    return step.trim();
  }

  return step.slice(step.indexOf(':') + 1).trim();
}

function referencesCompletedMission(step: string, completedMissionIds: Set<string>): boolean {
  const normalizedStep = step.toLowerCase();
  for (const missionId of completedMissionIds) {
    if (normalizedStep.includes(missionId.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function referencesCompletedSprint(step: string, completedSprintIds: Set<string>): boolean {
  const normalizedStep = step.toLowerCase();

  for (const sprintId of completedSprintIds) {
    const tokens = [sprintId.toLowerCase(), sprintId.toLowerCase().replace(/-/g, ' ')];
    const numericMatch = sprintId.toLowerCase().match(/^sprint-(\d+)$/);
    if (numericMatch) {
      const normalizedNumber = String(Number.parseInt(numericMatch[1], 10));
      tokens.push(`sprint ${normalizedNumber}`);
      tokens.push(`sprint-${numericMatch[1]}`);
    }

    if (tokens.some((token) => normalizedStep.includes(token))) {
      return true;
    }
  }

  return false;
}

/**
 * Get session statistics.
 */
function getSessionStats(client: CmosDatabaseClient): {
  totalSessions: number;
  lastActivity: string | null;
} {
  const result = client.getOne<{ total_sessions: number; last_activity: string | null }>(
    `SELECT COUNT(*) AS total_sessions,
            MAX(COALESCE(completed_at, started_at)) AS last_activity
       FROM sessions`,
    []
  );

  if (!result.success || !result.data) {
    return { totalSessions: 0, lastActivity: null };
  }

  return {
    totalSessions: result.data.total_sessions,
    lastActivity: result.data.last_activity,
  };
}

function getContextSizes(client: CmosDatabaseClient): CmosAgentOnboardResult['contextSizes'] {
  const contexts = client.getMany<{ id: string; content: string }>(
    `SELECT id, content
       FROM contexts
      WHERE id IN ('master_context', 'project_context')`,
    []
  );

  if (!contexts.success || !contexts.data) {
    return {
      masterContext: null,
      projectContext: null,
      totalSizeKb: 0,
      totalSizeBytes: 0,
    };
  }

  let masterContext: ContextSizeMetrics | null = null;
  let projectContext: ContextSizeMetrics | null = null;

  for (const row of contexts.data) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(row.content);
    } catch {
      parsed = {};
    }

    const settings = resolveContextSizeSettings(parsed);
    const metrics = calculateContextSizeMetrics(row.content, settings);

    if (row.id === 'master_context') {
      masterContext = metrics;
    } else if (row.id === 'project_context') {
      projectContext = metrics;
    }
  }

  return {
    masterContext,
    projectContext,
    totalSizeKb: (masterContext?.sizeKb ?? 0) + (projectContext?.sizeKb ?? 0),
    totalSizeBytes: (masterContext?.sizeBytes ?? 0) + (projectContext?.sizeBytes ?? 0),
  };
}

/**
 * Fetch messaging context from the dashboard.
 * Non-blocking: if dashboard is unreachable or not configured,
 * returns null and adds a warning.
 */
async function fetchMessagingContext(
  warnings: string[],
  /** s87-m05 — the project this digest is about. See the resolver swap below. */
  projectRoot: string
): Promise<MessagingSummary | null> {
  // s87-m05 — `fromEnvForProject(root)`, NOT `fromEnv()`, and this is the change that makes the
  // block exist at all. `fromEnv()` reads only the legacy env arms, so on a device-code install
  // it errors and returns `null` with an explicit "don't warn" comment — MEASURED LIVE:
  // `.data.messaging === null`. The messaging block does not render today. Swapping the resolver
  // REVIVES a silently dead block; it does not correct a wrong number that was on screen.
  //
  // Cited to #580, which scheduled the per-call-site migration of PRE-EXISTING `fromEnv` sites.
  // NOT #832 — that is scoped to NEW code paths and explicitly reserves `fromEnv` as the
  // resolver's env fallback, so citing it here would read it wider than it reaches.
  const clientResult = await DashboardClient.fromEnvForProject(projectRoot);
  if (!clientResult.success || !clientResult.data) {
    // s87-m05 — WARN rather than returning a silent null. "The dashboard is not configured" and
    // "the dashboard could not be reached" are different facts, and a digest that shows neither
    // messaging block nor explanation is indistinguishable from a project with no messages.
    // WORDED TO NAME ITS ACTUAL CAUSE, and that is what lets it reach a reader.
    // `cmos_review` runs `filterReviewWarnings`, which keeps a warning only if its lowercased
    // text contains one of `auth`, `sync`, `cmos_auth`, `credential`, `attribution`, `whoami` —
    // everything else is dropped before any human sees it. A message about the block being
    // "omitted" matches none of them and would vanish: the sprint's own defect class inside the
    // sprint's own fix. The word `credential` is not bolted on to pass the filter — it is what
    // actually failed. `fromEnvForProject` returns an error precisely when no credential resolves
    // for this project, so naming that is both more specific and more true than "not configured".
    warnings.push(
      'Messaging block omitted: no dashboard credential resolved for this project ' +
        `(${clientResult.error?.message ?? 'not configured'}). Unread counts are unknown, not zero.`
    );
    return null;
  }

  try {
    const client = clientResult.data.client;
    const result = await client.listMessages({
      tab: 'inbox',
      status: 'pending',
      limit: 5,
    });

    if (!result.success) {
      warnings.push(`Dashboard messaging unavailable: ${result.error?.message ?? 'unknown error'}`);
      return null;
    }

    const listed = result.data!;
    const scoped = listed.unreadCountScoped;
    return {
      unreadCountScoped: scoped ?? null,
      unreadCountUserWide: listed.unreadCount,
      unreadScope: listed.unreadScope ?? (scoped === undefined ? 'user' : 'project'),
      recentMessages: result.data!.messages.map((msg: DashboardMessage) => ({
        id: msg.id,
        type: msg.type,
        summary: msg.summary,
        // s80-m05: attribute from the fields the dashboard actually populates
        // (senderProject/senderDisplayName) via the shared mapper — was msg.from,
        // which is empty on live rows and read "unknown source".
        from: attributionSource(msg, 'inbox') ?? null,
        status: msg.status,
        createdAt: msg.createdAt,
        provenance: foreignDescriptor(attributionSource(msg, 'inbox')),
      })),
    };
  } catch {
    warnings.push('Dashboard messaging unavailable: unexpected error during fetch');
    return null;
  }
}

/** PG table → SQLite table name mapping for reconciliation (global fallback) */
const PG_TO_SQLITE_TABLE: Record<string, string> = {
  cmos_sprints: 'sprints',
  cmos_missions: 'missions',
  cmos_sessions: 'sessions',
  cmos_decisions: 'strategic_decisions',
  cmos_learnings: 'learnings',
  cmos_mission_dependencies: 'mission_dependencies',
};

/** Project state entity field → SQLite table name mapping (project-scoped) */
const PROJECT_STATE_TO_SQLITE: Record<string, string> = {
  sprints: 'sprints',
  missions: 'missions',
  sessions: 'sessions',
  decisions: 'strategic_decisions',
  learnings: 'learnings',
  dependencies: 'mission_dependencies',
};

/**
 * Fetch sync health by comparing SQLite counts with PG mirror counts.
 * Uses project-scoped endpoint for accurate per-project comparison.
 * Falls back to global endpoint if project-scoped is unavailable.
 * Non-blocking — returns null if dashboard is unreachable.
 */
async function fetchSyncHealth(
  db: CmosDatabaseClient,
  warnings: string[],
  /** s87-m05 — the project this sync health is about. */
  projectRoot: string
): Promise<SyncHealthSummary | null> {
  // s87-m05, Treaty 1 — this is m05's single line inside m03's function, re-derived after m03
  // landed and moved it. Same root cause and same standing rule (#580) as the other two
  // `fromEnv()` sites in this mission; splitting it away would have shipped two of three
  // identical fixes.
  const clientResult = await DashboardClient.fromEnvForProject(projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return null;
  }

  try {
    const client = clientResult.data.client;

    // Resolve project slug from metadata. s87-m03: through the SHARED `deriveProjectSlug`, which
    // this function used to spell by hand — three hand-copies of one rule is how the four
    // getSyncStatus call sites came to disagree about what "this project" means.
    const nameResult = db.getOne<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'project_name'`
    );
    const projectName = nameResult.success && nameResult.data ? nameResult.data.value : null;
    const slug = projectName ? deriveProjectSlug(projectName) : null;

    // Try project-scoped endpoint first
    if (slug) {
      const stateResult = await client.getSyncProjectState(slug);

      if (stateResult.success && stateResult.data) {
        return buildSyncHealthFromProjectState(db, stateResult.data, client, slug);
      }
    }

    // Fallback to the sync-status endpoint. s87-m03: this is a DIFFERENT endpoint from the
    // project-state one that just failed (`/api/sync/status` vs `/api/sync/projects/{slug}/state`),
    // so passing the slug here is a real scoped attempt and not a pointless retry.
    return buildSyncHealthFromGlobalStatus(db, client, warnings, slug);
  } catch {
    warnings.push('Sync health unavailable: unexpected error during fetch');
    return null;
  }
}

/** Build sync health from project-scoped state (accurate per-project counts) */
async function buildSyncHealthFromProjectState(
  db: CmosDatabaseClient,
  projectState: import('./dashboard-client').SyncProjectStateResult,
  client: DashboardClient,
  /** s87-m03 — the project this summary is about. See the getSyncStatus call below. */
  projectSlug: string | null
): Promise<SyncHealthSummary> {
  const mismatches: SyncHealthMismatch[] = [];

  for (const [entityField, sqliteTable] of Object.entries(PROJECT_STATE_TO_SQLITE)) {
    const pgEntities = projectState[entityField as keyof typeof projectState];
    const pgCount = Array.isArray(pgEntities) ? pgEntities.length : 0;

    const countResult = db.getOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM ${sqliteTable}`);
    const sqliteCount = countResult.success && countResult.data ? countResult.data.cnt : 0;

    if (sqliteCount !== pgCount) {
      mismatches.push({
        table: sqliteTable,
        sqliteCount,
        pgCount,
        delta: sqliteCount - pgCount,
      });
    }
  }

  // s87-m03 — SCOPED. This was the worst of the four sites, because the numbers it fetched sat
  // BESIDE correct ones: the mismatches above are computed per project from project state, and
  // `failedEntries` / `lastSyncAt` were then fetched PLATFORM-WIDE and rendered in the same
  // block, on the session opener, as though all four described this project. NAMED CONSEQUENCE:
  // these two numbers CHANGE VALUE on every install once scoped — they were never this project's.
  let failedEntries = 0;
  let lastSyncAt: string | null = null;
  try {
    const statusResult = await client.getSyncStatus(projectSlug ?? undefined);
    if (statusResult.success && statusResult.data) {
      failedEntries = statusResult.data.failedSyncLogEntries;
      lastSyncAt = statusResult.data.lastSyncAt;
    }
  } catch {
    // Non-critical
  }

  return {
    allMatch: mismatches.length === 0,
    totalMismatches: mismatches.length,
    mismatches,
    failedEntries,
    lastSyncAt,
  };
}

/** Build sync health from global status endpoint (fallback) */
async function buildSyncHealthFromGlobalStatus(
  db: CmosDatabaseClient,
  client: DashboardClient,
  warnings: string[],
  /**
   * s87-m03 — scope it when we have it. `null` only when the store carries no `project_name`,
   * in which case an unscoped call is the honest degradation: there is no project to ask about.
   * The warning below says which of the two happened, because the comparison this function makes
   * — this project's SQLite counts against the returned pg counts — is only meaningful scoped.
   */
  projectSlug: string | null
): Promise<SyncHealthSummary | null> {
  const statusResult = await client.getSyncStatus(projectSlug ?? undefined);
  if (projectSlug === null) {
    warnings.push(
      'Sync health is PLATFORM-WIDE, not project-scoped: this store carries no project_name, so ' +
        "the counts below compare this project's local rows against every project's dashboard " +
        "rows. Treat the mismatches as unclassified rather than as this project's drift."
    );
  }

  if (!statusResult.success || !statusResult.data) {
    warnings.push(`Sync health unavailable: ${statusResult.error?.message ?? 'unknown error'}`);
    return null;
  }

  const pgStatus = statusResult.data;
  const mismatches: SyncHealthMismatch[] = [];

  for (const pgTable of pgStatus.tables) {
    const sqliteTable = PG_TO_SQLITE_TABLE[pgTable.table];
    if (!sqliteTable) continue;

    const countResult = db.getOne<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM ${sqliteTable}`);
    const sqliteCount = countResult.success && countResult.data ? countResult.data.cnt : 0;

    if (sqliteCount !== pgTable.count) {
      mismatches.push({
        table: sqliteTable,
        sqliteCount,
        pgCount: pgTable.count,
        delta: sqliteCount - pgTable.count,
      });
    }
  }

  return {
    allMatch: mismatches.length === 0,
    totalMismatches: mismatches.length,
    mismatches,
    failedEntries: pgStatus.failedSyncLogEntries,
    lastSyncAt: pgStatus.lastSyncAt,
  };
}

/**
 * Detect whether this is a fresh project — one that has not accumulated any
 * history yet.
 *
 * Sprint 55 m03: row counts across sprints, missions, and sessions are now the
 * authoritative signal. Any persisted sprint / mission / session means the
 * project is past the tabula-rasa state and must not be flagged fresh, even if
 * every mission has since been completed and no "PROJECT BRIEF" marker was
 * ever written to master_context. Previously this function only checked for
 * active missions + the brief marker, which misreported mature projects
 * (OODS-Foundry-MCP: 74 sprints / 458 missions / 127 sessions) as fresh and
 * surfaced the new-project tierSelectionPrompt on every onboard.
 *
 * Falls back to the PROJECT BRIEF heuristic only when the database has zero
 * rows in all three tables, so the first-session prompt still fires for
 * genuinely-new projects that import context via master_context without ever
 * persisting a sprint row.
 */
function detectFreshProject(client: CmosDatabaseClient): boolean {
  const rowsResult = client.getOne<{
    sprint_count: number;
    mission_count: number;
    session_count: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM sprints) AS sprint_count,
       (SELECT COUNT(*) FROM missions) AS mission_count,
       (SELECT COUNT(*) FROM sessions) AS session_count`,
    []
  );
  if (rowsResult.success && rowsResult.data) {
    const { sprint_count, mission_count, session_count } = rowsResult.data;
    if (sprint_count > 0 || mission_count > 0 || session_count > 0) {
      return false;
    }
  }

  const contextResult = client.getOne<{ content: string }>(
    'SELECT content FROM contexts WHERE id = ?',
    ['master_context']
  );
  if (!contextResult.success || !contextResult.data) return true; // No context → fresh

  const content = contextResult.data.content.toLowerCase();
  const hasBrief = content.includes('project brief') || content.includes('project_brief');
  return !hasBrief;
}

/**
 * Build a tier-appropriate first-session prompt for fresh projects.
 * The agent uses this to kick off the opening conversation.
 */
function buildTierSelectionPrompt(tier: string): string {
  switch (tier) {
    case 'general':
      return (
        'New project detected. This is a fresh CMOS General workspace — a thinking partner ' +
        'with memory. Start by introducing the project: what are you working on, and what ' +
        'would be most useful to capture and remember across conversations?'
      );
    case 'managed':
      return (
        'New project detected. This is a fresh CMOS Managed workspace. ' +
        "Let's capture the project brief to get started: what's the goal, who are the " +
        "stakeholders, and what's the target timeline?"
      );
    case 'build':
    default:
      return (
        'New project detected. This is a fresh CMOS Build workspace with no active missions. ' +
        'Start with sprint planning to define the first sprint and its missions: ' +
        'cmos_session(action="start", type="planning", title="Sprint 1 Planning").'
      );
  }
}

/**
 * Build the Sprint Zero entry context for managed-tier fresh projects.
 * Contains everything the agent needs to run the intake interview without
 * reading the sprint-zero-managed.md snippet file.
 */
function buildSprintZeroContext(): SprintZeroContext {
  return {
    description:
      'Sprint Zero is a short intake interview that produces a populated project brief ' +
      'and identifies the first milestone. It adapts to what the user arrives with and ' +
      'may span more than one session.',
    entryModes: [
      {
        situation: 'Has a client and a deadline',
        entry: 'Stage 2 — stakeholders and context',
        openingQuestion:
          "Great, let's get your project set up. Tell me about the client and what the deadline is.",
      },
      {
        situation: 'Has a problem or goal but no strategy yet',
        entry: 'Stage 1 — project identity',
        openingQuestion: "What's the project in one sentence? And who is it for?",
      },
      {
        situation: 'Has an idea but nothing concrete',
        entry: 'Stage 0 — exploration',
        openingQuestion: "What's on your mind? Tell me about it — even rough is fine.",
      },
    ],
    routingQuestion:
      'Before we dive in — do you already have a client or deadline in mind, ' +
      'or are you still figuring out what this project is?',
  };
}

/**
 * Build the first-session conversation guide for general-tier fresh projects.
 * Tells the agent what to ask, what to capture, and what the user should leave with.
 */
function buildFirstSessionPrompt(): string {
  return (
    'First session — General tier. Memory and thinking partner; no missions, no tasks, no structured intake.\n\n' +
    "Open: One warm question about what they're working on. Do not mention CMOS, tiers, or setup.\n" +
    'Example: "What are you working on? I\'ll hold onto the things worth remembering as we go."\n\n' +
    'During the session:\n' +
    '- Start a session silently: cmos_session(action="start", type="custom", title="<topic>")\n' +
    '- Capture decisions as they surface: cmos_session(action="capture", category="decision", content="<what was decided>")\n' +
    '- Write key context to master_context: cmos_context(action="update", contextType="master_context")\n' +
    '- Do not interrupt to announce what you are saving\n\n' +
    'End state: user has project context written, key decisions and open threads captured, ' +
    'agent ready to resume naturally next session.'
  );
}

interface SenderAttributionAmbiguity {
  ambiguous: boolean;
  reasons: string[];
}

async function detectSenderAttributionAmbiguity(
  params: InternalCmosAgentOnboardParams,
  resolvedProjectRoot: string
): Promise<SenderAttributionAmbiguity> {
  const reasons: string[] = [];
  const advertisedRoots = (params.advertisedRoots ?? []).map((root) => path.resolve(root));

  if ((process.env[CMOS_PROJECT_ROOT_ENV] ?? '').trim().length > 0) {
    reasons.push(`${CMOS_PROJECT_ROOT_ENV} is set`);
  }

  if (advertisedRoots.length === 0) {
    reasons.push('no MCP roots advertised');
  }

  if (!params.callerProvidedProjectRoot && advertisedRoots.length === 0) {
    try {
      const registry = await ProjectGraphRegistry.create();
      const projects = registry.list();
      const cwd = path.resolve(process.cwd());
      const currentRoot = path.resolve(resolvedProjectRoot);

      if (projects.length > 1 && (cwd === SERVER_INSTALL_ROOT || cwd !== currentRoot)) {
        reasons.push('multiple registered projects with no clear current root');
      }
    } catch {
      // Registry ambiguity is best-effort; onboard should never fail because of it.
    }
  }

  return {
    ambiguous: reasons.length > 0,
    reasons,
  };
}

/**
 * Generate suggested actions based on current state.
 */
function generateSuggestedActions(state: {
  activeSession: ActiveSessionSummary | null;
  pendingMissions: PendingMissionSummary[];
  blockedMissions: PendingMissionSummary[];
  currentSprint: SprintContext | null;
  contextFreshness: ContextFreshness;
  messaging: MessagingSummary | null;
  syncHealth: SyncHealthSummary | null;
  orphans: OrphanDetectionResult;
  serverHealth: ServerHealthStatus;
  staleCounts: { decisions: number; learnings: number };
  staleNextStepsCount: number;
  staleConstraintCount: number;
  contextSizes: CmosAgentOnboardResult['contextSizes'];
  senderAttributionAmbiguity: SenderAttributionAmbiguity;
  toolsSkip: string[];
  freshProject: boolean;
  authState?: AuthState | undefined;
  projectRootSupplied: boolean;
  /** True only when the running-server-stale signal is the server's OWN build
   * drift (scoped + startup-manifest-gated). Siblings get false so the digest
   * does not promote a host-session action for an unrelated project. */
  serverCodeStaleActionable: boolean;
  /** s84-m03: the querying store's own project_id, so a foreign (pull-merged) mission's
   *  name is dropped from the action text (id-only) rather than embedded unfenced. These
   *  actions also feed the byte-capped cmos_review digest, so id-only (not a fence). */
  localProjectId: string | null;
}): SuggestedAction[] {
  const skippedTools = new Set(state.toolsSkip);
  const actions: SuggestedAction[] = [];

  // If this is a fresh project, suggest starting the first-session flow immediately
  if (state.freshProject) {
    actions.push({
      action: 'Fresh project detected — no active missions. Begin first-session setup.',
      command: 'Follow the tierSelectionPrompt in this payload to start the opening conversation.',
      priority: 0,
    });
  }

  // If OUR OWN server is running stale code, top priority action. Scoped to the
  // server's own project (serverCodeStaleActionable) so a sibling project's digest
  // is never told to reconnect over a cmos-mcp-pro rebuild unrelated to that project.
  if (state.serverCodeStaleActionable) {
    actions.push({
      action: 'MCP server is running stale code — use a new host session for the latest build',
      command: 'Start a new IDE/host session or reconnect before subsequent MCP calls',
      priority: 0,
    });
  }

  if (state.senderAttributionAmbiguity.ambiguous && !skippedTools.has('cmos_message')) {
    actions.push({
      action: 'Run whoami to confirm sender attribution',
      command: 'cmos_message(action="whoami")',
      priority: 1,
    });
  }

  // Sprint 57 m04 + Sprint 58 m02: surface auth-state issues so agents can self-heal credentials.
  if (state.authState && !skippedTools.has('cmos_auth')) {
    if (state.authState.identitySource === 'request-body') {
      actions.push({
        action:
          'Sends are being attributed via the legacy user-scoped + body-level path — rotate to a project-scoped key.',
        command: 'cmos_auth(action="reissue", projectRoot="<current project root>")',
        priority: 1,
      });
    } else if (
      state.projectRootSupplied &&
      state.authState.identitySource !== 'none' &&
      state.authState.projectKey === null &&
      state.authState.userScopedKey !== null
    ) {
      actions.push({
        action:
          'No project-scoped key for this project root yet — register or reissue to mint one.',
        command:
          'cmos_auth(action="reissue", projectRoot="<current project root>") (after registration completes)',
        priority: 2,
      });
    } else if (state.authState.authTier === 'none') {
      // Sprint 58 m02 — replaces the Sprint 57 m04 "identitySource === none"
      // branch with a cmos_auth(action="login") command (now that m01 ships
      // the reachable entrypoint). Same trigger condition because authTier
      // is 'none' iff no user-scoped keys AND no legacy env vars.
      actions.push({
        action: 'No dashboard credentials configured — run login before any send/init.',
        command: 'cmos_auth(action="login")',
        priority: 1,
      });
    } else if (
      state.authState.authTier === 'legacy-env' ||
      state.authState.authTier === 'password-fallback'
    ) {
      // Sprint 58 m02 — authTier is non-none but not device-code: the user
      // has auth configured but via a deprecated arm. Nudge toward login
      // without blocking work (priority 2, not 1).
      actions.push({
        action: `Authenticating via ${state.authState.authTier} — migrate to device-code credentials.`,
        command: 'cmos_auth(action="login")',
        priority: 2,
      });
    }
  }

  // Sprint closeout guardrail: all missions done but sprint still Active
  if (
    state.currentSprint &&
    state.currentSprint.status === 'Active' &&
    state.pendingMissions.length === 0 &&
    state.blockedMissions.length === 0 &&
    !skippedTools.has('cmos_sprint')
  ) {
    actions.push({
      action: `All missions complete — close out ${state.currentSprint.id} with sprint complete`,
      command: `cmos_sprint(action="complete", sprintId="${state.currentSprint.id}", summary="Sprint summary here")`,
      priority: 1,
    });
  }

  // If stale decisions exist, suggest automated review
  if (state.staleCounts.decisions > 0) {
    actions.push({
      action: `${state.staleCounts.decisions} stale decision(s) — run automated review for triage`,
      command:
        'cmos_decisions(action="review") for per-decision scores and batch archive suggestions',
      priority: 2,
    });
  }

  // If stale next-steps exist, suggest review
  if (state.staleNextStepsCount > 0) {
    actions.push({
      action: `${state.staleNextStepsCount} stale next-step(s) from older sprints still pending — review and resolve`,
      command:
        'cmos_context(action="next_steps", nextStepAction="list") to review, then complete/carry/drop',
      priority: 3,
    });
  }

  // If stale/expired constraints exist, suggest review
  if (state.staleConstraintCount > 0) {
    actions.push({
      action: `${state.staleConstraintCount} stale/expired constraint(s) — review and archive outdated ones`,
      command:
        'cmos_context(action="constraints", constraintAction="review") to see scores, then archive',
      priority: 3,
    });
  }

  // If context is near size limit, suggest proactive condensation
  const masterUsage = state.contextSizes.masterContext?.usagePercent ?? 0;
  const projectUsage = state.contextSizes.projectContext?.usagePercent ?? 0;
  if (masterUsage >= 75 || projectUsage >= 75) {
    const which =
      masterUsage >= 75 && projectUsage >= 75
        ? 'both contexts'
        : masterUsage >= 75
          ? 'master_context'
          : 'project_context';
    const maxUsage = Math.max(masterUsage, projectUsage);
    actions.push({
      action: `Context at ${maxUsage.toFixed(0)}% capacity (${which}) — condense proactively to avoid hitting limits`,
      command:
        'cmos_context(action="condense", strategy="auto") or strategy="aggressive" for deeper reduction',
      priority: 2,
    });
  }

  // If sync health shows mismatches, warn (skip if cmos_db is hidden)
  if (state.syncHealth && !state.syncHealth.allMatch && !skippedTools.has('cmos_db')) {
    actions.push({
      action: `Sync health: ${state.syncHealth.totalMismatches} table(s) have count mismatches between SQLite and PG mirror`,
      command:
        'cmos_db(action="reconcile") for details, cmos_db(action="backfill", force=true) to re-sync',
      priority: 3,
    });
  }

  // Surface each stale session as an individual high-priority action. s84-m03: a foreign
  // (pull-merged) stale session's title is untrusted DATA — drop it (id-only) when foreign
  // so it never embeds unfenced here or in the promoted review digest. Local is byte-identical.
  for (const session of state.orphans.staleSessions) {
    const label = isForeignProject(session.projectId, state.localProjectId)
      ? `Stale session ${session.id} active for ${Math.round(session.hoursActive)}h — complete or discard`
      : `Stale session ${session.id} ("${session.title}") active for ${Math.round(session.hoursActive)}h — complete or discard`;
    actions.push({
      action: label,
      command: `cmos_session(action="complete", sessionId="${session.id}", summary="Auto-closed: abandoned session")`,
      priority: 1,
    });
  }

  // Surface orphaned sprints/missions at lower priority
  const nonSessionOrphans =
    state.orphans.orphanedSprints.length + state.orphans.orphanedMissions.length;
  if (nonSessionOrphans > 0) {
    actions.push({
      action: `${nonSessionOrphans} orphaned entit${nonSessionOrphans === 1 ? 'y' : 'ies'} detected — review warnings for details`,
      command: 'Review orphan warnings above. Archive unused sprints/missions.',
      priority: 3,
    });
  }

  // If strategic context is stale, recommend refresh immediately.
  if (state.contextFreshness.isStale) {
    actions.push({
      action: `Refresh stale master context (lag ~${state.contextFreshness.lagDays?.toFixed(1) ?? 'unknown'} days)`,
      command: 'cmos_context(action="update")',
      priority: 1,
    });
  }

  // If there are unread messages, suggest checking inbox
  // s87-m05 — gated on THIS PROJECT'S count. It used to fire on the user-wide number, so a
  // project with an empty inbox was told to go clear messages that belong to other projects.
  // A `null` scoped count is UNKNOWN, and an unknown count is not a reason to prescribe an action.
  if (state.messaging && (state.messaging.unreadCountScoped ?? 0) > 0) {
    actions.push({
      action: `Review ${state.messaging.unreadCountScoped} unread message(s) for this project`,
      command: 'cmos_message(action="list", status="pending")',
      priority: 2,
    });
  }

  // s84-m03: a foreign (pull-merged) mission's name is untrusted DATA. These actions feed
  // the byte-capped cmos_review digest (promoted next_actions), so drop the name — render
  // id-only — for a foreign mission rather than fencing (which would cost digest bytes).
  // The command already uses only the id. A local/NULL-project mission is byte-identical.
  const missionActionText = (label: string, m: PendingMissionSummary): string =>
    isForeignProject(m.projectId, state.localProjectId)
      ? `${label}: ${m.id}`
      : `${label}: ${m.id} (${m.name})`;

  // If there are blocked missions, suggest unblocking (skip if missions hidden)
  if (state.blockedMissions.length > 0 && !skippedTools.has('cmos_mission')) {
    const blocked = state.blockedMissions[0];
    actions.push({
      action: missionActionText('Resolve blocked mission', blocked),
      command: `cmos_mission(action="show", missionId="${blocked.id}")`,
      priority: 3,
    });
  }

  // If there's an In Progress mission, suggest continuing it (skip if missions hidden)
  const inProgress = state.pendingMissions.find((m) => m.status === 'In Progress');
  if (inProgress && !skippedTools.has('cmos_mission')) {
    actions.push({
      action: missionActionText('Continue in-progress mission', inProgress),
      command: `cmos_mission(action="show", missionId="${inProgress.id}")`,
      priority: 4,
    });
  }

  // If there's a Current mission (not In Progress), suggest starting it (skip if missions hidden)
  const current = state.pendingMissions.find((m) => m.status === 'Current');
  if (current && !inProgress && !skippedTools.has('cmos_mission_transition')) {
    actions.push({
      action: missionActionText('Start current mission', current),
      command: `cmos_mission_transition(action="start", missionId="${current.id}")`,
      priority: 5,
    });
  }

  // If no active session, suggest starting one
  if (!state.activeSession) {
    actions.push({
      action: 'Start a planning or review session',
      command: 'cmos_session(action="start", type="planning", title="Session title")',
      priority: 6,
    });
  }

  // If there's an active session, remind to complete it. s84-m03: a foreign (pull-merged)
  // active session's title is untrusted DATA — drop it (id-only) rather than embed it
  // unfenced (this action also feeds the byte-capped review digest). Local is byte-identical.
  if (state.activeSession) {
    const s = state.activeSession;
    actions.push({
      action: isForeignProject(s.projectId, state.localProjectId)
        ? `Complete active session: ${s.id}`
        : `Complete active session: ${s.title}`,
      command: `cmos_session(action="complete", summary="Session summary")`,
      priority: 7,
    });
  }

  // If there's a current sprint with completed sprints in history, suggest analytics (skip if sprints hidden)
  if (state.currentSprint && !skippedTools.has('cmos_sprint')) {
    actions.push({
      action: 'View cross-sprint trend analytics (velocity, completion rate, decision volume)',
      command: 'cmos_sprint(action="analytics")',
      priority: 8,
    });
  }

  // Suggest viewing mission status if no other actions (skip if missions hidden)
  if (actions.length === 0 && !skippedTools.has('cmos_mission')) {
    actions.push({
      action: 'View mission queue',
      command: 'cmos_mission(action="status")',
      priority: 1,
    });
  }

  return actions.sort((a, b) => a.priority - b.priority);
}

/**
 * Format agent onboard result for LLM readability.
 *
 * @param result - Agent onboard result
 * @returns Human-readable summary
 */
export function formatAgentOnboardForLLM(result: CmosToolResult<CmosAgentOnboardResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to retrieve onboarding data',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  // Header
  lines.push('🚀 **Agent Onboarding**');
  lines.push('');

  // Project identity
  lines.push(`**Project**: ${data.project.name}`);
  if (data.project.description) {
    lines.push(`  ${data.project.description}`);
  }
  if (data.project.status) {
    lines.push(`  Status: ${data.project.status}`);
  }
  if (data.tierConfig) {
    lines.push(`  Tier: ${data.tierConfig.label} (${data.tierConfig.tier})`);
  }

  // Sprint context. s84-m03: a foreign (pull-merged) sprint's title/focus is untrusted
  // DATA — frame inline against its own project_id; a local/NULL sprint renders bare.
  if (data.currentSprint) {
    const sp = data.currentSprint;
    lines.push('');
    lines.push(
      `**Sprint**: ${sp.id} - ${frameInlineIfForeign(sp.title, sp.projectId, data.localProjectId)}`
    );
    if (sp.focus) {
      lines.push(`  Focus: ${frameInlineIfForeign(sp.focus, sp.projectId, data.localProjectId)}`);
    }
  }

  // Session stats
  lines.push('');
  lines.push(
    `**Sessions**: ${data.sessionStats.totalSessions} total${data.sessionStats.lastActivity ? `, last: ${data.sessionStats.lastActivity}` : ''}`
  );

  lines.push('');
  lines.push(
    `**Context Size**: ${data.contextSizes.totalSizeKb.toFixed(2)}KB (${data.contextSizes.totalSizeBytes} bytes total)`
  );
  if (data.contextSizes.masterContext) {
    lines.push(
      `  master_context: ${data.contextSizes.masterContext.sizeKb.toFixed(2)}KB (${data.contextSizes.masterContext.usagePercent.toFixed(1)}%)`
    );
  }
  if (data.contextSizes.projectContext) {
    lines.push(
      `  project_context: ${data.contextSizes.projectContext.sizeKb.toFixed(2)}KB (${data.contextSizes.projectContext.usagePercent.toFixed(1)}%)`
    );
  }

  // Context freshness
  lines.push('');
  lines.push(
    `**Context Freshness**: ${data.contextFreshness.isStale ? 'stale' : 'fresh'}${
      data.contextFreshness.lagDays !== null
        ? ` (${data.contextFreshness.lagDays.toFixed(1)} day lag)`
        : ''
    }`
  );
  lines.push(`  master_context.updated_at: ${data.contextFreshness.contextUpdatedAt ?? 'unknown'}`);
  lines.push(`  latest completed activity: ${data.contextFreshness.latestActivityAt ?? 'none'}`);

  // Sync health (reconciliation)
  if (data.syncHealth) {
    lines.push('');
    if (data.syncHealth.allMatch) {
      lines.push('**Sync Health**: all tables match');
    } else {
      lines.push(`**Sync Health**: ${data.syncHealth.totalMismatches} table(s) mismatched`);
      for (const m of data.syncHealth.mismatches) {
        const sign = m.delta > 0 ? '+' : '';
        lines.push(`  ${m.table}: SQLite=${m.sqliteCount} PG=${m.pgCount} (${sign}${m.delta})`);
      }
    }
    if (data.syncHealth.failedEntries > 0) {
      lines.push(`  Failed sync entries: ${data.syncHealth.failedEntries}`);
    }
  }

  // Server health
  if (data.serverHealth) {
    lines.push('');
    const sh = data.serverHealth;
    const uptimeStr =
      sh.uptimeSeconds < 60
        ? `${sh.uptimeSeconds}s`
        : sh.uptimeSeconds < 3600
          ? `${Math.floor(sh.uptimeSeconds / 60)}m`
          : `${Math.floor(sh.uptimeSeconds / 3600)}h ${Math.floor((sh.uptimeSeconds % 3600) / 60)}m`;
    const buildHash = sh.startupBuild?.buildHash.slice(0, 12) ?? 'unknown';
    const staleTag = sh.codeIsCurrent ? 'current' : '⚠️ STALE';
    lines.push(
      `**Server Health**: pid=${sh.pid} uptime=${uptimeStr} mem=${sh.memoryUsageMb}MB build=${buildHash}… (${staleTag})`
    );
    if (sh.stalenessMessage) {
      lines.push(`  ${sh.stalenessMessage}`);
    }
  }

  // Orphan detection
  if (data.orphans && data.orphans.totalOrphans > 0) {
    lines.push('');
    lines.push(
      `**Orphans**: ${data.orphans.totalOrphans} detected (${data.orphans.orphanedSprints.length} sprint(s), ${data.orphans.orphanedMissions.length} mission(s), ${data.orphans.staleSessions.length} stale session(s))`
    );
  }

  // Messaging
  if (data.messaging) {
    lines.push('');
    // s87-m05 — THE RENDERED ANSWER NAMES ITS SCOPE. This printed the user-wide count as
    // `**Messaging**: 7 unread` inside a project-scoped digest. Measured live, the truthful
    // project-scoped number was 0.
    const m = data.messaging;
    lines.push(
      m.unreadScope === 'project' && m.unreadCountScoped !== null
        ? `**Messaging**: ${m.unreadCountScoped} unread for this project`
        : `**Messaging**: unread count for this project is unknown — the dashboard returned an ` +
            `unscoped total of ${m.unreadCountUserWide} across all your projects`
    );
    if (data.messaging.recentMessages.length > 0) {
      for (const msg of data.messaging.recentMessages) {
        // s78-m05: inbound message summaries are untrusted foreign content — frame them.
        const src = msg.from ?? 'unknown sender';
        lines.push(`  • [${msg.type}] ${frameForeignInline(msg.summary, src)}`);
      }
    }
  }

  // Active session. s84-m03: a foreign session's title is untrusted DATA — frame inline.
  if (data.activeSession) {
    const s = data.activeSession;
    lines.push('');
    lines.push('⚡ **Active Session**');
    lines.push(`  ${s.type}: ${frameInlineIfForeign(s.title, s.projectId, data.localProjectId)}`);
    lines.push(`  Captures: ${s.captureCount}`);
  }

  // Pending missions. s84-m03: a foreign (pull-merged) mission's name is untrusted DATA.
  if (data.pendingMissions.length > 0) {
    lines.push('');
    lines.push('📋 **Pending Work**');
    for (const m of data.pendingMissions) {
      const name = frameInlineIfForeign(m.name, m.projectId, data.localProjectId);
      lines.push(`  • ${m.id} (${m.status}): ${name}`);
    }
  }

  // Blocked missions
  if (data.blockedMissions.length > 0) {
    lines.push('');
    lines.push('🚫 **Blocked**');
    for (const m of data.blockedMissions) {
      const name = frameInlineIfForeign(m.name, m.projectId, data.localProjectId);
      lines.push(`  • ${m.id}: ${name}`);
    }
  }

  // Recent decisions. s83-m06: a pull-merged FOREIGN decision (project_id != local)
  // is untrusted content — render it inside the compact untrusted marker, not as a
  // bare bullet that reads as an instruction (matches the message-list sibling above).
  if (data.recentDecisions.length > 0) {
    lines.push('');
    lines.push('📝 **Recent Decisions**');
    const localProjectId = data.localProjectId ?? null;
    for (const d of data.recentDecisions.slice(0, 5)) {
      const domain = d.domain ? ` [${d.domain}]` : '';
      const isForeign =
        d.projectId != null && (localProjectId == null || d.projectId !== localProjectId);
      if (isForeign) {
        lines.push(`  • ${frameForeignInline(d.decision, `proj:${d.projectId}`)}${domain}`);
      } else {
        lines.push(`  • ${d.decision}${domain}`);
      }
    }
  }

  // Next steps
  if (data.nextSteps.length > 0) {
    lines.push('');
    lines.push('➡️ **Next Steps**');
    for (const step of data.nextSteps) {
      lines.push(`  • ${step}`);
    }
  }

  // Suggested actions
  if (data.suggestedActions.length > 0) {
    lines.push('');
    lines.push('💡 **Suggested Actions**');
    for (const action of data.suggestedActions.slice(0, 3)) {
      lines.push(`  ${action.priority}. ${action.action}`);
      lines.push(`     → ${action.command}`);
    }
  }

  // Tier behavioral guide
  if (data.tierConfig?.guide) {
    lines.push('');
    lines.push('📖 **Behavioral Guide**');
    lines.push(data.tierConfig.guide);
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
