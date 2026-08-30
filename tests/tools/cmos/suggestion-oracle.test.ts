// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Arc F item 1 — a provenance-instrumented behavioural oracle over authored error
// ABOUTME: `suggestion:` strings: reach the trigger state, execute the remedy, assert it works.

/**
 * WHAT THIS GATE CLAIMS, AND — EXACTLY — WHAT IT DOES NOT.
 *
 * SCOPE SENTENCE. For every authored `suggestion:` site this matrix can drive, this gate asserts
 * REACHABILITY and EFFICACY: the driven call does not crash; if the fired suggestion prescribes an
 * executable `cmos_*` call, executing that call from the SAME established state does not crash and
 * does not return the same `error.code` the suggestion was attached to; and a remedy that refuses
 * from that state discloses its condition. It asserts NOTHING about whether the prose names the
 * right CAUSE.
 *
 * D-5's REFUSAL (#1024) STANDS AND IS REINFORCED, NOT OVERTURNED. D-5 refused a general
 * class-(b) semantic gate at any budget, on a figure ("75 of 176") whose predicate was never
 * recorded and is therefore not re-derivable. Under a STATED predicate re-run in this mission — a
 * suggestion carries no checkable identifier when it contains no `cmos_*(` call token, no bare
 * shipped tool name, no npm/npx/cmos-mcp command, no file path and no snake_case identifier — a
 * MAJORITY of the 181 authored suggestions carry NO checkable identifier at all (112 at the time
 * of writing; the census arm re-derives and PRINTS the figure every run rather than pinning it,
 * because the predicate, not the number, is the thing D-5 was missing). That is a larger prose
 * share than D-5 measured, so its conclusion is if anything stronger. This oracle checks
 * REACHABILITY and EFFICACY, never semantics.
 *
 * "EXAMINED" IS DEFINED OPERATIONALLY, VERBATIM (s89-m08 fold 1):
 *
 *     A site is EXAMINED iff `globalThis.__CMOS_SUGGESTION_SITE__` recorded its
 *     `<relpath>:<line>` at least once during the matrix run.
 *
 * STATED SEPARATELY, so the two are never conflated: T2 and T3 apply ONLY to the CALL-BEARING
 * subset — the driveable sites whose suggestion text carries an executable `cmos_*` prescription.
 * That subset has its own count and its own pass rate, printed as a SECOND number. An
 * execution-based reading of "examined" would cap the count at the call-bearing subset; the
 * provenance definition above is what makes the larger count computable at all.
 *
 * FALSE-NEGATIVE PROFILE — for every noun in the scope sentence, the complement, with numbers
 * re-derived in this mission rather than carried:
 *
 *  1. THE 2 FORWARDING SITES. 183 `suggestion:` PropertyAssignments exist; 2 are exact
 *     property-access forwarding (`suggestion: x.suggestion`) and make no new claim. 181 authored.
 *     Re-derived by this file's own census arm, never hard-coded.
 *  2. THE DECLARED COMPLEMENT — 103 of the 181 are outside this matrix's reach by construction:
 *     FAULT 78 needs a fault-injection instrument (read-only DB file, corrupt context JSON,
 *     dropped table); EXTERNAL 24 needs a dashboard double; UNTYPED 1 is
 *     `sprint-summary-read.ts:45`, which spreads `...error` and has ZERO callers. Those two
 *     instruments are the named successors and neither is built here.
 *  3. THE ANSWER-BODY CHANNEL IS DECLARED, NOT CLOSED. 87 `format*ForLLM` declarations in src/,
 *     of which 10 author 13 `cmos_*(` tokens into the BODY of a SUCCESSFUL answer (project-list 2,
 *     project-validate 2, session-start 2, context-history 1, context-search 1, db-backfill purge
 *     1, decisions-review 1, decisions-search 1, session-search 1, status 1). Those are not
 *     `suggestion:` PropertyAssignments, so closing them moves Arc F item 1's ratified count by
 *     ZERO. Sprint-90 candidate.
 *  4. s87-m01 hole 9's 9 envelope-`warnings[]` producers remain ARM-3-only in
 *     `remedy-reachability.test.ts`. Restated, not re-litigated.
 *  5. SITES THAT AUTHOR MORE THAN ONE STRING. A site counted EXAMINED may still have unexamined
 *     branches: `cmos-mission-unblock.ts:205` calls `unblockNotBlockedSuggestion()`, which authors
 *     SIX distinct strings. The ledger additionally prints DISTINCT OBSERVED VALUES so the gap
 *     between "site fired" and "every branch of that site fired" is visible rather than implied.
 *  6. SQL-FORCED TRIGGER STATES (UA-5). Several axes establish their state by SQL on a private
 *     store copy rather than by a supported call sequence. Every such value carries a
 *     reachability note saying how a supported sequence could produce it.
 *  7. IN-PROCESS ROUTERS, NOT `dist/` OVER STDIO. This gate drives the mirrored routers in
 *     process. The ARTIFACT-level assertion for the same class lives in `scripts/verify-dist.ts`.
 *
 * THE MIRROR IS NOT A BUILD. Provenance comes from an AST source transform into a gitignored
 * CommonJS mirror under `node_modules/.cache/` — ZERO `src/` edits — and it proves itself faithful
 * run. See `tests/helpers/suggestion-mirror.ts` for why a structured `remedy` field was rejected.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { CMOS_TOOL_DEFINITIONS } from '../../../src/tools/cmos';
import { CMOS_ACTION_PARAMS } from '../../../src/tools/cmos/action-params';
import { findWrongTypedStringParam } from '../../../src/tools/cmos/param-type-guard';
import { cmosMission } from '../../../src/tools/cmos/cmos-mission';
import { cmosMissionTransition } from '../../../src/tools/cmos/cmos-mission-transition';
import { cmosSprint } from '../../../src/tools/cmos/cmos-sprint';
import { cmosContext } from '../../../src/tools/cmos/cmos-context';
import { cmosSession } from '../../../src/tools/cmos/cmos-session';
import { cmosDecisions } from '../../../src/tools/cmos/cmos-decisions';
import { cmosDb } from '../../../src/tools/cmos/cmos-db';
import { cmosProject } from '../../../src/tools/cmos/cmos-project';
import { cmosLearnings } from '../../../src/tools/cmos/cmos-learnings';
import { cmosFeedback } from '../../../src/tools/cmos/cmos-feedback';
import { cmosAuth } from '../../../src/tools/cmos/cmos-auth';
import { cmosMessage } from '../../../src/tools/cmos/cmos-message';
import { cmosAgentOnboard } from '../../../src/tools/cmos/cmos-agent-onboard';
import { cmosStatus } from '../../../src/tools/cmos/cmos-status';
import { cmosReview } from '../../../src/tools/cmos/cmos-review';

import {
  buildSuggestionMirror,
  installSuggestionSink,
  MIRROR_ROOT,
  type SuggestionMirrorResult,
  type SuggestionSink,
} from '../../helpers/suggestion-mirror';
import { readMirrorExclusions, requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyCmosTestStore } from '../../helpers/seedCmosDb';

jest.setTimeout(900_000);

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/**
 * fold 3 — `scripts/mirror-to-public.sh`'s PRIVATE_PATHS is
 * `( cmos analysis artifacts tmp SESSIONS.jsonl agents.md CLAUDE.md ecosystem.config.js )`.
 * `tests/` is NOT in it: this file IS mirrored to the public repo, where `cmos/` does not exist.
 * The shared helper — never a guard of this file's own — decides between running and skipping.
 */
