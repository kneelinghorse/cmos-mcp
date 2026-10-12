// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m04 per-action applicability contract — which published parameter applies to which
// ABOUTME: action, for the 12 action-bearing tools. Consumed by the renderer, gated in both directions.

/**
 * Sprint 86 m04 — ACTION_PARAMS.
 *
 * ── WHY THIS IS PRODUCT DATA, NOT AN ALLOWLIST ─────────────────────────────────────────────────
 * This sprint's fence is absolute: no gate carries a list of things it skips. ACTION_PARAMS is not
 * that. It is the applicability CONTRACT — the thing the tree previously stated only in prose
 * inside `.describe()` strings that were already wrong (`rbook_learnings.learningId` read "Learning
 * ID for update action" while `reaffirm` requires it just as much). It is CONSUMED by
 * `scripts/lib/render-tool-reference.js`, PUBLISHED as the per-action tables in TOOL_REFERENCE.md,
 * and CHECKED IN BOTH DIRECTIONS by tests/tools/rbook/action-params.test.ts: every entry must be
 * something the router demonstrably does with that key on that action, and every published key of
 * an action-bearing tool must be claimed by at least one action.
 *
 * ── WHY IT IS AUTHORED RATHER THAN GENERATED ───────────────────────────────────────────────────
 * Its first cut IS generated — `npm run probe:action-params` derives one from the same walk
 * s86-m03's forwarding gate uses. But a map that can only ever EQUAL the derivation can never be
 * red about the derivation. s86-m03's `evergreen` defect is the proof: `rbook_learnings(action=
 * "reaffirm", evergreen=true)` returned success and wrote nothing for two sprints, and the
 * declared-vs-forwarded guard was GREEN on it, because `RbookLearningsReaffirmParams` under-declared
 * the key in exactly the same way the router under-forwarded it. An authored map states what SHOULD
 * apply; the gate then measures the tree against it. Had this map existed, that bug would have been
 * a red gate rather than a silent no-op — which is what "permanently, mechanically detectable"
 * means.
 *
 * ── THE PARTITION IS A RULE, NOT A LIST ────────────────────────────────────────────────────────
 * A tool has an entry here IFF its published `inputSchema` declares `properties.action.enum`.
 * Twelve do; `rbook_agent_onboard`, `rbook_status` and `rbook_review` do not, and a test fails if
 * either side of that biconditional breaks — including if one of those three ever gains an action.
 */

import { RBOOK_MISSION_ACTION_PARAMS } from './rbook-mission';
import { RBOOK_MISSION_TRANSITION_ACTION_PARAMS } from './rbook-mission-transition';
import { RBOOK_SPRINT_ACTION_PARAMS } from './rbook-sprint';
import { RBOOK_CONTEXT_ACTION_PARAMS } from './rbook-context';
import { RBOOK_SESSION_ACTION_PARAMS } from './rbook-session';
import { RBOOK_DECISIONS_ACTION_PARAMS } from './rbook-decisions';
import { RBOOK_DB_ACTION_PARAMS } from './rbook-db';
import { RBOOK_PROJECT_ACTION_PARAMS } from './rbook-project';
import { RBOOK_LEARNINGS_ACTION_PARAMS } from './rbook-learnings';
import { RBOOK_FEEDBACK_ACTION_PARAMS } from './rbook-feedback';
import { RBOOK_AUTH_ACTION_PARAMS } from './rbook-auth';
import { RBOOK_MESSAGE_ACTION_PARAMS } from './rbook-message';

/**
 * The registry the renderer reads, keyed by published tool name.
 *
 * Kept beside the tool definitions rather than ON them: adding a field to a
 * `RBOOK_TOOL_DEFINITIONS` entry would put a non-MCP key into the `tools/list` payload every host
 * receives, and this is documentation input, not protocol.
 */
export const RBOOK_ACTION_PARAMS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  rbook_mission: RBOOK_MISSION_ACTION_PARAMS,
  rbook_mission_transition: RBOOK_MISSION_TRANSITION_ACTION_PARAMS,
  rbook_sprint: RBOOK_SPRINT_ACTION_PARAMS,
  rbook_context: RBOOK_CONTEXT_ACTION_PARAMS,
  rbook_session: RBOOK_SESSION_ACTION_PARAMS,
  rbook_decisions: RBOOK_DECISIONS_ACTION_PARAMS,
  rbook_db: RBOOK_DB_ACTION_PARAMS,
  rbook_project: RBOOK_PROJECT_ACTION_PARAMS,
  rbook_learnings: RBOOK_LEARNINGS_ACTION_PARAMS,
  rbook_feedback: RBOOK_FEEDBACK_ACTION_PARAMS,
  rbook_auth: RBOOK_AUTH_ACTION_PARAMS,
  rbook_message: RBOOK_MESSAGE_ACTION_PARAMS,
};
