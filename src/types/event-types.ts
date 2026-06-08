// ABOUTME: Sprint 69 m03 — the CmosGenesisEventType discriminated union and the
// table → genesis-verb map (s68 ADR Section 2.4). This is the single source of
// truth shared between row INSERT sites (via genesisColumns) and the
// sync_event_queue backfill emitters; adding a new event_type without updating
// this union fails at compile time.

/**
 * Genesis (row-creation) event types. **Genesis-only semantics** at the row
 * level (s68 ADR Section 2.3): `row.event_type` is frozen at INSERT and never
 * mutated. State transitions (mission start/complete, decision supersession,
 * etc.) live in `sync_event_queue` / the future `event_log`, NOT here.
 *
 * 8 active values + 1 reserved (`capture_recorded`, activated when `captures`
 * becomes its own table — FUTURE, not s69).
 */
export type CmosGenesisEventType =
  | 'decision_captured'
  | 'learning_captured'
  | 'mission_added'
  | 'sprint_added'
  | 'session_started'
  | 'next_step_created' // NEW in s69
  | 'constraint_added' // NEW in s69
  | 'snapshot_taken' // NEW in s69
  | 'capture_recorded'; // FUTURE — when captures becomes a table

/**
 * The 8 firehose (domain-event) tables that receive the per-row schema columns
 * and the `(project_id, event_type, occurred_at)` composite index (s68 ADR §1).
 */
export const FIREHOSE_TABLES = [
  'strategic_decisions',
  'learnings',
  'missions',
  'sprints',
  'sessions',
  'next_steps',
  'constraints',
  'context_snapshots',
] as const;

export type FirehoseTable = (typeof FIREHOSE_TABLES)[number];

/**
 * The single genesis verb each firehose table stamps on every new row. Under
 * genesis-only semantics each table has exactly one allowed value today; the
 * per-table CHECK constraint enumerates it. If a future genesis sub-type appears
 * (e.g. `decision_imported`), expand both this map's value type and the CHECK —
 * but only with same-sprint sync-emitter parity (ADR §2.5).
 */
export const GENESIS_TYPE_BY_TABLE: Record<FirehoseTable, CmosGenesisEventType> = {
  strategic_decisions: 'decision_captured',
  learnings: 'learning_captured',
  missions: 'mission_added',
  sprints: 'sprint_added',
  sessions: 'session_started',
  next_steps: 'next_step_created',
  constraints: 'constraint_added',
  context_snapshots: 'snapshot_taken',
};

/** Type guard for a known firehose table name. */
export function isFirehoseTable(name: string): name is FirehoseTable {
  return (FIREHOSE_TABLES as readonly string[]).includes(name);
}
