// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Remedy-reachability gate for mission refusals and the two close-adjacent success warnings.
// ABOUTME: Every covered cmos_*(action=…) prescription is replayed from its prescribed state.

/**
 * Sprint 87 m01 — NO PRESCRIBED REMEDY MAY CRASH.
 *
 * THE DEFECT THIS GATE EXISTS FOR. `CmosErrors.missionInvalidTransition` looked up
 * `VALID_STATE_TRANSITIONS[currentStatus]` and dereferenced `.length` with no guard. `currentStatus`
 * comes from the STORE, not from the type system, and this repo's own store holds a mission whose
 * status is `Archived` — not a key of that map. Six handlers delegate to that factory, so all six
 * threw an unhandled `TypeError`, which the MCP boundary converts into *"This is an internal
 * error … retry the call"*: a loop with no exit. s86-m08 recorded in #1004 that it had fixed this;
 * it placed the guard one frame too low, at `cmos-mission-update.ts`, and the throw simply moved
 * into the factory that handler calls (D-4, #1023).
 *
 * WHY A MATRIX AND NOT SIX UNIT TESTS. The class is *a remedy that names the wrong cause*, and a
 * unit test asserts the remedy STRING. Only executing the string finds out whether it is reachable.
 * Every cell here takes the `suggestion` the tool actually returned, extracts the `cmos_*(action=…)`
 * it prescribes with s85-m01's own `CALL_RE`/`ACTION_RE`, and RUNS it.
 *
 * WHY A REAL-STORE COPY (agents.md Process Hardening #4, decision #926 #3). A seeded fixture is
 * provably not a real store: `router-param-reachability-real-store.test.ts`'s header records
 * `schema.ts` declaring six foreign keys on `strategic_decisions` where the live store carries
 * three, and s80-m07 shipping a dead `deleted_at` predicate straight through that gap.
 *
 * PRECONDITIONS ARE ESTABLISHED, NEVER INHERITED (next-step #547, binding). Every trigger state in
 * the matrix is SET by `UPDATE missions SET status = ?` on the copy before the cell runs. The
 * earlier draft of this design leaned on the live store *happening* to hold an `Archived` row —
 * exactly the shape that reddened `sprint-summary-denominator.test.ts` (82584cb) and
 * `router-param-reachability-real-store.test.ts` FIRE 4 (82429ec) in a single working day, the
 * second of which went red because the feature it asserted was unreachable started working. Row
 * VOLUME and SCHEMA SHAPE are inherited here; row PROPERTIES are not. `LIVE_OUT_OF_ENUM` below
 * still MEASURES the live distribution and reports it (m01 step 9 hands that number to m08 step
 * 11(c)) — it just never gates on it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * MEASURED RED BASELINE — run on an unmodified tree at HEAD f1433a0, before any `src/` edit.
 * These are observed numbers, not predictions.
 *
 *   ARM 1 — 9 trigger states x 7 driven actions = 63 cells.
 *           `SUCCEEDS=17  REFUSES=34  CRASHES=12`.
 *           All 12 crashes are the two OUT-OF-ENUM trigger states, `Archived` and `Failed`, over
 *           six of the seven actions. The two throw messages are DIFFERENT, and the difference is
 *           the whole of D-4 (#1023):
 *             - start / complete / block / drop / defer  → `reading 'includes'`, thrown at the
 *               handler's own unguarded `validTransitions.includes(targetStatus)`;
 *             - update                                    → `reading 'length'`, thrown from
 *               `errors.ts` inside `CmosErrors.missionInvalidTransition`. `cmos-mission-update.ts`
 *               already had s86-m08's `?? []`, so it never threw at its own line — it threw one
 *               frame UP, in the factory it calls. That is the proof the s86-m08 guard was placed
 *               below the throw, and #1004's claim (3) that the crash was fixed is false.
 *           `unblock` alone does not crash from either state: it returns at its
 *           `currentStatus !== 'Blocked'` branch before any lookup — which is how it came to
 *           answer an unrecognized status with a confident, wrong remedy instead.
 *   ARM 1 NAMED-REFUSAL — `Archived -> unblock` and `Failed -> unblock` answered
 *           *"Use cmos_mission_transition(action=\"start\") to begin work on this mission"*:
 *           a prescription issued about a status the state machine has never heard of.
 *   ARM 1 TIER 2 — 3 undisclosed remedies. `cmos-mission-unblock.ts`'s not-blocked branch
 *           prescribed `start` unconditionally from `In Progress`, `Dropped` and `Deferred`, and
 *           executing it REFUSES from all three.
 *   ARM 2 — 42 read-classified prescriptions across 16 distinct (tool, action) pairs, against 94
 *           write-classified. Green at baseline; it ships as the rule that keeps the exemption
 *           earned, not as a fix.
 *   ARM 3 — 140 `cmos_*()` calls swept, 0 parameter problems. Also green at baseline: a
 *           REGRESSION FLOOR, and this file says so rather than counting it as a repair.
 *           (The plan predicted 44 calls; the measured corpus is 140. The plan's figure was not
 *           re-derivable and is corrected here rather than carried.)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ─── FALSE-NEGATIVE PROFILE (house style: `no-silent-write.test.ts`) ───────────────────────────
 * This gate is a FLOOR, not a proof. It concedes all of the following, and each one is a real hole:
 *
 *  1. ONLY `cmos_*(action=…)` REMEDIES ARE CHECKED. A remedy phrased as prose ("re-run the
 *     migration", "check file permissions") carries no executable token and is invisible here.
 *     That is the class-(b) residue this sprint REFUSES to gate at any budget (D-5, #1024): there
 *     is no oracle for *"does this string name the right cause"*.
 *  2. ONLY SINGLE-COLUMN TRIGGER STATES ARE ENUMERATED. Each cell forces one value into
 *     `missions.status`. A defect reachable only from a COMBINATION (a status plus an absent
 *     sprint, plus a domain_fields shape) is out of the corpus. The 12 auth/dashboard
 *     prescriptions, whose trigger is a credential state and not a row, are out entirely.
 *  3. `SUCCEEDS` IS JUDGED FROM THE ROUTER RETURN. A remedy that succeeds and does the WRONG
 *     THING passes this gate. The gate proves reachability, never correctness.
 *  4. THE TRIGGER STATE IS FORCED BY SQL, so a red cell may be unreachable through any supported
 *     call sequence (UA-5). Each trigger state below therefore carries an explicit
 *     reachable-by-supported-ops note in `TRIGGER_STATES`; `Archived` is witnessed live,
 *     `Failed` is reachable-but-unwitnessed, and that distinction is stated rather than blurred.
 *  5. REMEDY ARGUMENTS ARE NOT REPLAYED VERBATIM. The extractor reads the TOOL and the ACTION;
 *     required companions (`reason`, `resolution`, a target `status`) are supplied synthetically.
 *     A remedy that would fail only on a specific argument value passes here.
 *  6. TIER 2 IS A SHAPE RULE, NOT A SEMANTIC ONE. "Is this remedy disclosed as conditional?" is
 *     answered by looking for hedging tokens in the suggestion. A string containing `if` for an
 *     unrelated reason passes; a string that discloses the condition in words this rule does not
 *     know refuses. It is deliberately the weaker half of the gate — Tier 1 is the hard one.
 *  7. ARM 3 PARSES ONE STRING-LITERAL CHUNK AT A TIME. A template literal is split by the
 *     TypeScript scanner at every `${}`, so a `cmos_*()` call whose arguments span an
 *     interpolation is only partially visible, and its later parameters are not checked.
 *  8. THE MATRIX DRIVES THE ROUTERS IN-PROCESS, NOT THE BUILT `dist/` OVER STDIO. The published
 *     artifact is gated separately, in `scripts/verify-dist.ts` — which is the only check that
 *     sees what actually ships.
 *  9. ENVELOPE SUCCESS-WARNING COVERAGE IS BOUNDED TO TWO CLOSE-ADJACENT PRODUCERS. ARM 1
 *     establishes and replays the `cmos_sprint(action="complete")` warning from successful
 *     `cmos_mission_transition(action="complete")` and `cmos_session(action="complete")`
 *     answers; it does not imply coverage of those actions' other warning branches. A source
 *     audit finds exactly NINE other shipped success paths whose envelope `warnings[]` can carry
 *     an executable `cmos_*(` prescription:
 *       - `cmos_agent_onboard`
 *       - `cmos_session(action="start")`
 *       - `cmos_message(action="send")`
 *       - `cmos_message(action="whoami")`
 *       - `cmos_context(action="view")`
 *       - `cmos_context(action="update")`
 *       - `cmos_sprint(action="retro")`
 *       - `cmos_sprint(action="complete")`
 *       - `cmos_decisions(action="review")`
 *     They remain ARM-3-only: their tool/action/parameters may be checked for existence, but the
 *     prescribed call is not run. The `whoami` warning's unquoted `action=reissue` also escapes
 *     ACTION_RE.
 *
 *     Three lookalikes are excluded by rule, not omission. `cmos_review` filters out the onboard
 *     call-bearing warnings; its promoted `next_actions` are not warnings.
 *     `cmos_db(action="backfill")` stores its registration prescription in `data.warnings`, not
 *     the envelope `warnings[]` this arm reads (and its formatter does not render that nested
 *     list).
 *     `cmos_session(action="capture")` says an unstamped row “will not appear in” a dynamically
 *     named list call; that call is descriptive, while the actual advice (“Pass missionId”) is
 *     prose, and its split template token is already conceded by hole 7.
 *
 * NO ALLOWLIST. There is no exemption file and no per-site suppression anywhere in this gate.
 * Every exclusion above derives from a stated rule, which is the standing convention set by the
 * s85/s86 gate headers.
 *
 * NEVER AGAINST THE LIVE FILE. One suite-private snapshot is taken before the matrix; every cell
 * runs on a further `mkdtempSync` copy. The final test hashes that private snapshot and checks all
 * routed write paths. It deliberately makes no claim about a shared live file's mtime, which a
 * concurrent CMOS writer owns too.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { cmosMission } from '../../../src/tools/cmos/cmos-mission';
import { cmosMissionTransition } from '../../../src/tools/cmos/cmos-mission-transition';
import { cmosSession } from '../../../src/tools/cmos/cmos-session';
import { cmosSprint } from '../../../src/tools/cmos/cmos-sprint';
import { CMOS_TOOL_DEFINITIONS } from '../../../src/tools/cmos';
import { classifyAction } from '../../../src/tools/cmos/action-taxonomy';
import { reidentifyCmosTestStore } from '../../helpers/seedCmosDb';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LIVE_DB = path.join(REPO_ROOT, 'cmos', 'db', 'cmos.sqlite');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/** The mission row every cell drives. Its status is SET per cell; nothing about it is inherited. */
const DRIVER_MISSION_ID = 'B1.1';