const PRIVATE = requiresPrivateEvidence({
  reason:
    'The suggestion axis matrix and the wrong-typed-parameter sweep both drive a suite-private copy of the live CMOS store; the census, extractor and mirror-integrity arms need only src/ and always run.',
  paths: { liveDb: 'cmos/db/cmos.sqlite' },
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE CENSUS — re-derived at build time (fold 4: state the RULE, never pin the number)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `authored === RATIFIED_AUTHORED_BASE + SITES_THIS_MISSION_ADDS`.
 *
 * The base is Arc F item 1's ratified denominator (decision #1080, re-derived by this mission).
 * s89-m08 adds ZERO authored sites: its one new source module, `src/tools/cmos/param-type-guard.ts`,
 * returns `CmosErrors.invalidParameter`, which owns the only suggestion string involved. If a
 * future mission adds one, it enumerates it here rather than moving the base.
 */
const RATIFIED_AUTHORED_BASE = 181;
const SITES_THIS_MISSION_ADDS: readonly string[] = [];

const VALIDATION_CODES = new Set([
  'INVALID_PARAMETER',
  'MISSING_PARAMETER',
  'INVALID_ACTION',
  'CONFIRMATION_REQUIRED',
]);
const FAULT_CODES = new Set([
  'DB_QUERY_FAILED',
  'DB_CONNECTION_FAILED',
  'DB_SCHEMA_MISMATCH',
  'DB_NOT_FOUND',
  'CONTEXT_PARSE_ERROR',
  'CONTEXT_CONDENSATION_FAILED',
  'TOOL_EXECUTION_ERROR',
  'CMOS_NOT_DETECTED',
  'PULL_BEFORE_PUSH_FAILED',
]);
const EXTERNAL_CODES = new Set([
  'SENDER_ATTRIBUTION_MISMATCH',
  'EXPECTED_SLUG_MISMATCH',
  'NOT_COLLAB_STORE',
  'PROJECT_ID_MISMATCH',
  'PROJECT_NOT_REGISTERED',
]);
const EXTERNAL_PREFIXES = ['DASHBOARD_', 'DEVICE_CODE_', 'CREDENTIAL_'];

/**
 * Sites whose object literal carries no sibling `code:` because the literal is a HELPER RETURN
 * VALUE rather than the error itself. The bucket is resolved from the SINGLE consumer that turns
 * that return value into an error — the code a caller actually sees on the wire.
 *
 * `cmos-context-update.ts:775/785/794/813` are the four returns of `applyNestedFieldUpdate`, whose
 * ONLY consumer (`cmos-context-update.ts:543-549`) stamps `CMOS_ERROR_CODES.INVALID_PARAMETER` and
 * forwards `updateResult.suggestion` verbatim. The census arm PROVES that single-consumer premise
 * rather than trusting this comment.
 *
 * `sprint-summary-read.ts:45` is deliberately absent: `withViewContext` spreads `...error`, so its
 * code is whatever it is handed, and it has ZERO callers. It stays UNTYPED, which is why UNTYPED
 * is 1 here and not 0.
 */
const CONSUMER_RESOLVED_CODES: Readonly<Record<string, string>> = {
  'src/tools/cmos/cmos-context-update.ts:775': 'INVALID_PARAMETER',
  'src/tools/cmos/cmos-context-update.ts:785': 'INVALID_PARAMETER',
  'src/tools/cmos/cmos-context-update.ts:794': 'INVALID_PARAMETER',
  'src/tools/cmos/cmos-context-update.ts:813': 'INVALID_PARAMETER',
};

type TriggerClass = 'VALIDATION' | 'STATE' | 'FAULT' | 'EXTERNAL' | 'UNTYPED';

/**
 * bucket = f(sibling `code:`). STATE is the residual arm — `*_NOT_FOUND`, `*_INVALID_STATE`,
 * `*_INVALID_TRANSITION`, `*_ALREADY_*`, `*_NOT_ACTIVE`, `*_NOT_READY`, `*_ID_EXISTS` and
 * non-literal `code` expressions all land there. FAULT's list is explicit and wins over the STATE
 * suffix rules, which is why `DB_NOT_FOUND` is FAULT while `SNAPSHOT_NOT_FOUND` is STATE: FAULT
 * carries `SNAPSHOT_*_FAILED`, not `SNAPSHOT_*`.
 */
function triggerClassOf(code: string | null): TriggerClass {
  if (code === null) return 'UNTYPED';
  if (VALIDATION_CODES.has(code)) return 'VALIDATION';
  if (FAULT_CODES.has(code) || /^SNAPSHOT_.*_FAILED$/.test(code)) return 'FAULT';
  if (EXTERNAL_CODES.has(code) || EXTERNAL_PREFIXES.some((p) => code.startsWith(p))) {
    return 'EXTERNAL';
  }
  return 'STATE';
}

interface CensusSite {
  site: string;
  file: string;
  line: number;
  code: string | null;
  triggerClass: TriggerClass;
  callBearing: boolean;
  text: string;
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE EXTRACTOR — s85-m01's regexes, WIDENED to the three observed authoring syntaxes (CLASS 2)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `CALL_RE` and `ACTION_RE` are byte-identical to `remedy-reachability.test.ts` so the two gates
 * cannot drift on how a remedy string is read (that file's ARM 1/2/3 are NOT rewritten onto the
 * mirror — moving them would silently subtract from the `collectCoverageFrom: ['src/**\/*.ts']`
 * floors). `WITH_ACTION_RE` and `BARE_ACTION_RE` are the widening this mission adds.
 */
const CALL_RE = /\bcmos_[a-z_]+\s*\(/g;
const ACTION_RE = /^\s*action\s*[:=]\s*["'`]([a-z_]+)["'`]/;
/** `cmos_sprint with action="show"` — a shipped tool named without a parenthesis. */
const WITH_ACTION_RE = /\b(cmos_[a-z_]+)\s+with\s+action\s*[:=]\s*\\?["'`]([a-z_]+)\\?["'`]/g;
/** `cmos_decisions list` — a shipped tool followed by a bare action token. */
const BARE_ACTION_RE = /\b(cmos_[a-z_]+)\s+(?:action\s*[:=]\s*\\?["'`]?)?([a-z_]+)\b/g;
/** `cmos_status`, `cmos_review` — action-less shipped tools named on their own. */
const TOOL_TOKEN_RE = /\b(cmos_[a-z_]+)\b/g;

const TOOL_NAMES: ReadonlySet<string> = new Set<string>(CMOS_TOOL_DEFINITIONS.map((t) => t.name));
const TOOL_ACTIONS: ReadonlyMap<string, ReadonlySet<string> | null> = new Map(
  CMOS_TOOL_DEFINITIONS.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, { enum?: unknown }> };
    const actionProp = schema?.properties?.action;
    const values = actionProp && Array.isArray(actionProp.enum) ? actionProp.enum : null;
    return [tool.name, values ? new Set(values.map(String)) : null] as const;
  })
);

interface PrescribedCall {
  tool: string;
  action: string | undefined;
  syntax: 'paren' | 'with-action' | 'bare-action' | 'action-less';
}

/** Every executable `cmos_*` prescription a suggestion string carries, in all three syntaxes. */
function extractPrescribedCalls(text: string): PrescribedCall[] {
  const out: PrescribedCall[] = [];
  const seen = new Set<string>();
  const push = (call: PrescribedCall): void => {
    if (!TOOL_NAMES.has(call.tool)) return;
    const key = `${call.tool}|${call.action ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(call);
  };

  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(text)) !== null) {
    const tool = m[0].slice(0, m[0].indexOf('(')).trim();
    const actionMatch = text.slice(m.index + m[0].length).match(ACTION_RE);
    push({ tool, action: actionMatch ? actionMatch[1] : undefined, syntax: 'paren' });
  }

  WITH_ACTION_RE.lastIndex = 0;
  while ((m = WITH_ACTION_RE.exec(text)) !== null) {
    push({ tool: m[1], action: m[2], syntax: 'with-action' });
  }

  BARE_ACTION_RE.lastIndex = 0;
  while ((m = BARE_ACTION_RE.exec(text)) !== null) {
    const actions = TOOL_ACTIONS.get(m[1]);
    if (actions && actions.has(m[2])) push({ tool: m[1], action: m[2], syntax: 'bare-action' });
  }

  TOOL_TOKEN_RE.lastIndex = 0;
  while ((m = TOOL_TOKEN_RE.exec(text)) !== null) {
    if (TOOL_ACTIONS.get(m[1]) === null)
      push({ tool: m[1], action: undefined, syntax: 'action-less' });
  }

  return out;
}

/** Shipped tool names a suggestion mentions at all — the T5 numerator. */
function namedShippedTools(text: string): string[] {
  const out = new Set<string>();
  TOOL_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_TOKEN_RE.exec(text)) !== null) {
    if (TOOL_NAMES.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

/**
 * Tokens that DISCLOSE a remedy as conditional (T4). Byte-identical to `remedy-reachability`'s
 * `HEDGE_TOKENS`/`disclosesCondition` per the plan — shape, not semantics.
 */
const HEDGE_TOKENS = [' if ', 'only ', 'unless ', 'when ', 'once ', 'first', 'then ', 'cannot'];
function disclosesCondition(suggestion: string): boolean {
  const lower = ` ${suggestion.toLowerCase()} `;
  return HEDGE_TOKENS.some((t) => lower.includes(t));
}

/**
 * A suggestion carries NO CHECKABLE IDENTIFIER when it names no `cmos_*(` call, no bare shipped
 * tool name, no npm/npx/cmos-mcp command, no file path and no snake_case identifier. This is the
 * stated predicate that re-adjudicates D-5 — the figure it produces is printed, never asserted
 * against a remembered one.
 */
function carriesCheckableIdentifier(text: string): boolean {
  if (/\bcmos_[a-z_]+/.test(text)) return true;
  if (/\b(npm|npx|cmos-mcp)\b/.test(text)) return true;
  if (/[\w-]+\/[\w./-]+/.test(text)) return true;
  if (/\b[a-z]+_[a-z_]+\b/.test(text)) return true;
  return false;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE HARNESS
// ───────────────────────────────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function copyStoreBundle(sourceDb: string, destinationDb: string): void {
  fs.mkdirSync(path.dirname(destinationDb), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${sourceDb}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${destinationDb}${suffix}`);
  }
}

let frozenSourceDb = '';
/** Freeze the live store ONCE. No handler ever receives the live path. */
function initializeFrozenSource(): void {
  if (frozenSourceDb) return;
  const root = mkTmp('cmos-s89m08-frozen-');
  frozenSourceDb = path.join(root, 'cmos', 'db', 'cmos.sqlite');
  copyStoreBundle(PRIVATE.paths.liveDb, frozenSourceDb);
}

let storeSeq = 0;
/** One writable copy of the frozen source per trigger case — "establish, never inherit" (#547). */
function freshStore(): { projectRoot: string; dbPath: string } {
  initializeFrozenSource();
  const projectRoot = mkTmp(`cmos-s89m08-case-${storeSeq++}-`);
  const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
  copyStoreBundle(frozenSourceDb, dbPath);
  reidentifyCmosTestStore(projectRoot);
  return { projectRoot, dbPath };
}

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

type Outcome = 'SUCCEEDS' | 'REFUSES' | 'CRASHES' | 'TIMEOUT';

interface DrivenCall {
  /** The case that established the state, for the failure message. */
  caseName: string;
  axis: string;
  tool: string;
  action: string | undefined;
  outcome: Outcome;
  code?: string;
  suggestion?: string;
  thrown?: string;
  /** Sites whose recorded values contain this call's suggestion string. */
  sites: string[];
}

/**
 * Bound EVERY router call. A plan-time probe with no timeout hung indefinitely inside a
 * `cmos_project` action after 430 of 642 calls and produced no output at all.
 */
const CALL_TIMEOUT_MS = 20_000;

type MirrorRouters = Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

let mirror!: SuggestionMirrorResult;
let sink!: SuggestionSink;
let mirrorRouters!: MirrorRouters;

function loadMirrorRouters(): MirrorRouters {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const load = (
    file: string,
    exportName: string
  ): ((p: Record<string, unknown>) => Promise<unknown>) =>
    require(`${mirror.root}/tools/cmos/${file}.js`)[exportName];
  return {
    cmos_mission: load('cmos-mission', 'cmosMission'),
    cmos_mission_transition: load('cmos-mission-transition', 'cmosMissionTransition'),
    cmos_sprint: load('cmos-sprint', 'cmosSprint'),
    cmos_context: load('cmos-context', 'cmosContext'),
    cmos_session: load('cmos-session', 'cmosSession'),
    cmos_decisions: load('cmos-decisions', 'cmosDecisions'),
    cmos_db: load('cmos-db', 'cmosDb'),
    cmos_project: load('cmos-project', 'cmosProject'),
    cmos_learnings: load('cmos-learnings', 'cmosLearnings'),
    cmos_feedback: load('cmos-feedback', 'cmosFeedback'),
    cmos_auth: load('cmos-auth', 'cmosAuth'),
    cmos_message: load('cmos-message', 'cmosMessage'),
    cmos_agent_onboard: load('cmos-agent-onboard', 'cmosAgentOnboard'),
    cmos_status: load('cmos-status', 'cmosStatus'),
    cmos_review: load('cmos-review', 'cmosReview'),
  };
}

/** Attribute an observed suggestion string back to the site(s) that authored it. */
function attribute(suggestion: string | undefined): string[] {
  if (!suggestion) return [];
  const out: string[] = [];
  for (const [site, values] of sink.values) if (values.has(suggestion)) out.push(site);
  return out;
}

async function driveMirrored(
  caseName: string,
  axis: string,
  tool: string,
  params: Record<string, unknown>
): Promise<DrivenCall> {
  const action = typeof params.action === 'string' ? params.action : undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = (await Promise.race([
      mirrorRouters[tool](params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('__S89M08_TIMEOUT__')), CALL_TIMEOUT_MS);
      }),
    ])) as { success?: boolean; error?: { code?: string; suggestion?: string } };
    if (result?.success === true) {
      return { caseName, axis, tool, action, outcome: 'SUCCEEDS', sites: [] };
    }
    const suggestion = result?.error?.suggestion;
    return {
      caseName,
      axis,
      tool,
      action,
      outcome: 'REFUSES',
      code: result?.error?.code,
      suggestion,
      sites: attribute(suggestion),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === '__S89M08_TIMEOUT__') {
      return { caseName, axis, tool, action, outcome: 'TIMEOUT', sites: [] };
    }
    return { caseName, axis, tool, action, outcome: 'CRASHES', thrown: message, sites: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE AXIS MATRIX — 8 state axes with small enumerations, not N bespoke fixtures
// ───────────────────────────────────────────────────────────────────────────────────────────────

interface CaseContext {
  projectRoot: string;
  dbPath: string;
  /** A mission id that exists in the frozen source, discovered rather than hard-coded. */
  missionId: string;
  sprintId: string;
  /** A sprint the matrix keeps CLOSED, so the closed-target move refusal stays reachable. */
  closedSprintId: string;
}

interface MatrixCase {
  axis: string;
  name: string;
  /** UA-5: how a SUPPORTED call sequence could produce this state. Required for SQL-forced states. */
  reachable: string;
  setup?: (ctx: CaseContext) => void;
  calls: (ctx: CaseContext) => Array<{ tool: string; params: Record<string, unknown> }>;
}

/** The seven driven mission actions: the six transitions plus the update-status path. */
const DRIVEN_TRANSITIONS = ['start', 'complete', 'block', 'unblock', 'drop', 'defer'] as const;

/**
 * AXIS 1 — mission status. Seven published values plus `Archived` (WITNESSED LIVE in this repo's
 * own store) and `Failed` (REACHABLE BUT UNWITNESSED, UA-5: the same unvalidated import/peer-merge
 * paths that produce Archived, and until s87-m01 a member of MISSION_TERMINAL_STATUSES).
 */
const MISSION_STATUSES: ReadonlyArray<{ status: string; reachable: string }> = [
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
      'WITNESSED LIVE — not a key of VALID_STATE_TRANSITIONS and not a member of ' +
      'VALID_MISSION_STATUSES; it arrives through import and peer-merge paths, which do not validate status.',
  },
  {
    status: 'Failed',
    reachable:
      'REACHABLE BUT UNWITNESSED (UA-5) — same unvalidated import/merge paths as Archived; it was ' +
      'until s87-m01 a member of MISSION_TERMINAL_STATUSES while VALID_STATE_TRANSITIONS had no key for it.',
  },
];

function setMissionStatus(dbPath: string, missionId: string, status: string): void {
  withDb(dbPath, (db) => {
    const info = db.prepare('UPDATE missions SET status = ? WHERE id = ?').run(status, missionId);
    if (info.changes !== 1) {
      throw new Error(
        `precondition not established: UPDATE missions SET status='${status}' WHERE id='${missionId}' changed ${info.changes} rows`
      );
    }
  });
}

/** Every (tool, action) probe point the published surface exposes. */
function publishedProbePoints(): Array<{ tool: string; action: string | undefined }> {
  const out: Array<{ tool: string; action: string | undefined }> = [];
  for (const tool of CMOS_TOOL_DEFINITIONS) {
    const actions = TOOL_ACTIONS.get(tool.name);
    if (actions === null || actions === undefined) out.push({ tool: tool.name, action: undefined });
    else for (const action of actions) out.push({ tool: tool.name, action });
  }
  return out;
}

const MATRIX: MatrixCase[] = [
  // ── AXIS 1 — mission status × the seven driven actions ────────────────────────────────────────
  ...MISSION_STATUSES.map(
    ({ status, reachable }): MatrixCase => ({
      axis: '1 mission-status',
      name: `mission status = ${status}`,
      reachable,
      setup: (ctx) => {
        setMissionStatus(ctx.dbPath, ctx.missionId, status);
        // The move target must be an OPEN sprint. Left closed, `cmos-mission-move.ts:178` (the
        // sprint-status refusal) fires first and MASKS :205 (unrecognized mission status) and
        // :215 (terminal mission) — measured, not assumed.
        withDb(ctx.dbPath, (db) =>
          db.prepare(`UPDATE sprints SET status = 'Active' WHERE id = ?`).run(ctx.sprintId)
        );
      },
      calls: (ctx) => [
        ...DRIVEN_TRANSITIONS.map((action) => ({
          tool: 'cmos_mission_transition',
          params: {
            action,
            missionId: ctx.missionId,
            projectRoot: ctx.projectRoot,
            reason: 's89-m08 axis-1 probe',
            blockers: ['axis-1 probe'],
            resolution: 's89-m08 axis-1 probe',
            deferUntil: 'after the probe',
          },
        })),
        {
          tool: 'cmos_mission',
          params: {
            action: 'update',
            missionId: ctx.missionId,
            fields: { notes: 's89-m08 axis-1 probe (non-status field)' },
            projectRoot: ctx.projectRoot,
          },
        },
        // mission-move: a terminal mission, and a mission whose status is unrecognized.
        {
          tool: 'cmos_mission',
          params: {
            action: 'move',
            missionId: ctx.missionId,
            toSprintId: ctx.sprintId,
            projectRoot: ctx.projectRoot,
            reason: 's89-m08 axis-1 probe',
          },
        },
      ],
    })
  ),

  // ── AXIS 2 — row presence / absence ───────────────────────────────────────────────────────────
  {
    axis: '2 row-absence',
    name: 'every id names a row that does not exist',
    reachable: 'ordinary: an agent pastes a stale or mistyped id from an older answer',
    calls: (ctx) => [
      {
        tool: 'cmos_mission',
        params: { action: 'show', missionId: 'S89M08-ABSENT', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_mission',
        params: {
          action: 'move',
          missionId: 'S89M08-ABSENT',
          toSprintId: ctx.sprintId,
          projectRoot: ctx.projectRoot,
        },
      },
      // Axis 1 deliberately OPENS the target sprint so :205/:215 stop being masked; this call
      // keeps the closed-target refusal (cmos-mission-move.ts:178) in the corpus.
      {
        tool: 'cmos_mission',
        params: {
          action: 'move',
          missionId: ctx.missionId,
          toSprintId: ctx.closedSprintId,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_mission_transition',
        params: { action: 'start', missionId: 'S89M08-ABSENT', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_sprint',
        params: { action: 'show', sprintId: 'sprint-89089', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_sprint',
        params: { action: 'retro', sprintId: 'sprint-89089', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_sprint',
        params: {
          action: 'carry_forward',
          sprintId: 'sprint-89089',
          targetAddress: 'cmos://derek/nowhere',
          send: false,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_sprint',
        params: {
          action: 'update',
          sprintId: 'sprint-89089',
          fields: { focus: 'x' },
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_session',
        params: {
          action: 'capture',
          sessionId: 'PS-ABSENT-000',
          category: 'decision',
          content: 'probe',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_session',
        params: {
          action: 'complete',
          sessionId: 'PS-ABSENT-000',
          summary: 'probe',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_decisions',
        params: {
          action: 'update',
          decisionId: 999_999,
          status: 'archived',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_decisions',
        params: {
          action: 'update',
          decisionId: 1,
          supersededBy: 999_999,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_learnings',
        params: {
          action: 'update',
          learningId: 999_999,
          status: 'archived',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_learnings',
        params: { action: 'reaffirm', learningId: 999_999, projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_feedback',
        params: { action: 'resolve', feedbackId: 999_999, projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_db',
        params: {
          action: 'restore',
          snapshotId: 'snapshot-absent',
          confirm: true,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_project',
        params: {
          action: 'unregister',
          projectRoot: path.join(os.tmpdir(), 's89m08-never-registered'),
        },
      },
      {
        tool: 'cmos_context',
        params: {
          action: 'constraints',
          constraintAction: 'archive',
          missionId: 'S89M08-ABSENT',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_message',
        params: { action: 'get', messageId: 'msg-absent-000', projectRoot: ctx.projectRoot },
      },
    ],
  },
  {
    axis: '2 row-presence',
    name: 'the id names a row that ALREADY exists',
    reachable: 'ordinary: an agent re-runs an add it already ran',
    calls: (ctx) => [
      {
        tool: 'cmos_mission',
        params: {
          action: 'add',
          missionId: ctx.missionId,
          name: 'dup',
          sprintId: ctx.sprintId,
          objective: 'dup',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_sprint',
        params: {
          action: 'add',
          sprintId: ctx.sprintId,
          title: 'dup',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },

  // ── AXIS 3 — session lifecycle ────────────────────────────────────────────────────────────────
  {
    axis: '3 session-lifecycle',
    name: 'no session is active',
    reachable: 'ordinary: the previous session was completed, or none was ever started',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) =>
        db.prepare(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`).run()
      );
    },
    calls: (ctx) => [
      {
        tool: 'cmos_session',
        params: {
          action: 'capture',
          category: 'decision',
          content: 's89-m08 axis-3 probe',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_session',
        params: {
          action: 'complete',
          summary: 's89-m08 axis-3 probe',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '3 session-lifecycle',
    name: 'a session is already active',
    reachable: 'ordinary: cmos_session(action="start") was called and not completed',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) => {
        const row = db.prepare(`SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as
          | { id: string }
          | undefined;
        if (!row) throw new Error('frozen source has no sessions row to activate');
        db.prepare(`UPDATE sessions SET status = 'active' WHERE id = ?`).run(row.id);
      });
    },
    calls: (ctx) => [
      {
        tool: 'cmos_session',
        params: {
          action: 'start',
          title: 's89-m08 axis-3 probe',
          type: 'custom',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '3 session-lifecycle',
    name: 'the named session exists but is already completed',
    reachable: 'ordinary: an agent passes the id of a session it already closed',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) => {
        const row = db.prepare(`SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as
          | { id: string }
          | undefined;
        if (!row) throw new Error('frozen source has no sessions row');
        db.prepare(`UPDATE sessions SET status = 'completed' WHERE id = ?`).run(row.id);
      });
    },
    calls: (ctx) => {
      const id = withDb(
        ctx.dbPath,
        (db) =>
          (
            db.prepare(`SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as {
              id: string;
            }
          ).id
      );
      return [
        {
          tool: 'cmos_session',
          params: {
            action: 'complete',
            sessionId: id,
            summary: 'probe',
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'cmos_session',
          params: {
            action: 'capture',
            sessionId: id,
            category: 'decision',
            content: 'probe',
            projectRoot: ctx.projectRoot,
          },
        },
      ];
    },
  },

  // ── AXIS 4 — sprint lifecycle ─────────────────────────────────────────────────────────────────
  {
    axis: '4 sprint-lifecycle',
    name: 'the sprint is already Completed',
    reachable: 'ordinary: cmos_sprint(action="complete") already ran for that sprint',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) =>
        db.prepare(`UPDATE sprints SET status = 'Completed' WHERE id = ?`).run(ctx.sprintId)
      );
    },
    calls: (ctx) => [
      {
        tool: 'cmos_sprint',
        params: {
          action: 'complete',
          sprintId: ctx.sprintId,
          summary: 's89-m08 axis-4 probe',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },
  {
    axis: '4 sprint-lifecycle',
    name: 'the sprint is Active and still holds open missions',
    reachable: 'ordinary: closeout attempted before the queue is drained',
    setup: (ctx) => {
      withDb(ctx.dbPath, (db) => {
        db.prepare(`UPDATE sprints SET status = 'Active' WHERE id = ?`).run(ctx.sprintId);
        const info = db
          .prepare(`UPDATE missions SET status = 'In Progress', completed_at = NULL WHERE id = ?`)
          .run(ctx.missionId);
        if (info.changes !== 1) throw new Error('axis-4 driver mission was not found');
        db.prepare(`UPDATE missions SET sprint_id = ? WHERE id = ?`).run(
          ctx.sprintId,
          ctx.missionId
        );
      });
    },
    calls: (ctx) => [
      {
        tool: 'cmos_sprint',
        params: {
          action: 'complete',
          sprintId: ctx.sprintId,
          summary: 's89-m08 axis-4 probe',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },

  // ── AXIS 5 — required-parameter omission, one (tool, action) at a time ────────────────────────
  {
    axis: '5 parameter-omission',
    name: 'every published (tool, action) called with nothing but its action',
    reachable: 'ordinary: an agent calls a tool before reading which parameters the action needs',
    calls: (ctx) =>
      publishedProbePoints().map(({ tool, action }) => ({
        tool,
        params:
          action === undefined
            ? { projectRoot: ctx.projectRoot }
            : { action, projectRoot: ctx.projectRoot },
      })),
  },
  {
    axis: '5 parameter-omission',
    name: 'an action token that is not in the published enum',
    reachable: 'ordinary: an agent invents an action name, or uses one from an older version',
    calls: (ctx) => [
      { tool: 'cmos_mission', params: { action: 'frobnicate', projectRoot: ctx.projectRoot } },
      {
        tool: 'cmos_context',
        params: {
          action: 'next_steps',
          nextStepAction: 'frobnicate',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_context',
        params: {
          action: 'constraints',
          constraintAction: 'frobnicate',
          projectRoot: ctx.projectRoot,
        },
      },
    ],
  },

  // ── AXIS 6 — parameter VALUE violations ───────────────────────────────────────────────────────
  {
    axis: '6 parameter-value',
    name: 'bad enum, empty string, out-of-range and malformed dot-notation paths',
    reachable: 'ordinary: an agent guesses a value shape instead of reading the schema',
    calls: (ctx) => [
      // The four `applyNestedFieldUpdate` returns. `contextType` MUST be master_context or
      // project_context: `runManualUpdate` types it as that union, and `project_identity` is
      // handled by a DIFFERENT module (cmos-context-project-identity.ts), so a project_identity
      // update never reaches these four sites at all. Measured, not assumed.
      {
        tool: 'cmos_context',
        params: {
          action: 'update',
          contextType: 'master_context',
          fieldUpdates: [{ path: '   ', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_context',
        params: {
          action: 'update',
          contextType: 'master_context',
          fieldUpdates: [{ path: 'a..b', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_context',
        params: {
          action: 'update',
          contextType: 'master_context',
          fieldUpdates: [{ path: '__proto__.polluted', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      // A path whose PARENT segment resolves to a non-object. Both updates are applied in order
      // against the same content, so the first establishes the string the second walks into.
      {
        tool: 'cmos_context',
        params: {
          action: 'update',
          contextType: 'master_context',
          fieldUpdates: [
            { path: 's89m08_probe', value: 'a string, not an object' },
            { path: 's89m08_probe.child', value: 'x' },
          ],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_context',
        params: { action: 'update', contextType: 'master_context', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_context',
        params: {
          action: 'view',
          contextType: 'master_context',
          sizeOnly: true,
          compact: true,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_context',
        params: { action: 'search', query: '', projectRoot: ctx.projectRoot },
      },
      // `project_identity` is NOT an action of cmos_context (the enum is view/update/condense/
      // snapshot/history/next_steps/constraints); it is a contextType on `update`.
      {
        tool: 'cmos_context',
        params: { action: 'update', contextType: 'project_identity', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_context',
        params: {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: 'not_a_known_field', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      // A DOTTED path that is not `type_fields.*` — the shape cmos-context-project-identity.ts:105
      // exists to refuse. An unknown TOP-LEVEL name is accepted, so it does not reach that site.
      {
        tool: 'cmos_context',
        params: {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: 'not_type_fields.child', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      // An EMPTY segment is what applyProjectIdentityFieldUpdate actually refuses (project-identity.ts:403);
      // an unknown top-level name and an unknown dotted prefix are both accepted, measured.
      {
        tool: 'cmos_context',
        params: {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: 'a..b', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_context',
        params: {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: '', value: 'x' }],
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_context',
        params: {
          action: 'constraints',
          constraintAction: 'archive',
          constraintIds: [999_999],
          projectRoot: ctx.projectRoot,
        },
      },
      // `cmos-constraints.ts:387` is inside reaffirmConstraint (line 370), NOT archiveConstraints.
      {
        tool: 'cmos_context',
        params: {
          action: 'constraints',
          constraintAction: 'reaffirm',
          constraintId: 999_999,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_decisions',
        params: {
          action: 'batch_update',
          decisionIds: Array.from({ length: 200 }, (_, i) => i + 1),
          status: 'archived',
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_decisions',
        params: { action: 'search', query: '', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_learnings',
        params: { action: 'search', query: '', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_learnings',
        params: { action: 'list', acrossProjects: true, projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_session',
        params: {
          action: 'capture',
          category: 'decision',
          content: 'probe',
          evergreen: true,
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_db',
        params: { action: 'restore', snapshotId: 'snapshot-absent', projectRoot: ctx.projectRoot },
      },
      {
        tool: 'cmos_db',
        params: {
          action: 'restore',
          snapshotId: '../etc/passwd',
          confirm: true,
          projectRoot: ctx.projectRoot,
        },
      },
      { tool: 'cmos_db', params: { action: 'purge', projectRoot: ctx.projectRoot } },
      {
        tool: 'cmos_project',
        params: { action: 'init', projectRoot: path.join(os.tmpdir(), 's89m08-does-not-exist') },
      },
      {
        tool: 'cmos_project',
        params: { action: 'init', projectRoot: path.join(REPO_ROOT, 'package.json') },
      },
      {
        tool: 'cmos_mission',
        params: {
          action: 'update',
          missionId: ctx.missionId,
          fields: {},
          projectRoot: ctx.projectRoot,
        },
      },
      {
        tool: 'cmos_sprint',
        params: {
          action: 'update',
          sprintId: ctx.sprintId,
          fields: {},
          projectRoot: ctx.projectRoot,
        },
      },
      { tool: 'cmos_auth', params: { action: 'revoke', projectRoot: undefined } },
      { tool: 'cmos_auth', params: { action: 'reissue' } },
    ],
  },

  // ── AXIS 7 — dependency-edge presence ─────────────────────────────────────────────────────────
  {
    axis: '7 dependency-edge',
    name: 'self-edge, absent edge, and an edge that already exists',
    reachable: 'ordinary: an agent wires the same dependency twice, or points a mission at itself',
    calls: (ctx) => {
      const other = withDb(ctx.dbPath, (db) => {
        const row = db
          .prepare(`SELECT id FROM missions WHERE id != ? LIMIT 1`)
          .get(ctx.missionId) as { id: string } | undefined;
        if (!row) throw new Error('frozen source has fewer than two missions');
        return row.id;
      });
      return [
        {
          tool: 'cmos_mission',
          params: {
            action: 'depends',
            fromId: ctx.missionId,
            toId: ctx.missionId,
            type: 'Requires',
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'cmos_mission',
          params: {
            action: 'undepends',
            fromId: ctx.missionId,
            toId: other,
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'cmos_mission',
          params: {
            action: 'depends',
            fromId: ctx.missionId,
            toId: other,
            type: 'Requires',
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'cmos_mission',
          params: {
            action: 'depends',
            fromId: ctx.missionId,
            toId: other,
            type: 'Requires',
            projectRoot: ctx.projectRoot,
          },
        },
      ];
    },
  },

  // ── AXIS 8 — contexts-row absence ─────────────────────────────────────────────────────────────
  ...(['master_context', 'project_context', 'project_identity'] as const).map(
    (contextId): MatrixCase => ({
      axis: '8 contexts-row-absence',
      name: `contexts row '${contextId}' is absent`,
      reachable:
        'UA-5 — forced by SQL. A supported sequence reaches it through a store created before that ' +
        'row existed, or a restore from a snapshot taken before it was added; cmos_project(init) ' +
        'writes all three today, so a fresh store cannot reach this state.',
      setup: (ctx) => {
        withDb(ctx.dbPath, (db) => {
          db.prepare(`DELETE FROM contexts WHERE id = ?`).run(contextId);
          const still = db.prepare(`SELECT 1 FROM contexts WHERE id = ?`).get(contextId);
          if (still) throw new Error(`contexts row '${contextId}' survived deletion`);
          // The sprint must be CLOSABLE, or `cmos-sprint-complete.ts:548` (SPRINT_NOT_READY) fires
          // first and masks :568/:579, the two contexts-row refusals this axis exists to reach.
          db.prepare(`UPDATE sprints SET status = 'Active' WHERE id = ?`).run(ctx.sprintId);
          db.prepare(
            `UPDATE missions SET status = 'Completed', completed_at = COALESCE(completed_at, datetime('now')) WHERE sprint_id = ?`
          ).run(ctx.sprintId);
        });
      },
      calls: (ctx) => [
        {
          tool: 'cmos_context',
          params: { action: 'view', contextType: contextId, projectRoot: ctx.projectRoot },
        },
        {
          tool: 'cmos_context',
          params: { action: 'condense', contextType: contextId, projectRoot: ctx.projectRoot },
        },
        {
          tool: 'cmos_context',
          params: { action: 'update', contextType: contextId, projectRoot: ctx.projectRoot },
        },
        {
          tool: 'cmos_context',
          params: {
            action: 'update',
            contextType: contextId,
            fieldUpdates: [{ path: 'description', value: 'probe' }],
            projectRoot: ctx.projectRoot,
          },
        },
        {
          tool: 'cmos_sprint',
          params: {
            action: 'complete',
            sprintId: ctx.sprintId,
            summary: 's89-m08 axis-8 probe',
            projectRoot: ctx.projectRoot,
          },
        },
      ],
    })
  ),
];

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE CENSUS ARM — portable; runs in the public mirror too
// ───────────────────────────────────────────────────────────────────────────────────────────────

function runCensus(): CensusSite[] {
  const rows: CensusSite[] = [];
  for (const absolute of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(absolute, 'utf8');
    if (!content.includes('suggestion')) continue;
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    const source = ts.createSourceFile(absolute, content, ts.ScriptTarget.ES2020, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
        node.name.text === 'suggestion'
      ) {
        const init = node.initializer;
        const forwarding = ts.isPropertyAccessExpression(init) && init.name.text === 'suggestion';
        if (!forwarding) {
          const line = source.getLineAndCharacterOfPosition(init.getStart(source)).line + 1;
          const site = `${relative}:${line}`;
          let code: string | null = null;
          if (ts.isObjectLiteralExpression(node.parent)) {
            for (const prop of node.parent.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
                prop.name.text === 'code'
              ) {
                const value = prop.initializer;
                if (ts.isStringLiteralLike(value)) code = value.text;
                else {
                  const m = value.getText(source).match(/CMOS_ERROR_CODES\.([A-Z_]+)/);
                  code = m ? m[1] : '<expr>';
                }
              }
            }
          }
          if (code === null) code = CONSUMER_RESOLVED_CODES[site] ?? null;
          const text = init.getText(source);
          rows.push({
            site,
            file: relative,
            line,
            code,
            triggerClass: triggerClassOf(code),
            callBearing: extractPrescribedCalls(text).length > 0,
            text,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return rows;
}

/** Every `suggestion:` PropertyAssignment, including the forwarding ones — the 183 denominator. */
function countAllSuggestionSites(): { sites: number; forwarding: number; files: number } {
  let sites = 0;
  let forwarding = 0;
  const files = new Set<string>();
  for (const absolute of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(absolute, 'utf8');
    if (!content.includes('suggestion')) continue;
    const source = ts.createSourceFile(absolute, content, ts.ScriptTarget.ES2020, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
        node.name.text === 'suggestion'
      ) {
        sites += 1;
        files.add(absolute);
        if (
          ts.isPropertyAccessExpression(node.initializer) &&
          node.initializer.name.text === 'suggestion'
        ) {
          forwarding += 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { sites, forwarding, files: files.size };
}

const CENSUS = runCensus();
const DRIVEABLE = CENSUS.filter(
  (r) => r.triggerClass === 'VALIDATION' || r.triggerClass === 'STATE'
);
const DRIVEABLE_SITES = new Set(DRIVEABLE.map((r) => r.site));
const CALL_BEARING_DRIVEABLE = DRIVEABLE.filter((r) => r.callBearing);

describe('s89-m08 CENSUS — the universe re-derives at build time, never from a remembered number', () => {
  it('re-derives 183 sites / 2 forwarding / authored === the ratified base plus what this mission adds', () => {
    const { sites, forwarding, files } = countAllSuggestionSites();
    const authored = sites - forwarding;
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 census] sites=${sites} forwarding=${forwarding} authored=${authored} files=${files} ` +
        `callBearing=${CENSUS.filter((r) => r.callBearing).length}`
    );
    expect(CENSUS).toHaveLength(authored);
    // fold 4 — the RULE, not the number. A mission that adds an authored site enumerates it.
    expect(authored).toBe(RATIFIED_AUTHORED_BASE + SITES_THIS_MISSION_ADDS.length);
  });

  it('publishes the trigger-class partition, total and disjoint', () => {
    const counts: Record<TriggerClass, number> = {
      VALIDATION: 0,
      STATE: 0,
      FAULT: 0,
      EXTERNAL: 0,
      UNTYPED: 0,
    };
    for (const row of CENSUS) counts[row.triggerClass] += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 partition] VALIDATION=${counts.VALIDATION} STATE=${counts.STATE} FAULT=${counts.FAULT} ` +
        `EXTERNAL=${counts.EXTERNAL} UNTYPED=${counts.UNTYPED} | driveable=${DRIVEABLE.length} ` +
        `complement=${CENSUS.length - DRIVEABLE.length} callBearingDriveable=${CALL_BEARING_DRIVEABLE.length}`
    );
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(CENSUS.length);
    expect(counts.VALIDATION + counts.STATE).toBe(DRIVEABLE.length);
  });

  it('PROVES the single-consumer premise the consumer-resolved bucket rests on', () => {
    // The four `cmos-context-update.ts` sites are bucketed by the code their ONE consumer stamps.
    // If a second consumer ever appears, that premise silently becomes false — so assert it.
    const content = fs.readFileSync(
      path.join(SRC_ROOT, 'tools', 'cmos', 'cmos-context-update.ts'),
      'utf8'
    );
    const callSites = content
      .split('\n')
      .filter((l) => /\bapplyNestedFieldUpdate\s*\(/.test(l) && !/^\s*function\b/.test(l));
    expect(callSites).toHaveLength(1);
    // ...and that single consumer is the one that stamps INVALID_PARAMETER.
    const consumerIndex = content.split('\n').findIndex((l) => l === callSites[0]);
    const window = content
      .split('\n')
      .slice(consumerIndex, consumerIndex + 10)
      .join('\n');
    expect(window).toContain('CMOS_ERROR_CODES.INVALID_PARAMETER');
    expect(window).toContain('updateResult.suggestion');
    for (const site of Object.keys(CONSUMER_RESOLVED_CODES)) {
      expect(CENSUS.some((r) => r.site === site)).toBe(true);
    }
  });

  it('re-adjudicates D-5 by measuring the prose share under a STATED predicate', () => {
    const noIdentifier = CENSUS.filter((r) => !carriesCheckableIdentifier(r.text));
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 D-5] authored=${CENSUS.length} carrying NO checkable identifier=${noIdentifier.length} ` +
        `(D-5 #1024 measured 75 of 176 under a predicate that was never recorded)`
    );
    // The claim is that a general SEMANTIC gate stays refused, so this must remain a large share.
    // Asserted as a floor on the REFUSAL's justification, not as a target to shrink.
    expect(noIdentifier.length).toBeGreaterThan(CENSUS.length / 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// T5 — EXTRACTOR COMPLETENESS (portable)
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('s89-m08 T5 — every authored suggestion naming a shipped tool yields an extractable prescription', () => {
  it('reports ZERO by RULE, so a ninth authoring syntax cannot appear silently', () => {
    const offenders = CENSUS.filter(
      (row) =>
        namedShippedTools(row.text).length > 0 && extractPrescribedCalls(row.text).length === 0
    );
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 T5] authored naming a shipped tool=${CENSUS.filter((r) => namedShippedTools(r.text).length > 0).length} ` +
        `unextractable=${offenders.length} (RED entering the mission: 8)`
    );
    for (const offender of offenders) {
      // eslint-disable-next-line no-console
      console.log(
        `  UNEXTRACTABLE ${offender.site} :: ${offender.text.replace(/\s+/g, ' ').slice(0, 160)}`
      );
    }
    // The RULE — tool-name membership minus extractable prescriptions === 0. An allowlist of the
    // eight known sites would satisfy a count but not this, which is the point.
    expect(offenders.map((o) => o.site)).toEqual([]);
  });

  it('ANTI-VACUITY — the WIDENING is what closed it, and the narrow extractor still reports the RED 8', () => {
    // s85-m01's shipped `CALL_RE` requires a parenthesis. Under it alone, the eight CLASS-2 sites
    // name a shipped tool in a form no gate has ever executed. Reproducing that RED here is what
    // proves the green above is the widening's doing and not a weakened predicate.
    const narrowOffenders = CENSUS.filter((row) => {
      if (namedShippedTools(row.text).length === 0) return false;
      CALL_RE.lastIndex = 0;
      return !CALL_RE.test(row.text);
    }).map((row) => row.site);
    // eslint-disable-next-line no-console
    console.log(`[s89-m08 T5 anti-vacuity] narrow-extractor RED = ${narrowOffenders.length}`);
    for (const site of narrowOffenders) {
      // eslint-disable-next-line no-console
      console.log(`  narrow-RED ${site}`);
    }
    expect(narrowOffenders.length).toBe(8);
  });

  it('every widened syntax is actually EXERCISED, so no branch is dead weight', () => {
    const bySyntax = new Map<string, string[]>();
    for (const row of CENSUS) {
      for (const call of extractPrescribedCalls(row.text)) {
        bySyntax.set(call.syntax, [...(bySyntax.get(call.syntax) ?? []), row.site]);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 T5 syntaxes] ${[...bySyntax].map(([k, v]) => `${k}=${v.length}`).join(' ')}`
    );
    for (const syntax of ['paren', 'with-action', 'bare-action'] as const) {
      expect(bySyntax.get(syntax)?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// T6 — THE WRONG-TYPED PUBLISHED STRING PARAMETER CLASS SWEEP (portable)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The class: "a published tool parameter declared `type: string` in its shipped inputSchema, sent
 * as a non-string JSON value an MCP client can legally put on the wire, reaches an unguarded string
 * method and throws." Swept DYNAMICALLY over the whole published surface — the static form is not
 * decidable (186 `.trim()` call sites in src/ with no reliable receiver-to-schema mapping).
 *
 * RED entering the mission: 714 triples / 42 CRASH (decision #1117). The ratified figure was 25;
 * the 17 the ratified predicate missed are all the `projectRoot` field, which throws from
 * `path.resolve` rather than `.trim`.
 */
const SRC_ROUTERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  cmos_mission: cmosMission as never,
  cmos_mission_transition: cmosMissionTransition as never,
  cmos_sprint: cmosSprint as never,
  cmos_context: cmosContext as never,
  cmos_session: cmosSession as never,
  cmos_decisions: cmosDecisions as never,
  cmos_db: cmosDb as never,
  cmos_project: cmosProject as never,
  cmos_learnings: cmosLearnings as never,
  cmos_feedback: cmosFeedback as never,
  cmos_auth: cmosAuth as never,
  cmos_message: cmosMessage as never,
  cmos_agent_onboard: cmosAgentOnboard as never,
  cmos_status: cmosStatus as never,
  cmos_review: cmosReview as never,
};

const WRONG_VALUES: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: 'number', value: 12_345 },
  { label: 'object', value: { nope: true } },
  { label: 'array', value: ['nope'] },
  { label: 'boolean', value: true },
];

interface Triple {
  tool: string;
  action: string | undefined;
  field: string;
}

function enumerateStringTriples(): Triple[] {
  const triples: Triple[] = [];
  for (const tool of CMOS_TOOL_DEFINITIONS) {
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: unknown; enum?: unknown }>;
    };
    const properties = schema.properties ?? {};
    const actionProp = properties.action;
    const actions: (string | undefined)[] =
      actionProp && Array.isArray(actionProp.enum) ? actionProp.enum.map(String) : [undefined];
    const fields = Object.entries(properties)
      .filter(([name, p]) => name !== 'action' && p && p.type === 'string')
      .map(([name]) => name);
    for (const action of actions)
      for (const field of fields) triples.push({ tool: tool.name, action, field });
  }
  return triples;
}

/**
 * The per-action applicability contract (s86-m04). Published as the per-action tables in
 * TOOL_REFERENCE.md, consumed by the reference renderer, and checked in BOTH directions by
 * `tests/tools/cmos/action-params.test.ts` — every entry must be something the router demonstrably
 * does with that key, and every published key must be claimed by some action. That bidirectional
 * gate is why scoping the boundary guard to it does not reintroduce the drift a hand-written
 * (tool, action) -> parameter list would.
 */
const ACTION_PARAMS = CMOS_ACTION_PARAMS as unknown as Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>;

/** The parameters THIS action applies to, or undefined for an action-less tool (guard them all). */
function applicableParamsFor(triple: Triple): readonly string[] | undefined {
  const perAction = ACTION_PARAMS[triple.tool];
  if (!perAction || triple.action === undefined) return undefined;
  return perAction[triple.action];
}

function appliesToAction(triple: Triple): boolean {
  const applicable = applicableParamsFor(triple);
  return applicable === undefined || applicable.includes(triple.field);
}

/**
 * The 42 triples the PRE-GUARD sweep recorded as CRASHING (decision #1117, measured at HEAD
 * f5507a8 over 714 triples x 5 wrong JSON types). Pinned as recorded evidence so the guard's
 * action scope can never narrow past the RED it was built to close — if a future edit drops one of
 * these out of scope, the scope arm goes red rather than the crash silently returning.
 */
const HISTORICALLY_CRASHING: readonly string[] = [
  'cmos_agent_onboard||agentFeedback',
  'cmos_auth|list|projectRoot',
  'cmos_auth|revoke|projectRoot',
  'cmos_auth|rotate|projectRoot',
  'cmos_context|search|query',
  'cmos_context|snapshot|source',
  'cmos_db|backfill|projectRoot',
  'cmos_db|clone|projectRoot',
  'cmos_db|identify_orphans|projectRoot',
  'cmos_db|pull|projectRoot',
  'cmos_db|reconcile|projectRoot',
  'cmos_decisions|search|query',
  'cmos_learnings|search|query',
  'cmos_message|ack|projectRoot',
  'cmos_message|directory|projectRoot',
  'cmos_message|get|projectRoot',
  'cmos_message|list|projectRoot',
  'cmos_message|respond|projectRoot',
  'cmos_message|send|projectRoot',
  'cmos_message|whoami|projectRoot',
  'cmos_mission_transition|block|missionId',
  'cmos_mission_transition|complete|missionId',
  'cmos_mission_transition|defer|missionId',
  'cmos_mission_transition|drop|missionId',
  'cmos_mission_transition|start|missionId',
  'cmos_mission_transition|unblock|missionId',
  'cmos_mission|add|missionId',
  'cmos_mission|depends|fromId',
  'cmos_mission|move|missionId',
  'cmos_mission|show|missionId',
  'cmos_mission|undepends|fromId',
  'cmos_mission|update|missionId',
  'cmos_project|register|projectRoot',
  'cmos_project|unregister|projectRoot',
  'cmos_session|capture|content',
  'cmos_session|complete|summary',
  'cmos_session|search|query',
  'cmos_session|start|title',
  'cmos_sprint|add|sprintId',
  'cmos_sprint|complete|sprintId',
  'cmos_sprint|show|sprintId',
  'cmos_sprint|update|sprintId',
];

PRIVATE.describe(
  's89-m08 T6 — the wrong-typed published string parameter class, swept whole-surface',
  () => {
    const triples = enumerateStringTriples();
    const crashes: string[] = [];
    /** An APPLICABLE wrong-typed parameter that the guard failed to refuse by name. */
    const unguardedApplicable: string[] = [];
    /** Calls left deliberately untouched because the action does not use that parameter. */
    let untouched = 0;
    let calls = 0;

    beforeAll(async () => {
      const { projectRoot } = freshStore();
      for (const triple of triples) {
        for (const { label, value } of WRONG_VALUES) {
          const params: Record<string, unknown> = {};
          if (triple.action !== undefined) params.action = triple.action;
          if (triple.field !== 'projectRoot') params.projectRoot = projectRoot;
          params[triple.field] = value;
          calls += 1;
          let timer: NodeJS.Timeout | undefined;
          try {
            const result = (await Promise.race([
              SRC_ROUTERS[triple.tool](params),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('__TIMEOUT__')), CALL_TIMEOUT_MS);
              }),
            ])) as { success?: boolean; error?: { code?: string; field?: string } };
            if (appliesToAction(triple)) {
              // The action READS this parameter. A malformed value must be named, not absorbed:
              // a silently-ignored filter returns an UNFILTERED answer the caller reads as filtered.
              if (
                result?.error?.code !== 'INVALID_PARAMETER' ||
                result.error.field !== triple.field
              ) {
                unguardedApplicable.push(
                  `${triple.tool}(${triple.action ?? '—'}).${triple.field}=${label} -> ${
                    result?.success === true ? 'SUCCESS' : (result?.error?.code ?? 'no code')
                  }`
                );
              }
            } else {
              untouched += 1;
            }
          } catch (error) {
            crashes.push(
              `${triple.tool}(${triple.action ?? '—'}).${triple.field}=${label} threw: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
    });

    it('prints its triple count and asserts a non-vacuity floor', () => {
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 T6] triples=${triples.length} calls=${calls} crashes=${crashes.length} ` +
          `applicable-triples=${triples.filter(appliesToAction).length} ` +
          `calls-left-untouched=${untouched} (parameters the action does not use)`
      );
      expect(triples.length).toBeGreaterThanOrEqual(700);
      expect(calls).toBe(triples.length * WRONG_VALUES.length);
    });

    it('T1/T6 (HARD) — no wrong-typed published string parameter crashes any router', () => {
      expect(crashes).toEqual([]);
    });

    it('every APPLICABLE wrong-typed value is refused as INVALID_PARAMETER naming the field', () => {
      expect(unguardedApplicable).toEqual([]);
    });

    it('the guard is SCOPED to the action, and that scope still covers every crashing triple', () => {
      // s89-m09. The first cut refused a wrong-typed value on every declared string property of
      // the tool, whether or not the action read it — measured, that converted 210 of 714 triples
      // from SUCCESS to INVALID_PARAMETER, and 179 of those were parameters the action ignores
      // (`cmos_message(action="whoami", body=12345)` is the representative case). Scoping to
      // CMOS_*_ACTION_PARAMS drops the success-to-error blast radius to 31 triples and misses ZERO
      // crashes, because a parameter that crashes the handler is by construction one it reads.
      //
      // This arm asserts the SCOPE is real in both directions, so neither a silent widening nor a
      // silent narrowing can pass: the applicable set must be a strict subset of all triples, and
      // it must contain every triple the pre-guard sweep recorded as crashing.
      const applicable = triples.filter(appliesToAction);
      expect(applicable.length).toBeGreaterThan(0);
      expect(applicable.length).toBeLessThan(triples.length);
      const applicableKeys = new Set(
        applicable.map((t) => `${t.tool}|${t.action ?? ''}|${t.field}`)
      );
      const uncovered = HISTORICALLY_CRASHING.filter((key) => !applicableKeys.has(key));
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 T6 scope] applicable=${applicable.length}/${triples.length} ` +
          `historically-crashing=${HISTORICALLY_CRASHING.length} uncovered-by-scope=${uncovered.length}`
      );
      expect(uncovered).toEqual([]);
    });

    it('PINS the null decision — the guard treats JSON null as ABSENT, for every published string field', () => {
      // The fold-5 measurement (decision #1117): `null` CRASHES at 0 of the 714 triples while it
      // SUCCEEDS at 238 and REFUSES at 476. It is not a member of the defect class, and refusing it
      // would convert 238 working calls into errors while breaking every client whose serializer
      // emits null for an absent optional. This pins the choice so a later "tighten the guard" edit
      // has to argue with a measurement.
      //
      // Asserted against the GUARD ITSELF rather than against a driven answer, deliberately: 24 of
      // the 714 triples already returned INVALID_PARAMETER for null BEFORE this guard existed (a
      // handler-level refusal, identical set before and after), so a behavioural probe cannot tell
      // the guard's refusal from theirs and would report 24 false positives.
      const refused: string[] = [];
      for (const triple of triples) {
        const schema = CMOS_TOOL_DEFINITIONS.find((t) => t.name === triple.tool)!.inputSchema;
        const params: Record<string, unknown> = { [triple.field]: null };
        if (triple.action !== undefined) params.action = triple.action;
        if (findWrongTypedStringParam(schema, applicableParamsFor(triple), params) !== null) {
          refused.push(`${triple.tool}(${triple.action ?? '—'}).${triple.field}`);
        }
      }
      // ...and the same field with a non-null wrong type IS refused, so the arm is not vacuous.
      const missed = triples.filter((triple) => {
        const schema = CMOS_TOOL_DEFINITIONS.find((t) => t.name === triple.tool)!.inputSchema;
        if (!appliesToAction(triple)) return false; // out of scope by design, not a miss
        return (
          findWrongTypedStringParam(schema, applicableParamsFor(triple), {
            [triple.field]: 12_345,
          }) === null
        );
      });
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 T6 null] triples=${triples.length} refused-when-null=${refused.length} ` +
          `not-refused-when-number=${missed.length}`
      );
      expect(refused).toEqual([]);
      expect(missed).toEqual([]);
    });

    it('the guard is ONE shared module, not per-handler typeof checks', () => {
      // learning #364 — fixing a class as N instances is how the instance list regrows.
      const wirings = walkTsFiles(path.join(SRC_ROOT, 'tools', 'cmos')).filter((f) =>
        fs.readFileSync(f, 'utf8').includes('findWrongTypedStringParam(')
      );
      // 15 routers + the module that defines it.
      expect(wirings).toHaveLength(16);
      // The guard module must author NO new `suggestion:` literal (fold 4).
      const guardSource = fs.readFileSync(
        path.join(SRC_ROOT, 'tools', 'cmos', 'param-type-guard.ts'),
        'utf8'
      );
      const guardCensus = ts.createSourceFile('g.ts', guardSource, ts.ScriptTarget.ES2020, true);
      let guardSuggestionSites = 0;
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'suggestion'
        ) {
          guardSuggestionSites += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(guardCensus);
      expect(guardSuggestionSites).toBe(0);
    });

    it('no per-handler `typeof params.X === "string"` guard exists — the class is fixed ONCE', () => {
      // Criterion 2's grep, stated as a RULE rather than as a count: every string-typeof guard on a
      // params field in src/tools/cmos must be the ACTION normalisation. Fixing this class as N
      // per-handler instance checks is sprint-88's central failure, and with 186 `.trim()` call
      // sites in src/ the instance list would regrow (learning #364).
      const PARAM_TYPEOF =
        /typeof\s+(?:\(\s*params[^)]*\)|params)\s*\.([A-Za-z_]+)\s*===\s*'string'/g;
      const offenders: string[] = [];
      let actionGuards = 0;
      for (const file of walkTsFiles(path.join(SRC_ROOT, 'tools', 'cmos'))) {
        const content = fs.readFileSync(file, 'utf8');
        PARAM_TYPEOF.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = PARAM_TYPEOF.exec(content)) !== null) {
          if (match[1] === 'action') actionGuards += 1;
          else offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[1]}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 T6 one-guard] action-normalisation guards=${actionGuards} other-param typeof guards=${offenders.length}`
      );
      // Non-vacuity: the regex must actually be finding the action idiom it is written for.
      expect(actionGuards).toBeGreaterThanOrEqual(11);
      expect(offenders).toEqual([]);
    });
  }
);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE MATRIX ARMS — T1 / T2 / T3 / T4 / T7
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Params for a PRESCRIBED call, synthesized from the same axis vocabulary the matrix drives with.
 * A prescription names a tool and an action; it does not name arguments, so the harness supplies
 * the minimum a caller in that state would.
 */
function synthesizePrescriptionParams(
  tool: string,
  action: string | undefined,
  ctx: CaseContext
): Record<string, unknown> {
  const params: Record<string, unknown> = { projectRoot: ctx.projectRoot };
  if (action !== undefined) params.action = action;
  switch (tool) {
    case 'cmos_mission':
      if (action === 'show' || action === 'update') params.missionId = ctx.missionId;
      if (action === 'update') params.fields = { notes: 's89-m08 remedy replay' };
      if (action === 'add') {
        params.missionId = 'S89M08-REPLAY';
        params.name = 's89-m08 remedy replay';
        params.sprintId = ctx.sprintId;
        params.objective = 's89-m08 remedy replay';
      }
      if (action === 'move') {
        params.missionId = ctx.missionId;
        params.toSprintId = ctx.sprintId;
      }
      if (action === 'depends' || action === 'undepends') {
        params.fromId = ctx.missionId;
        params.toId = ctx.missionId;
        params.type = 'Requires';
      }
      break;
    case 'cmos_mission_transition':
      params.missionId = ctx.missionId;
      params.reason = 's89-m08 remedy replay';
      params.blockers = ['s89-m08 remedy replay'];
      params.resolution = 's89-m08 remedy replay';
      params.deferUntil = 'after the replay';
      break;
    case 'cmos_sprint':
      if (action !== 'list' && action !== 'analytics') params.sprintId = ctx.sprintId;
      if (action === 'update') params.fields = { focus: 's89-m08 remedy replay' };
      if (action === 'complete') params.summary = 's89-m08 remedy replay';
      if (action === 'add') {
        params.sprintId = 'sprint-89089';
        params.title = 's89-m08 remedy replay';
      }
      if (action === 'carry_forward') {
        params.targetAddress = 'cmos://derek/nowhere';
        params.send = false;
      }
      break;
    case 'cmos_context':
      if (action === 'view' || action === 'condense' || action === 'history') {
        params.contextType = 'master_context';
      }
      if (action === 'search') params.query = 's89-m08';
      if (action === 'constraints') params.constraintAction = 'list';
      if (action === 'next_steps') params.nextStepAction = 'list';
      break;
    case 'cmos_session':
      if (action === 'start') {
        params.title = 's89-m08 remedy replay';
        params.type = 'custom';
      }
      if (action === 'capture') {
        params.category = 'decision';
        params.content = 's89-m08 remedy replay';
      }
      if (action === 'complete') params.summary = 's89-m08 remedy replay';
      if (action === 'search') params.query = 's89-m08';
      break;
    case 'cmos_decisions':
      if (action === 'search') params.query = 's89-m08';
      if (action === 'update') {
        params.decisionId = 1;
        params.status = 'archived';
      }
      if (action === 'batch_update') {
        params.decisionIds = [1];
        params.status = 'archived';
      }
      break;
    case 'cmos_learnings':
      if (action === 'search') params.query = 's89-m08';
      if (action === 'list') params.category = 'technical';
      if (action === 'update') {
        params.learningId = 1;
        params.status = 'archived';
      }
      if (action === 'reaffirm') params.learningId = 1;
      break;
    case 'cmos_db':
      if (action === 'snapshot') params.listOnly = true;
      if (action === 'purge') params.confirm = true;
      break;
    case 'cmos_feedback':
      if (action === 'resolve') params.feedbackId = 1;
      break;
    default:
      break;
  }
  return params;
}

interface Replay {
  site: string;
  caseName: string;
  axis: string;
  triggerCode: string | undefined;
  suggestion: string;
  tool: string;
  action: string | undefined;
  outcome: Outcome;
  code?: string;
  thrown?: string;
}

/**
 * RESIDUALS — every driveable site this matrix does NOT reach, each with a STATED reason.
 *
 * This map is the anti-vacuity device. `E + R === driveable` is trivially true if R is defined as
 * `driveable - E`; it is a real gate only because every member of R must ALSO appear here with a
 * reason, and a site that stops firing therefore fails the run until someone writes down why.
 * The shape is `migration-warning-reachability.test.ts`'s.
 */
const RESIDUAL_REASONS: Readonly<Record<string, string>> = {
  // ── FAULT-SHAPED PRECONDITIONS inside a VALIDATION/STATE-coded site ──────────────────────────
  // These carry a driveable CODE but their trigger is a database fault, so the successor
  // fault-injection instrument (read-only DB file, dropped table, corrupt content) reaches them —
  // not an axis matrix that drives supported calls against a healthy store.
  'src/tools/cmos/client.ts:671':
    'UNIQUE-constraint mapping inside CmosDatabaseClient. Reaching it needs a write that violates a ' +
    'UNIQUE index THROUGH a supported call; every duplicate this matrix can create is refused earlier ' +
    'by a handler check (MISSION_ID_EXISTS, SPRINT_ID_EXISTS). Needs the fault-injection instrument.',
  'src/tools/cmos/client.ts:682':
    'FOREIGN-KEY-constraint mapping inside CmosDatabaseClient. Same shape as :671 — no supported call ' +
    'sequence against a healthy store reaches an FK violation. Needs the fault-injection instrument.',
  'src/tools/cmos/cmos-context-project-identity.ts:57':
    'MEASURED: unreachable by deleting the row. `ensureProjectIdentityRow(client)` runs first and ' +
    'RECREATES it, so the null-identity branch needs the row to be both uncreatable and unreadable — ' +
    'a database fault, not a state this matrix can establish.',
  'src/tools/cmos/cmos-context-project-identity.ts:116':
    'Same fault-shaped precondition as :57, one frame later: `getProjectIdentity` returning null ' +
    'AFTER a write that already succeeded.',

  // ── EXTERNAL-SHAPED PRECONDITIONS inside a VALIDATION/STATE-coded site ───────────────────────
  // Driveable by CODE, but the trigger needs a dashboard double or a seeded credential store —
  // the second named successor instrument, and out of this mission by declaration.
  'src/tools/cmos/cmos-auth.ts:1144':
    'Needs MORE THAN ONE user-scoped key in the local credential store. Seeding that store is the ' +
    'credential-double instrument, not an axis over a CMOS database.',
  'src/tools/cmos/cmos-message.ts:737':
    'Needs a sender context that resolves to no local store while the call still reaches the handler; ' +
    'the dispatcher resolves or refuses first on every supported path this matrix drives.',
  'src/tools/cmos/cmos-message.ts:1007':
    'A defensive branch whose own message says the dispatcher should have caught the condition via ' +
    'resolveSenderContext. Reaching it means reaching a state the dispatcher forbids.',
  'src/tools/cmos/cmos-message.ts:1338':
    'MESSAGE_NOT_FOUND on a fetched message — needs a dashboard double to serve the fetch window ' +
    'this refusal describes.',
  'src/tools/cmos/sync-bootstrap.ts:128':
    'MEASURED: masked. This is the missing-slug refusal, but clearing metadata.dashboard_slug and ' +
    'calling cmos_db(action="clone") refuses at DASHBOARD_NOT_CONFIGURED first — the dashboard ' +
    'client is resolved BEFORE the slug is read. Reaching it needs a configured dashboard AND no ' +
    'slug, so it belongs to the dashboard-double instrument.',
  'src/tools/cmos/sync-mutable-push.ts:111':
    'The missing-entityId refusal inside pushMutableStatus. Its only caller chain runs through ' +
    'maybePropagateMutableStatus, which early-returns unless isCollabStore(db) — so a solo store ' +
    'never enters the function at all, and a collab store needs a broker.',
  'src/tools/cmos/sync-mutable-push.ts:155':
    'Same collab-store gate as :111, one branch later on slug resolution.',
  'src/tools/cmos/sync-pull.ts:187':
    'MEASURED: masked, exactly as sync-bootstrap.ts:128 — cmos_db(action="pull") on a slug-less ' +
    'store refuses at DASHBOARD_NOT_CONFIGURED before the slug check is reached.',

  // ── MASKED BY AN EARLIER REFUSAL ON EVERY PATH THIS MATRIX CAN DRIVE ─────────────────────────
  'src/tools/cmos/cmos-sprint-complete.ts:568':
    'MEASURED: masked. With master_context deleted and the sprint made closable, closeout refuses at ' +
    'the shared errors.ts contextNotFound BEFORE reaching this sprint-local branch, so :568 is ' +
    'unreachable while that earlier guard stands.',
  'src/tools/cmos/cmos-sprint-complete.ts:579': 'Same masking as :568, for project_context.',
};

PRIVATE.describe(
  's89-m08 THE AXIS MATRIX — reach the trigger state, then execute the remedy',
  () => {
    const driven: DrivenCall[] = [];
    const replays: Replay[] = [];
    let examinedDriveable: string[] = [];
    let residualDriveable: string[] = [];
    let driverMissionId = '';
    let driverSprintId = '';
    let closedSprintId = '';

    beforeAll(async () => {
      mirror = buildSuggestionMirror();
      sink = installSuggestionSink();
      mirrorRouters = loadMirrorRouters();

      initializeFrozenSource();
      // Discover the driver rows rather than hard-coding ids that a store edit could invalidate.
      ({ driverMissionId, driverSprintId, closedSprintId } = withDb(frozenSourceDb, (db) => {
        const mission = db.prepare(`SELECT id FROM missions ORDER BY id LIMIT 1`).get() as
          | { id: string }
          | undefined;
        const sprints = db.prepare(`SELECT id FROM sprints ORDER BY id LIMIT 2`).all() as Array<{
          id: string;
        }>;
        if (!mission || sprints.length < 2) {
          throw new Error('frozen source lacks a mission or two sprints to drive');
        }
        return {
          driverMissionId: mission.id,
          driverSprintId: sprints[0].id,
          closedSprintId: sprints[1].id,
        };
      }));

      for (const matrixCase of MATRIX) {
        const { projectRoot, dbPath } = freshStore();
        const ctx: CaseContext = {
          projectRoot,
          dbPath,
          missionId: driverMissionId,
          sprintId: driverSprintId,
          closedSprintId,
        };
        matrixCase.setup?.(ctx);
        // "Establish, never inherit" applies PER CALL, not per case. A driven call that SUCCEEDS
        // mutates the very state the next call is supposed to meet — measured: driving
        // start/complete/block/unblock/drop/defer in sequence from `Deferred` left `defer` looking at
        // whatever the earlier transitions had produced, so `cmos-mission-defer.ts:121` never fired.
        const calls = matrixCase.calls(ctx);
        for (const call of calls) {
          matrixCase.setup?.(ctx);
          driven.push(
            await driveMirrored(matrixCase.name, matrixCase.axis, call.tool, call.params)
          );
        }
      }

      // ── THE REPLAY PASS (T2/T3/T4) ──────────────────────────────────────────────────────────────
      // Each replay re-establishes the case on its OWN fresh store, so the remedy is executed from
      // the state that emitted the refusal rather than from whatever later calls left behind.
      const wanted = new Map<
        string,
        { call: DrivenCall; site: string; prescription: PrescribedCall }
      >();
      for (const call of driven) {
        if (call.outcome !== 'REFUSES' || !call.suggestion) continue;
        for (const site of call.sites) {
          if (!DRIVEABLE_SITES.has(site)) continue;
          for (const prescription of extractPrescribedCalls(call.suggestion)) {
            const key = `${call.caseName}|${site}|${prescription.tool}|${prescription.action ?? ''}`;
            if (!wanted.has(key)) wanted.set(key, { call, site, prescription });
          }
        }
      }

      for (const { call, site, prescription } of wanted.values()) {
        const matrixCase = MATRIX.find((c) => c.name === call.caseName);
        if (!matrixCase) continue;
        const { projectRoot, dbPath } = freshStore();
        const ctx: CaseContext = {
          projectRoot,
          dbPath,
          missionId: driverMissionId,
          sprintId: driverSprintId,
          closedSprintId,
        };
        matrixCase.setup?.(ctx);
        const executed = await driveMirrored(
          call.caseName,
          call.axis,
          prescription.tool,
          synthesizePrescriptionParams(prescription.tool, prescription.action, ctx)
        );
        replays.push({
          site,
          caseName: call.caseName,
          axis: call.axis,
          triggerCode: call.code,
          suggestion: call.suggestion ?? '',
          tool: prescription.tool,
          action: prescription.action,
          outcome: executed.outcome,
          code: executed.code,
          thrown: executed.thrown,
        });
      }

      // EXAMINED, per the operational definition in this file's docblock.
      const fired = new Set(sink.fired);
      examinedDriveable = [...DRIVEABLE_SITES].filter((site) => fired.has(site)).sort();
      residualDriveable = [...DRIVEABLE_SITES].filter((site) => !fired.has(site)).sort();
    });

    it('T1 (HARD) — no driven call CRASHES, from any established trigger state', () => {
      const crashes = driven.filter((c) => c.outcome === 'CRASHES');
      for (const crash of crashes) {
        // eslint-disable-next-line no-console
        console.log(
          `  CRASH ${crash.axis} :: ${crash.caseName} :: ${crash.tool}(${crash.action ?? '—'}) :: ${crash.thrown}`
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 matrix] cases=${MATRIX.length} calls=${driven.length} ` +
          `SUCCEEDS=${driven.filter((c) => c.outcome === 'SUCCEEDS').length} ` +
          `REFUSES=${driven.filter((c) => c.outcome === 'REFUSES').length} ` +
          `CRASHES=${crashes.length} TIMEOUTS=${driven.filter((c) => c.outcome === 'TIMEOUT').length}`
      );
      expect(crashes.map((c) => `${c.caseName}:${c.tool}(${c.action ?? '—'})`)).toEqual([]);
    });

    it('T1 (HARD) — no driven call TIMES OUT', () => {
      expect(driven.filter((c) => c.outcome === 'TIMEOUT').map((c) => c.caseName)).toEqual([]);
    });

    it('T2 (HARD) — an executable prescription does not CRASH when run from the state that emitted it', () => {
      const crashed = replays.filter((r) => r.outcome === 'CRASHES' || r.outcome === 'TIMEOUT');
      for (const replay of crashed) {
        // eslint-disable-next-line no-console
        console.log(
          `  REMEDY ${replay.outcome} ${replay.site} -> ${replay.tool}(${replay.action ?? '—'}) :: ${replay.thrown}`
        );
      }
      expect(crashed.map((r) => `${r.site} -> ${r.tool}(${r.action ?? '—'})`)).toEqual([]);
    });

    it('T3 (HARD) — an executed remedy does not return the SAME error code it was attached to', () => {
      // A remedy that reproduces the refusal it was offered for is not a remedy. This is the
      // mechanical form of "it changes the state the error complained about", with no semantics.
      const reproduced = replays.filter(
        (r) => r.outcome === 'REFUSES' && r.code !== undefined && r.code === r.triggerCode
      );
      for (const replay of reproduced) {
        // eslint-disable-next-line no-console
        console.log(
          `  REMEDY REPRODUCES ${replay.code} :: ${replay.site} :: "${replay.suggestion.slice(0, 90)}" ` +
            `-> ${replay.tool}(${replay.action ?? '—'})`
        );
      }
      expect(
        reproduced.map((r) => `${r.site} -> ${r.tool}(${r.action ?? '—'}) [${r.code}]`)
      ).toEqual([]);
    });

    it('T4 (DISCLOSED) — a remedy that REFUSES from that state says it is conditional', () => {
      const undisclosed = replays.filter(
        (r) => r.outcome === 'REFUSES' && !disclosesCondition(r.suggestion)
      );
      for (const replay of undisclosed) {
        // eslint-disable-next-line no-console
        console.log(
          `  UNDISCLOSED ${replay.site} :: "${replay.suggestion.slice(0, 110)}" -> ` +
            `${replay.tool}(${replay.action ?? '—'}) refused ${replay.code}`
        );
      }
      expect(undisclosed.map((r) => r.site)).toEqual([]);
    });

    it('publishes the CALL-BEARING subset as its OWN, SECOND number — never conflated with EXAMINED', () => {
      const callBearingExamined = examinedDriveable.filter((site) =>
        CALL_BEARING_DRIVEABLE.some((row) => row.site === site)
      );
      const replayedSites = new Set(replays.map((r) => r.site));
      const passed = replays.filter(
        (r) =>
          r.outcome !== 'CRASHES' &&
          r.outcome !== 'TIMEOUT' &&
          !(r.outcome === 'REFUSES' && r.code === r.triggerCode)
      );
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 call-bearing] driveable-call-bearing=${CALL_BEARING_DRIVEABLE.length} ` +
          `examined=${callBearingExamined.length} replayed-sites=${replayedSites.size} ` +
          `remedy-executions=${replays.length} passing=${passed.length} ` +
          `passRate=${replays.length === 0 ? 'n/a' : `${((passed.length / replays.length) * 100).toFixed(1)}%`}`
      );
      // T2/T3 apply ONLY here. The arm must actually have executed something.
      expect(replays.length).toBeGreaterThan(0);
      expect(passed.length).toBe(replays.length);
    });

    it('T7 (LEDGER) — E + R === driveable, and every residual is NAMED with a stated reason', () => {
      const distinctValues = [...sink.values].filter(([site]) => DRIVEABLE_SITES.has(site));
      const multiValueSites = distinctValues.filter(([, values]) => values.size > 1);
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 ledger] sites=${CENSUS.length + 2} authored=${CENSUS.length} driveable=${DRIVEABLE.length} ` +
          `examined=${examinedDriveable.length} residual=${residualDriveable.length} ` +
          `remaining=${CENSUS.length - examinedDriveable.length}`
      );
      // eslint-disable-next-line no-console
      console.log(
        `[s89-m08 ledger] distinct observed VALUES at examined driveable sites=${distinctValues.reduce(
          (n, [, v]) => n + v.size,
          0
        )}; sites authoring more than one string=${multiValueSites.length} ` +
          `(a site counted EXAMINED may still have unexamined branches)`
      );
      for (const site of residualDriveable) {
        const reason = RESIDUAL_REASONS[site];
        // eslint-disable-next-line no-console
        console.log(`  RESIDUAL ${site} :: ${reason ?? '*** NO STATED REASON ***'}`);
      }
      // The equality, and — the part that makes it non-vacuous — a stated reason for every residual.
      expect(examinedDriveable.length + residualDriveable.length).toBe(DRIVEABLE.length);
      expect(residualDriveable.filter((site) => !RESIDUAL_REASONS[site])).toEqual([]);
      // Guard the other direction: a reason for a site that is NOT residual is stale bookkeeping.
      expect(
        Object.keys(RESIDUAL_REASONS).filter((site) => !residualDriveable.includes(site))
      ).toEqual([]);
    });
  }
);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// MIRROR INTEGRITY — a harness that is not testing the shipped code must fail loudly
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('s89-m08 MIRROR INTEGRITY — the instrument proves it is byte-faithful, every run', () => {
  it('regenerates from src/ in this run and restores every file byte-for-byte', () => {
    // buildSuggestionMirror throws on any SHA-256 mismatch; calling it here re-proves it for the
    // portable path too (the matrix arm above builds its own).
    const result = buildSuggestionMirror();
    const { sites, forwarding, files } = countAllSuggestionSites();
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 mirror] wraps=${result.wraps} changedFiles=${result.changedFiles.length} ` +
        `transpiled=${result.transpiledFiles} integrityChecked=${result.integrityChecked}`
    );
    expect(result.wraps).toBe(sites);
    expect(result.changedFiles).toHaveLength(files);
    expect(result.integrityChecked).toBe(files);
    expect(result.sites.filter((s) => s.forwarding)).toHaveLength(forwarding);
  });

  it('writes back to NO file in src/, proven by content hash rather than by git status', () => {
    // Deliberately NOT `git status --porcelain` on src/: that cannot tell a mirror write-back from
    // an ordinary uncommitted edit, so it would be green on a clean tree and red on every working
    // branch — a gate that only fires when nobody is working. Hashing src/ around the build proves
    // the actual claim: the transform reads src/ and writes only into its own cache root.
    const before = new Map<string, string>();
    for (const file of walkTsFiles(SRC_ROOT)) {
      before.set(file, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
    buildSuggestionMirror();
    const changed: string[] = [];
    for (const [file, digest] of before) {
      const now = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (now !== digest) changed.push(path.relative(REPO_ROOT, file));
    }
    expect(changed).toEqual([]);
    // The mirror root is gitignored, so it must produce no porcelain entry of any kind — and it
    // must not create `<repo>/tmp/` either: `tmp` is a PRIVATE_PATHS marker, and materialising one
    // at runtime makes requiresPrivateEvidence read a staged public mirror as a private checkout,
    // which turns every later suite's loud SKIP into a declaration-time THROW (measured: 13 suites).
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const untrackedMarkers = status
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((file) => file.startsWith('tmp/') || file.startsWith('node_modules/'));
    expect(untrackedMarkers).toEqual([]);
    expect(MIRROR_ROOT.startsWith(path.join(REPO_ROOT, 'tmp'))).toBe(false);
    for (const marker of readMirrorExclusions().all) {
      expect(path.relative(REPO_ROOT, MIRROR_ROOT).split(path.sep)[0]).not.toBe(marker);
    }
  });
});
