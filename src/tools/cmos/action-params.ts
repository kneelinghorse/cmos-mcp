// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m04 per-action applicability contract — which published parameter applies to which
// ABOUTME: action, for the 12 action-bearing tools. Consumed by the renderer, gated in both directions.

/**
 * Sprint 86 m04 — ACTION_PARAMS.
 *
 * ── WHY THIS IS PRODUCT DATA, NOT AN ALLOWLIST ─────────────────────────────────────────────────
 * This sprint's fence is absolute: no gate carries a list of things it skips. ACTION_PARAMS is not
 * that. It is the applicability CONTRACT — the thing the tree previously stated only in prose
 * inside `.describe()` strings that were already wrong (`cmos_learnings.learningId` read "Learning
 * ID for update action" while `reaffirm` requires it just as much). It is CONSUMED by
 * `scripts/lib/render-tool-reference.js`, PUBLISHED as the per-action tables in TOOL_REFERENCE.md,
 * and CHECKED IN BOTH DIRECTIONS by tests/tools/cmos/action-params.test.ts: every entry must be
 * something the router demonstrably does with that key on that action, and every published key of
 * an action-bearing tool must be claimed by at least one action.
 *
 * ── WHY IT IS AUTHORED RATHER THAN GENERATED ───────────────────────────────────────────────────
 * Its first cut IS generated — `npm run probe:action-params` derives one from the same walk
 * s86-m03's forwarding gate uses. But a map that can only ever EQUAL the derivation can never be
 * red about the derivation. s86-m03's `evergreen` defect is the proof: `cmos_learnings(action=
 * "reaffirm", evergreen=true)` returned success and wrote nothing for two sprints, and the
 * declared-vs-forwarded guard was GREEN on it, because `CmosLearningsReaffirmParams` under-declared
 * the key in exactly the same way the router under-forwarded it. An authored map states what SHOULD
 * apply; the gate then measures the tree against it. Had this map existed, that bug would have been
 * a red gate rather than a silent no-op — which is what "permanently, mechanically detectable"
 * means.
 *
 * ── THE PARTITION IS A RULE, NOT A LIST ────────────────────────────────────────────────────────
 * A tool has an entry here IFF its published `inputSchema` declares `properties.action.enum`.
 * Twelve do; `cmos_agent_onboard`, `cmos_status` and `cmos_review` do not, and a test fails if
 * either side of that biconditional breaks — including if one of those three ever gains an action.
 */

import { CMOS_MISSION_ACTION_PARAMS } from './cmos-mission';
import { CMOS_MISSION_TRANSITION_ACTION_PARAMS } from './cmos-mission-transition';
import { CMOS_SPRINT_ACTION_PARAMS } from './cmos-sprint';
import { CMOS_CONTEXT_ACTION_PARAMS } from './cmos-context';
import { CMOS_SESSION_ACTION_PARAMS } from './cmos-session';
import { CMOS_DECISIONS_ACTION_PARAMS } from './cmos-decisions';
import { CMOS_DB_ACTION_PARAMS } from './cmos-db';
import { CMOS_PROJECT_ACTION_PARAMS } from './cmos-project';
import { CMOS_LEARNINGS_ACTION_PARAMS } from './cmos-learnings';
import { CMOS_FEEDBACK_ACTION_PARAMS } from './cmos-feedback';
import { CMOS_AUTH_ACTION_PARAMS } from './cmos-auth';
import { CMOS_MESSAGE_ACTION_PARAMS } from './cmos-message';

/**
 * The registry the renderer reads, keyed by published tool name.
 *
 * Kept beside the tool definitions rather than ON them: adding a field to a
 * `CMOS_TOOL_DEFINITIONS` entry would put a non-MCP key into the `tools/list` payload every host
 * receives, and this is documentation input, not protocol.
 */
export const CMOS_ACTION_PARAMS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  cmos_mission: CMOS_MISSION_ACTION_PARAMS,
  cmos_mission_transition: CMOS_MISSION_TRANSITION_ACTION_PARAMS,
  cmos_sprint: CMOS_SPRINT_ACTION_PARAMS,
  cmos_context: CMOS_CONTEXT_ACTION_PARAMS,
  cmos_session: CMOS_SESSION_ACTION_PARAMS,
  cmos_decisions: CMOS_DECISIONS_ACTION_PARAMS,
  cmos_db: CMOS_DB_ACTION_PARAMS,
  cmos_project: CMOS_PROJECT_ACTION_PARAMS,
  cmos_learnings: CMOS_LEARNINGS_ACTION_PARAMS,
  cmos_feedback: CMOS_FEEDBACK_ACTION_PARAMS,
  cmos_auth: CMOS_AUTH_ACTION_PARAMS,
  cmos_message: CMOS_MESSAGE_ACTION_PARAMS,
};