const tmpDirs: string[] = [];
const routedDbPaths: string[] = [];
let privateSourceDb = '';
let privateSourceDigest = '';
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function copyStoreBundle(sourceDb: string, destinationDb: string): void {
  fs.mkdirSync(path.dirname(destinationDb), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${sourceDb}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${destinationDb}${suffix}`);
  }
}

/** Content identity for a SQLite main/WAL/SHM bundle; timestamps are intentionally absent. */
function storeBundleDigest(dbPath: string): string {
  const hash = createHash('sha256');
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbPath}${suffix}`;
    hash.update(`${suffix}\0${fs.existsSync(candidate) ? 'present' : 'absent'}\0`);
    if (fs.existsSync(candidate)) hash.update(fs.readFileSync(candidate));
  }
  return hash.digest('hex');
}

/** Freeze the shared source once. No test handler receives this path. */
beforeAll(() => {
  const privateRoot = mkTmp('cmos-s88m03-private-source-');
  privateSourceDb = path.join(privateRoot, 'cmos', 'db', 'cmos.sqlite');
  copyStoreBundle(LIVE_DB, privateSourceDb);
  privateSourceDigest = storeBundleDigest(privateSourceDb);
});

/** Give each scenario its own writable copy of the suite-private frozen source. */
function copyFrozenStore(prefix: string): { projectRoot: string; dbPath: string } {
  if (!privateSourceDb) throw new Error('suite-private source was not initialized');
  const projectRoot = mkTmp(prefix);
  const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
  copyStoreBundle(privateSourceDb, dbPath);
  reidentifyCmosTestStore(projectRoot);
  routedDbPaths.push(dbPath);
  return { projectRoot, dbPath };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE EXTRACTOR — s85-m01's own regexes, so the two gates read remedy strings identically.
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** A `cmos_something(` call token. Identical to `agent-prompt-tool-names.test.ts`. */
const CALL_RE = /\bcmos_[a-z_]+\s*\(/g;
/** `action: "x"` / `action="x"` as the first argument of that call. */
const ACTION_RE = /^\s*action\s*[:=]\s*["'`]([a-z_]+)["'`]/;

/** tool name -> its action enum (null when the tool takes no `action` param). */
const TOOL_ACTIONS: Map<string, Set<string> | null> = new Map(
  CMOS_TOOL_DEFINITIONS.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, { enum?: unknown }> };
    const actionProp = schema?.properties?.action;
    const values = actionProp && Array.isArray(actionProp.enum) ? actionProp.enum : null;
    return [tool.name, values ? new Set(values.map(String)) : null] as const;
  })
);

