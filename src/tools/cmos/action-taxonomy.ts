// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Fail-closed read/write action taxonomy for the CMOS tool surface (Sprint 78 m04).
// ABOUTME: classifyAction(tool, action) => 'read' | 'write'; unknown tools/actions default to 'write'.

export type ActionMode = 'read' | 'write';

/**
 * Tools that take NO `action` parameter and are entirely read-only digests /
 * diagnostics. Every call to one of these is a read.
 *
 * `cmos_agent_onboard` is deliberately NOT here (s78-m04 adversarial review): its
 * handler WRITES the CMOS store — resolveAndPersistOwner (metadata), backfillUnknownCmosAddress
 * / project-identity (contexts), and recordAgentFeedback (INSERT INTO agent_feedback when an
 * `agentFeedback` arg is passed). It is therefore write-classified and blocked under review;
 * a review agent uses `cmos_review` (a genuine read digest) for cold-start context instead.
 *
 * `cmos_review` and `cmos_status` ARE pure reads of the CMOS store. `cmos_review` additionally
 * touches the *per-user project-graph registry* `last_seen_at` (a separate store, bookkeeping) —
 * that write is suppressed under review at its call site so review mode mutates nothing anywhere.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['cmos_review', 'cmos_status']);

/**
 * Per-tool allowlist of read-only ACTIONS for the action-bearing tools.
 *
 * FAIL-CLOSED CONTRACT: an action is 'read' ONLY if it is listed here. Everything
 * else is 'write' — unknown tools, unknown/new actions, and every action of a tool
 * absent from this map. When a tool gains a new action it defaults to 'write' until
 * deliberately promoted here (the taxonomy-drift test guards that every shipped
 * action is covered and that this map contains no stale/typo entries).
 *
 * SECURITY BIAS: misclassifying a write as a read is a data-loss vulnerability;
 * misclassifying a read as a write only over-restricts a review agent. So only
 * UNAMBIGUOUS pure reads are listed. Deliberately WRITE (i.e. NOT listed) despite
 * looking read-ish:
 *   - cmos_context next_steps / constraints — sub-dispatchers that route to a
 *     nested read-OR-write sub-action; the top-level action can't prove read-only.
 *   - cmos_db identify_orphans — a sync diagnostic that can enqueue work.
 *   - cmos_decisions review / cmos_sprint retro / analytics — report generators
 *     that may persist; promote here with per-handler proof if a reviewer needs them.
 *   - cmos_project validate — carries a mutating `prune` option.
 *
 * NOTE: this is a DIFFERENT concept from client.ts `isReadAction`/`READ_ACTIONS`,
 * which is a narrow *fan-out-eligibility* subset (it deliberately omits large-payload
 * and ID-colliding reads, and is not exhaustive). Do not unify the two.
 */
export const READ_ONLY_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  cmos_context: ['view', 'history', 'search'],
  cmos_db: ['health'],
  cmos_decisions: ['list', 'search'],
  cmos_feedback: ['list'],
  cmos_learnings: ['list', 'search'],
  cmos_mission: ['list', 'show', 'status'],
  cmos_mission_transition: [],
  cmos_project: ['list'],
  cmos_session: ['list', 'search'],
  cmos_sprint: ['list', 'show'],
  cmos_auth: ['list'],
  cmos_message: ['list', 'directory', 'whoami'],
};

/**
 * Classify a (toolName, action) pair. Returns 'read' ONLY for an action-less
 * read tool, or an action explicitly allowlisted for its tool. Everything else —
 * unknown tool, action-bearing tool called with no action, or any non-allowlisted
 * action — is 'write' (fail closed).
 */
export function classifyAction(toolName: string, action: string | undefined): ActionMode {
  if (READ_ONLY_TOOLS.has(toolName)) return 'read';
  const reads = READ_ONLY_ACTIONS[toolName];
  if (reads === undefined) return 'write'; // unknown tool → fail closed
  if (action === undefined) return 'write'; // action-bearing tool with no action → fail closed
  return reads.includes(action) ? 'read' : 'write';
}