/** tool name -> the set of parameter names its published inputSchema declares. */
const TOOL_PARAMS: Map<string, Set<string>> = new Map(
  CMOS_TOOL_DEFINITIONS.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> };
    return [tool.name, new Set(Object.keys(schema?.properties ?? {}))] as const;
  })
);

interface PrescribedCall {
  tool: string;
  action: string | undefined;
  /** The `status` literal the call names, when it names one (`fields={"status":"Queued"}`). */
  status: string | undefined;
}

/** Every `cmos_X(action="Y")` a suggestion string prescribes, in source order. */
function extractPrescribedCalls(text: string): PrescribedCall[] {
  const out: PrescribedCall[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(text)) !== null) {
    const tool = m[0].slice(0, m[0].indexOf('(')).trim();
    const rest = text.slice(m.index + m[0].length);
    const actionMatch = rest.match(ACTION_RE);
    // A `"status": "X"` anywhere in the 200 chars following the call token. Bounded so a
    // later, unrelated call's status is not attributed to this one.
    const statusMatch = rest.slice(0, 200).match(/["']?status["']?\s*[:=]\s*["']([A-Za-z ]+)["']/);
    out.push({
      tool,
      action: actionMatch ? actionMatch[1] : undefined,
      status: statusMatch ? statusMatch[1] : undefined,
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// ARM 1 — THE MATRIX
// ───────────────────────────────────────────────────────────────────────────────────────────────

type Outcome = 'SUCCEEDS' | 'REFUSES' | 'CRASHES';

/**
 * Every trigger state, with its reachability note (false-negative 4 / UA-5). The state is forced
 * by SQL, so each one has to say how a supported call sequence could produce it.
 */
const TRIGGER_STATES: ReadonlyArray<{ status: string; reachable: string }> = [
  { status: 'Queued', reachable: 'published enum; cmos_mission(add) default' },
  { status: 'Current', reachable: 'published enum; cmos_mission(update)' },
  { status: 'In Progress', reachable: 'published enum; cmos_mission_transition(start)' },
  { status: 'Blocked', reachable: 'published enum; cmos_mission_transition(block)' },
  { status: 'Completed', reachable: 'published enum; cmos_mission_transition(complete)' },
  { status: 'Dropped', reachable: 'published enum; cmos_mission_transition(drop)' },
  { status: 'Deferred', reachable: 'published enum; cmos_mission_transition(defer)' },
  {
    status: 'Archived',
    reachable:
      "WITNESSED LIVE — this repo's own store holds mission B1.1 at status Archived. Not a key " +
      'of VALID_STATE_TRANSITIONS and not a member of VALID_MISSION_STATUSES; it arrives through ' +
      'import and peer-merge paths, which do not validate status.',
  },
  {
    status: 'Failed',
    reachable:
      'REACHABLE BUT UNWITNESSED (UA-5). Zero Failed mission rows exist in this store or the ' +
      'fleet enumeration. It is reachable by the same unvalidated import/merge paths as Archived, ' +
      'and it was until s87-m01 a member of MISSION_TERMINAL_STATUSES — so the codebase itself ' +
      'asserted a mission could be Failed while VALID_STATE_TRANSITIONS had no key for it.',
  },
];

/** The seven driven actions: the six transition actions plus the update-status path. */
const DRIVEN_ACTIONS = [
  'start',
  'complete',
  'block',
  'unblock',
  'drop',
  'defer',
  'update',
] as const;
type DrivenAction = (typeof DRIVEN_ACTIONS)[number];

interface DriveResult {
  outcome: Outcome;
  code?: string;
  message?: string;
  suggestion?: string;
  thrown?: string;
}

/** Force `missions.status` on the copy. This is the "establish, never inherit" step. */
function setDriverStatus(dbPath: string, status: string): void {
  withDb(dbPath, (db) => {
    const info = db
      .prepare('UPDATE missions SET status = ? WHERE id = ?')
      .run(status, DRIVER_MISSION_ID);
    if (info.changes !== 1) {
      throw new Error(
        `precondition not established: UPDATE missions SET status='${status}' WHERE id='${DRIVER_MISSION_ID}' changed ${info.changes} rows`
      );
    }
  });
}

const CLOSE_ADJACENT_SPRINT_ID = 'sprint-10';

/** Establish, rather than inherit, the exact state in which a sprint-close nudge is truthful. */
function establishCloseAdjacentSprint(dbPath: string, missionInProgress: boolean): void {
  withDb(dbPath, (db) => {
    const sprint = db
      .prepare(`UPDATE sprints SET status = 'Active', end_date = NULL WHERE id = ?`)
      .run(CLOSE_ADJACENT_SPRINT_ID);
    if (sprint.changes !== 1) {
      throw new Error(`close-adjacent fixture sprint '${CLOSE_ADJACENT_SPRINT_ID}' was not found`);
    }
    const missions = db
      .prepare(
        `UPDATE missions SET status = 'Completed', completed_at = COALESCE(completed_at, ?) WHERE sprint_id = ?`
      )
      .run(new Date().toISOString(), CLOSE_ADJACENT_SPRINT_ID);
    if (missions.changes < 1) {
      throw new Error(
        `close-adjacent fixture sprint '${CLOSE_ADJACENT_SPRINT_ID}' has no missions`
      );
    }
    if (missionInProgress) {
      const driver = db
        .prepare(`UPDATE missions SET status = 'In Progress', completed_at = NULL WHERE id = ?`)
        .run(DRIVER_MISSION_ID);
      if (driver.changes !== 1) {
        throw new Error(`close-adjacent driver mission '${DRIVER_MISSION_ID}' was not found`);
      }
    }
  });
}

/** Add one active session using the live schema's required provenance columns. */
function seedCloseAdjacentSession(dbPath: string, sessionId: string): void {
  withDb(dbPath, (db) => {
    const projectId = (
      db.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as
        | { value: string }
        | undefined
    )?.value;
    if (!projectId) throw new Error('close-adjacent fixture has no metadata.project_id');
    db.prepare(
      `INSERT INTO sessions
         (id, type, title, sprint_id, started_at, agent, status, captures,
          project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
       VALUES (?, 'build', 's88-m03 successful-warning probe', ?, ?, 'jest', 'active', '[]',
               ?, ?, ?, ?, 'session_started', 1)`
    ).run(
      sessionId,
      CLOSE_ADJACENT_SPRINT_ID,
      new Date().toISOString(),
      projectId,
      '01S88M03WARNINGPROBE00000',
      Date.now(),
      8_803
    );
  });
}

/**
 * Drive one action through the REAL router. A handler-only call is what let this class survive:
 * the routers are where a client actually enters.
 */
async function drive(
  projectRoot: string,
  action: DrivenAction,
  /**
   * The status the prescription NAMES, or `null` when it names none.
   *
   * `null` and not `undefined`, deliberately: passing `undefined` to a parameter with a default
   * re-triggers that default in JavaScript, so an earlier draft of this file silently replayed
   * every no-status prescription as a status change and reported a Tier-2 failure that was an
   * artifact of its own argument handling. There is no default here now; every caller says which
   * request it is making.
   *
   * `null` means the remedy asked for `cmos_mission(action="update")` WITHOUT a status — a
   * different request, and replaying it as a status change would test a claim the string never
   * made. The corrected terminal-status refusal says exactly this: *"Other fields can still be
   * edited with cmos_mission(action=\"update\")"*. Driving a `notes` write is what that sentence
   * prescribes, and its SUCCEEDING is the direct proof that the old wording — *"is in terminal
   * state 'X' and cannot be changed"* — was false.
   */
  targetStatus: string | null
): Promise<DriveResult> {
  try {
    if (action === 'update') {
      const fields =
        targetStatus === null
          ? { notes: 'remedy-reachability matrix probe (non-status field)' }
          : { status: targetStatus };
      const r = await cmosMission({
        action: 'update',
        missionId: DRIVER_MISSION_ID,
        fields: fields as Parameters<typeof cmosMission>[0]['fields'],
        projectRoot,
      });
      return r.success
        ? { outcome: 'SUCCEEDS' }
        : {
            outcome: 'REFUSES',
            code: r.error?.code,
            message: r.error?.message,
            suggestion: r.error?.suggestion,
          };
    }
    const params: Record<string, unknown> = { action, missionId: DRIVER_MISSION_ID, projectRoot };
    if (action === 'block') {
      params.reason = 'remedy-reachability matrix probe';
      params.blockers = ['matrix probe'];
    }
    if (action === 'unblock') params.resolution = 'remedy-reachability matrix probe';
    if (action === 'drop') params.reason = 'remedy-reachability matrix probe';
    if (action === 'defer') {
      params.reason = 'remedy-reachability matrix probe';
      params.deferUntil = 'after the probe';
    }
    const r = await cmosMissionTransition(
      params as unknown as Parameters<typeof cmosMissionTransition>[0]
    );
    return r.success
      ? { outcome: 'SUCCEEDS' }
      : {
          outcome: 'REFUSES',
          code: r.error?.code,
          message: r.error?.message,
          suggestion: r.error?.suggestion,
        };
  } catch (err) {
    return { outcome: 'CRASHES', thrown: err instanceof Error ? err.message : String(err) };
  }
}

interface ExecutedRemedy extends PrescribedCall {
  mode: string;
  outcome?: Outcome;
}

/** Replay one extracted prescription through the real router from the state that emitted it. */
async function replayPrescription(
  projectRoot: string,
  dbPath: string,
  call: PrescribedCall,
  triggerStatus?: string
): Promise<ExecutedRemedy> {
  const mode = classifyAction(call.tool, call.action);
  if (mode === 'read') return { ...call, mode };

  if (call.tool === 'cmos_mission' || call.tool === 'cmos_mission_transition') {
    if (triggerStatus === undefined) return { ...call, mode: 'out-of-corpus' };
    const remedyAction = call.tool === 'cmos_mission' ? 'update' : (call.action as DrivenAction);
    if (!DRIVEN_ACTIONS.includes(remedyAction)) {
      return { ...call, mode: 'out-of-corpus' };
    }
    setDriverStatus(dbPath, triggerStatus);
    const result = await drive(projectRoot, remedyAction, call.status ?? null);
    return { ...call, mode, outcome: result.outcome };
  }

  if (call.tool === 'cmos_sprint' && call.action === 'complete') {
    try {
      const result = await cmosSprint({
        action: 'complete',
        sprintId: CLOSE_ADJACENT_SPRINT_ID,
        summary: 'remedy-reachability successful-warning replay',
        projectRoot,
      });
      return { ...call, mode, outcome: result.success ? 'SUCCEEDS' : 'REFUSES' };
    } catch {
      return { ...call, mode, outcome: 'CRASHES' };
    }
  }

  return { ...call, mode: 'out-of-corpus' };
}

/**
 * Tokens that DISCLOSE a remedy as conditional. Tier 2 is satisfied when a refusing remedy's
 * own suggestion carries one of these — i.e. the string does not read as an unconditional
 * instruction. Shape, not semantics (false-negative 6).
 */
const HEDGE_TOKENS = [' if ', 'only ', 'unless ', 'when ', 'once ', 'first', 'then ', 'cannot'];
function disclosesCondition(suggestion: string): boolean {
  const lower = ` ${suggestion.toLowerCase()} `;
  return HEDGE_TOKENS.some((t) => lower.includes(t));
}

interface MatrixCell {
  trigger: string;
  action: DrivenAction;
  outcome: Outcome;
  thrown?: string;
  message?: string;
  suggestion?: string;
  /** Remedies the refusal prescribed, each with the outcome of EXECUTING it from this state. */
  remedies: ExecutedRemedy[];
}

interface ObservedSuccessfulWarning {
  source: string;
  warnings: string[];
  prescriptions: PrescribedCall[];
  remedies: ExecutedRemedy[];
}

/** Every covered success producer must independently emit and execute its close remedy. */
function successWarningCoverageProblems(observed: ObservedSuccessfulWarning[]): string[] {
  const problems: string[] = [];
  for (const producer of observed) {
    const prescriptions = producer.prescriptions.filter(
      (call) => call.tool === 'cmos_sprint' && call.action === 'complete'
    );
    const remedies = producer.remedies.filter(
      (call) => call.tool === 'cmos_sprint' && call.action === 'complete'
    );
    if (prescriptions.length === 0) {
      problems.push(`${producer.source}: emitted no cmos_sprint(action="complete") prescription`);
    }
    if (remedies.length < prescriptions.length) {
      problems.push(
        `${producer.source}: executed ${remedies.length}/${prescriptions.length} close prescriptions`
      );
    }
    for (const remedy of remedies) {
      if (remedy.mode === 'out-of-corpus' || remedy.outcome !== 'SUCCEEDS') {
        problems.push(
          `${producer.source}: cmos_sprint(action="complete") mode=${remedy.mode} ` +
            `outcome=${String(remedy.outcome)}`
        );
      }
    }
  }
  return problems;
}

let matrix: MatrixCell[] = [];
let observedSuccessfulWarnings: ObservedSuccessfulWarning[] = [];
/** Measured, never gated on: what out-of-enum mission statuses the LIVE store actually holds. */
let liveOutOfEnum: Array<{ status: string; count: number }> = [];

const PUBLISHED_STATUSES = new Set([
  'Queued',
  'Current',
  'In Progress',
  'Blocked',
  'Completed',
  'Dropped',
  'Deferred',
]);

describe('s87-m01 ARM 1 — the mission-transition remedy matrix (real-store copy)', () => {
  beforeAll(async () => {
    const { projectRoot, dbPath } = copyFrozenStore('cmos-s87m01-matrix-');

    liveOutOfEnum = withDb(dbPath, (db) =>
      (
        db
          .prepare('SELECT status, COUNT(*) AS count FROM missions GROUP BY status')
          .all() as Array<{
          status: string;
          count: number;
        }>
      ).filter((r) => !PUBLISHED_STATUSES.has(r.status))
    );

    const cells: MatrixCell[] = [];
    for (const trigger of TRIGGER_STATES) {
      for (const action of DRIVEN_ACTIONS) {
        setDriverStatus(dbPath, trigger.status);
        const res = await drive(projectRoot, action, 'Queued');
        const cell: MatrixCell = {
          trigger: trigger.status,
          action,
          outcome: res.outcome,
          thrown: res.thrown,
          message: res.message,
          suggestion: res.suggestion,
          remedies: [],
        };

        // Execute what the refusal prescribed, from the state it was prescribed in.
        for (const call of extractPrescribedCalls(res.suggestion ?? '')) {
          cell.remedies.push(await replayPrescription(projectRoot, dbPath, call, trigger.status));
        }
        cells.push(cell);
      }
    }
    matrix = cells;

    // RED witness: two close-adjacent successful answers carry executable prescriptions, while
    // ARM 1 still has no path that executes them. Each producer gets a fresh store so its state
    // is established independently rather than inherited from the refusal matrix.
    const observed: ObservedSuccessfulWarning[] = [];

    {
      const missionCopy = copyFrozenStore('cmos-s88m03-mission-warning-');
      establishCloseAdjacentSprint(missionCopy.dbPath, true);
      const completed = await cmosMissionTransition({
        action: 'complete',
        missionId: DRIVER_MISSION_ID,
        notes: 's88-m03 successful-warning reachability probe',
        projectRoot: missionCopy.projectRoot,
      });
      if (!completed.success) {
        throw new Error(
          `mission close-adjacent producer refused: ${completed.error?.code} ${completed.error?.message}`
        );
      }
      const warnings = completed.warnings ?? [];
      const prescriptions = warnings.flatMap(extractPrescribedCalls);
      const remedies: ExecutedRemedy[] = [];
      for (const call of prescriptions) {
        remedies.push(await replayPrescription(missionCopy.projectRoot, missionCopy.dbPath, call));
      }
      observed.push({
        source: 'cmos_mission_transition(action="complete")',
        warnings,
        prescriptions,
        remedies,
      });
    }

    {
      const sessionCopy = copyFrozenStore('cmos-s88m03-session-warning-');
      establishCloseAdjacentSprint(sessionCopy.dbPath, false);
      const sessionId = 'PS-2099-01-01-883';
      seedCloseAdjacentSession(sessionCopy.dbPath, sessionId);
      const completed = await cmosSession({
        action: 'complete',
        sessionId,
        summary: 's88-m03 successful-warning reachability probe',
        projectRoot: sessionCopy.projectRoot,
      });
      if (!completed.success) {
        throw new Error(
          `session close-adjacent producer refused: ${completed.error?.code} ${completed.error?.message}`
        );
      }
      const warnings = completed.warnings ?? [];
      const prescriptions = warnings.flatMap(extractPrescribedCalls);
      const remedies: ExecutedRemedy[] = [];
      for (const call of prescriptions) {
        remedies.push(await replayPrescription(sessionCopy.projectRoot, sessionCopy.dbPath, call));
      }
      observed.push({
        source: 'cmos_session(action="complete")',
        warnings,
        prescriptions,
        remedies,
      });
    }

    observedSuccessfulWarnings = observed;
  }, 300_000);

  it('reports its cell count and its SUCCEEDS/REFUSES/CRASHES tally', () => {
    const tally = { SUCCEEDS: 0, REFUSES: 0, CRASHES: 0 };
    for (const c of matrix) tally[c.outcome] += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[s87-m01 matrix] cells=${matrix.length} ` +
        `SUCCEEDS=${tally.SUCCEEDS} REFUSES=${tally.REFUSES} CRASHES=${tally.CRASHES}\n` +
        `[s87-m01 matrix] live out-of-enum mission statuses: ${
          liveOutOfEnum.length === 0
            ? 'none'
            : liveOutOfEnum.map((r) => `${r.status}=${r.count}`).join(', ')
        }`
    );
    // A gate that silently shrinks its corpus passes by finding nothing — the failure mode
    // `agent-prompt-reachability.test.ts` was written against. 9 trigger states x 7 actions.
    expect(matrix.length).toBeGreaterThanOrEqual(63);
    expect(tally.SUCCEEDS + tally.REFUSES + tally.CRASHES).toBe(matrix.length);
  });

  it('TIER 1 (HARD) — no driven action crashes, from any trigger state', () => {
    const crashes = matrix
      .filter((c) => c.outcome === 'CRASHES')
      .map((c) => `${c.trigger} -> ${c.action}: ${c.thrown}`);
    expect(crashes).toEqual([]);
  });

  it('TIER 1 (HARD) — no PRESCRIBED REMEDY crashes when executed from the state it was prescribed in', () => {
    const crashes: string[] = [];
    for (const c of matrix) {
      for (const r of c.remedies) {
        if (r.outcome === 'CRASHES') {
          crashes.push(
            `${c.trigger} -> ${c.action} prescribed ${r.tool}(${r.action}) which CRASHED`
          );
        }
      }
    }
    expect(crashes).toEqual([]);
  });

  it('covers prescriptive warnings returned by successful close-adjacent answers', () => {
    expect(observedSuccessfulWarnings.map((c) => c.source).sort()).toEqual([
      'cmos_mission_transition(action="complete")',
      'cmos_session(action="complete")',
    ]);
    // Per-producer anti-vacuity: aggregate counts can be satisfied twice by one producer while
    // the other emits or executes nothing. Undefined outcomes and out-of-corpus records fail.
    expect(successWarningCoverageProblems(observedSuccessfulWarnings)).toEqual([]);
  });

  it('rejects aggregate success-warning coverage that leaves one producer unexecuted', () => {
    const planted: ObservedSuccessfulWarning[] = [
      {
        source: 'producer-a',
        warnings: [],
        prescriptions: [
          { tool: 'cmos_sprint', action: 'complete', status: undefined },
          { tool: 'cmos_sprint', action: 'complete', status: undefined },
        ],
        remedies: [
          {
            tool: 'cmos_sprint',
            action: 'complete',
            status: undefined,
            mode: 'write',
            outcome: 'SUCCEEDS',
          },
          {
            tool: 'cmos_sprint',
            action: 'complete',
            status: undefined,
            mode: 'write',
            outcome: 'SUCCEEDS',
          },
        ],
      },
      {
        source: 'producer-b',
        warnings: [],
        prescriptions: [],
        remedies: [],
      },
    ];

    expect(successWarningCoverageProblems(planted)).toEqual([
      'producer-b: emitted no cmos_sprint(action="complete") prescription',
    ]);
  });

  it('TIER 2 (DISCLOSED) — a remedy that refuses from the state it is prescribed in says so', () => {
    const undisclosed: string[] = [];
    for (const c of matrix) {
      for (const r of c.remedies) {
        if (r.outcome !== 'REFUSES') continue;
        if (disclosesCondition(c.suggestion ?? '')) continue;
        undisclosed.push(
          `${c.trigger} -> ${c.action} prescribes ${r.tool}(action="${r.action}"), which REFUSES ` +
            `from '${c.trigger}', and the suggestion states no condition: ${JSON.stringify(c.suggestion)}`
        );
      }
    }
    expect(undisclosed).toEqual([]);
  });

  it('an unrecognized stored status yields a NAMED refusal, not the generic invalid-transition error', () => {
    const outOfEnum = matrix.filter((c) => !PUBLISHED_STATUSES.has(c.trigger));
    // Non-vacuity: the two out-of-enum trigger states x 7 actions.
    expect(outOfEnum.length).toBeGreaterThanOrEqual(14);
    // The refusal must NAME the unrecognized status. It is named in the MESSAGE — the field that
    // says what happened — while the suggestion says what to do about it; checking only the
    // suggestion would have failed a correct refusal for looking in the wrong place.
    const unnamed = outOfEnum
      .filter((c) => c.outcome === 'REFUSES')
      .filter((c) => {
        const text = `${c.message ?? ''} ${c.suggestion ?? ''}`.toLowerCase();
        return !(text.includes('unrecognized status') && text.includes(c.trigger.toLowerCase()));
      })
      .map((c) => `${c.trigger} -> ${c.action}: ${JSON.stringify(c.message)}`);
    expect(unnamed).toEqual([]);
    // And none of them is answered with the generic transition error, which would be a claim
    // about a state machine that has no entry for this status.
    const generic = outOfEnum
      .filter((c) => c.outcome === 'REFUSES')
      .filter((c) => /cannot transition mission/i.test(c.message ?? ''))
      .map((c) => `${c.trigger} -> ${c.action}`);
    expect(generic).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// ARM 2 — read-only prescriptions pass BY RULE, never by list
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Every `cmos_X(action="Y")` this codebase authors into an agent-facing string. */
function sweepAuthoredPrescriptions(): Array<{ tool: string; action: string }> {
  const out: Array<{ tool: string; action: string }> = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    for (const lit of collectStringLiterals(file, content)) {
      for (const call of extractPrescribedCalls(lit.text)) {
        if (!TOOL_ACTIONS.has(call.tool) || call.action === undefined) continue;
        out.push({ tool: call.tool, action: call.action });
      }
    }
  }
  return out;
}

describe('s87-m01 ARM 2 — read-only prescriptions are exempt BY RULE, never by list', () => {
  /**
   * A remedy that only READS cannot be unreachable from a state — there is no state it fails to
   * run in. So the reachability requirement does not apply to it, and this arm's whole job is to
   * make that exemption DERIVED rather than enumerated. There is no list of 16 pairs anywhere in
   * this file: the partition is computed from `classifyAction`, the taxonomy the server itself
   * dispatches on. If a read action is ever reclassified as a write, this arm moves with it.
   */
  it('the read/write partition is computed from the shipped taxonomy, and it is non-vacuous', () => {
    const authored = sweepAuthoredPrescriptions();
    const reads = authored.filter((c) => classifyAction(c.tool, c.action) === 'read');
    const writes = authored.filter((c) => classifyAction(c.tool, c.action) !== 'read');
    const distinctReadPairs = new Set(reads.map((c) => `${c.tool}(${c.action})`));
    // eslint-disable-next-line no-console
    console.log(
      `[s87-m01 arm2] authored prescriptions: read=${reads.length} write=${writes.length} ` +
        `distinct read pairs=${distinctReadPairs.size}`
    );

    // Corpus floors, so a broken sweep cannot pass by finding nothing. Measured at HEAD f1433a0:
    // 42 read-classified prescriptions across 16 distinct pairs, 94 write-classified.
    expect(authored.length).toBeGreaterThanOrEqual(120);
    expect(reads.length).toBeGreaterThanOrEqual(40);
    expect(distinctReadPairs.size).toBeGreaterThanOrEqual(16);
    // The partition is total — every authored prescription lands on exactly one side.
    expect(reads.length + writes.length).toBe(authored.length);

    // THE RULE, asserted once. Not "these 16 are fine"; "read-classified is what exempts".
    const notActuallyRead = reads
      .filter((c) => classifyAction(c.tool, c.action) !== 'read')
      .map((c) => `${c.tool}(action="${c.action}")`);
    expect(notActuallyRead).toEqual([]);
  });

  it('the matrix never executed a read-classified prescription', () => {
    // The exemption has to be observable in what the gate DID, not only in what it says.
    const readsInMatrix = matrix.flatMap((c) => c.remedies.filter((r) => r.mode === 'read'));
    expect(readsInMatrix.every((r) => r.outcome === undefined)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// ARM 3 — s85-m01's existence check, extended from TOOLS/ACTIONS to PARAMETERS
// ───────────────────────────────────────────────────────────────────────────────────────────────

interface StringNode {
  text: string;
  line: number;
}

/** Every string-literal / template-literal chunk in a file. Comments are never literal nodes. */
function collectStringLiterals(file: string, content: string): StringNode[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const out: StringNode[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push({
        text: node.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Top-level argument keys of a `cmos_X(` call, read from the text following the call token.
 * DEPTH-0 ONLY: `fields={"status":"Queued"}` contributes `fields`, never `status` — the nested
 * object is the tool's payload, not its parameter list. Stops at the matching close paren or at
 * the end of the literal chunk (false-negative 7).
 */
function topLevelArgKeys(rest: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  let atArgStart = true;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === '(' || ch === '{' || ch === '[') {
      depth += 1;
      atArgStart = false;
    } else if (ch === ')' && depth === 0) {
      break;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      atArgStart = false;
    } else if (ch === ',' && depth === 0) {
      atArgStart = true;
    } else if (atArgStart && /[A-Za-z_"']/.test(ch)) {
      const m = rest.slice(i).match(/^["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]/);
      if (m) keys.push(m[1]);
      atArgStart = false;
    }
    i += 1;
  }
  return keys;
}

interface ParamViolation {
  rel: string;
  line: number;
  message: string;
}

function sweepPrescribedParameters(): { violations: ParamViolation[]; calls: number } {
  const violations: ParamViolation[] = [];
  let calls = 0;
  for (const file of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC_ROOT, file);
    for (const lit of collectStringLiterals(file, content)) {
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(lit.text)) !== null) {
        const tool = m[0].slice(0, m[0].indexOf('(')).trim();
        const params = TOOL_PARAMS.get(tool);
        // A tool that does not exist is s85-m01's finding, not this arm's. Not double-reported.
        if (!params) continue;
        calls += 1;
        const rest = lit.text.slice(m.index + m[0].length);
        for (const key of topLevelArgKeys(rest)) {
          if (!params.has(key)) {
            violations.push({
              rel,
              line: lit.line,
              message:
                `${rel}:${lit.line} teaches ${tool}(${key}: …) — "${key}" is not a parameter of ` +
                `${tool}. Declared: ${[...params].sort().join(', ')}`,
            });
          }
        }
      }
    }
  }
  return { violations, calls };
}

describe('s87-m01 ARM 3 — every parameter an agent-facing cmos_*() call names must exist', () => {
  it('never teaches an agent a parameter the tool does not declare', () => {
    const { violations, calls } = sweepPrescribedParameters();
    // eslint-disable-next-line no-console
    console.log(`[s87-m01 param arm] calls=${calls} problems=${violations.length}`);
    // A broken extractor must not pass by finding nothing. TWO floors, deliberately:
    //   - 40 is the contract's stated minimum corpus;
    //   - 120 is the REGRESSION floor near the measured 140, so the corpus cannot quietly halve
    //     while still clearing the contract. A floor three times below the measurement is a gate
    //     that can shrink in silence, which is this sprint's own defect class.
    expect(calls).toBeGreaterThanOrEqual(40);
    expect(calls).toBeGreaterThanOrEqual(120);
    expect(violations.map((v) => v.message)).toEqual([]);
  });

  it('the extractor still resolves real parameters (anti-vacuity on the reader itself)', () => {
    // If `topLevelArgKeys` silently returned [] the arm above would be green and prove nothing.
    expect(topLevelArgKeys('action="update", missionId="X", fields={"status":"Queued"})')).toEqual([
      'action',
      'missionId',
      'fields',
    ]);
    expect(topLevelArgKeys('action="list")')).toEqual(['action']);
  });
});

describe('s88-m03 — the suite routes writes only to copies it owns', () => {
  it('the content oracle survives a content-preserving external timestamp write', () => {
    const dir = mkTmp('cmos-s88m03-concurrent-writer-');
    const file = path.join(dir, 'shared.sqlite');
    fs.writeFileSync(file, 'same bytes');
    const digest = storeBundleDigest(file);
    const before = fs.statSync(file);
    fs.writeFileSync(file, fs.readFileSync(file));
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2_000));
    const after = fs.statSync(file);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
    expect(storeBundleDigest(file)).toBe(digest);
  });

  it('the frozen source is unchanged and every writable route is a further private copy', () => {
    expect(routedDbPaths.length).toBeGreaterThanOrEqual(3);
    expect(storeBundleDigest(privateSourceDb)).toBe(privateSourceDigest);
    expect(
      routedDbPaths.every(
        (dbPath) => path.resolve(dbPath) !== path.resolve(LIVE_DB) && dbPath !== privateSourceDb
      )
    ).toBe(true);
  });
});
