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
 * T6 SCOPE SENTENCE. For every published non-`action` `type: "string"` field crossed with every
 * valid action (or its action-less tool), the T6 scope arm calls `findWrongTypedStringParam` with a
 * numeric wrong value and asserts that the guard's refusal set is a non-empty proper subset of the
 * whole universe, exactly equals the action-applicability contract, and still covers every pinned
 * historically-crashing triple. The driven T6 arms separately send number, object, array and
 * boolean values through all 15 in-process routers and assert every applicable value is refused.
 *
 * D-5's REFUSAL (#1024) STANDS AND IS REINFORCED, NOT OVERTURNED. D-5 refused a general
 * class-(b) semantic gate at any budget, on a figure ("75 of 176") whose predicate was never
 * recorded and is therefore not re-derivable. Under a STATED predicate re-run in this mission — a
 * suggestion carries no checkable identifier when it contains no `cmos_*(` call token, no bare
 * shipped tool name, no npm/npx/cmos-mcp command, no file path and no snake_case identifier — a
 * MAJORITY of the 182 authored suggestions carry NO checkable identifier at all (112 at the time
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
 *  1. THE 2 FORWARDING SITES. 184 `suggestion:` PropertyAssignments exist; 2 are exact
 *     property-access forwarding (`suggestion: x.suggestion`) and make no new claim. 182 authored.
 *     Re-derived by this file's own census arm, never hard-coded.
 *  2. THE DECLARED COMPLEMENT IS SPLIT, NOT HIDDEN. The 75 non-first-run FAULT sites still need a
 *     fault-injection instrument (read-only DB file, corrupt context JSON, dropped table); the 3
 *     first-run FAULT sites are the separately driven subset. EXTERNAL 24 now has its OWN portable
 *     ledger below: a real loopback HTTP server plus synthetic credential/config state reaches 21,
 *     while 3 are named construction-masked residuals. UNTYPED 1 remains at
 *     `sprint-summary-read.ts:45`, whose helper has zero production callers and inherits an
 *     arbitrary error code. `errors.ts:378` is consumer-resolved to SENDER_UNRESOLVABLE and its
 *     explicit-projectRoot remedy is exercised over stdio. The EXTERNAL arm uses mirrored routers,
 *     no operator credential and no MCP stdio wire; it therefore takes no credit for the first-run
 *     wire matrix in `tests/e2e/wire-preflight.e2e.ts`.
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
 *  8. T6'S SCOPE ARM TESTS THE ROUTER GUARD, NOT THE WIRE PREFLIGHT. It establishes no pre-guard
 *     outcome baseline, so "not refused" does not mean success or byte-identical output. Both its
 *     expected set and the guard's applicable list consume `CMOS_ACTION_PARAMS`; the independent
 *     table-to-router contract belongs to `action-params.test.ts`. The whole T6 describe is skipped
 *     in a structural public mirror, and `verify-dist.ts`'s three wrong-type probes are all in-scope,
 *     so neither surface detects an over-broad guard. A red scope arm can therefore mean either a
 *     widened guard or an under-declared applicability table. None of this establishes the correct
 *     `src/index.ts` pre-dispatch scope: the wire consumes `projectRoot` independently of routers.
 *
 * THE MIRROR IS NOT A BUILD. Provenance comes from an AST source transform into a gitignored
 * CommonJS mirror under `node_modules/.cache/` — ZERO `src/` edits — and it proves itself faithful
 * run. See `tests/helpers/suggestion-mirror.ts` for why a structured `remedy` field was rejected.
 */

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
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
import { seedCmosDb, reidentifyCmosTestStore } from '../../helpers/seedCmosDb';
import {
  seedTempCredentials,
  startDashboardDouble,
  type DashboardDouble,
  type DashboardScenario,
} from '../../helpers/suggestion-axes-external';

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
 * `authored === RATIFIED_AUTHORED_BASE + sum(SITES_BY_MISSION)`.
 *
 * The base is Arc F item 1's ratified denominator (decision #1080, re-derived by this mission).
 * s90-m05 adds exactly the carry-target refusal below. The ratified base remains fixed; each later
 * mission enumerates its authored sites here rather than moving that base.
 */
const RATIFIED_AUTHORED_BASE = 181;
const SITES_BY_MISSION = {
  's90-m05': ['src/tools/cmos/cmos-next-steps.ts:315'],
  's90-m07': [],
} as const satisfies Readonly<Record<string, readonly string[]>>;
const RATIFIED_SITE_ADDS = Object.values(SITES_BY_MISSION).flat();

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
 * `errors.ts:378` is produced by `senderUnresolvable`. Its only production error source is
 * `SenderResolutionError`, whose sole production construction uses the SENDER_UNRESOLVABLE
 * default; the proof below makes that premise executable. `sprint-summary-read.ts:45` remains
 * absent: `withViewContext` spreads `...error`, so its code is arbitrary, and it has ZERO callers.
 */
const CONSUMER_RESOLVED_CODES: Readonly<Record<string, string>> = {
  'src/tools/cmos/cmos-context-update.ts:775': 'INVALID_PARAMETER',
  'src/tools/cmos/cmos-context-update.ts:785': 'INVALID_PARAMETER',
  'src/tools/cmos/cmos-context-update.ts:794': 'INVALID_PARAMETER',
  'src/tools/cmos/cmos-context-update.ts:813': 'INVALID_PARAMETER',
  'src/tools/cmos/errors.ts:378': 'SENDER_UNRESOLVABLE',
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
        tool: 'cmos_context',
        params: {
          action: 'next_steps',
          nextStepAction: 'carry',
          nextStepIds: [999999],
          carryToSprint: 'sprint-89089',
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
          // The sprint must be CLOSABLE, or cmos-sprint-complete's SPRINT_NOT_READY guard fires
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

/** Every `suggestion:` PropertyAssignment, including the forwarding ones — the 184 denominator. */
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
const EXTERNAL = CENSUS.filter((row) => row.triggerClass === 'EXTERNAL');
const EXTERNAL_SITES = new Set(EXTERNAL.map((row) => row.site));
const FIRST_RUN_CODES = new Set(['CMOS_NOT_DETECTED', 'DB_NOT_FOUND']);
const FIRST_RUN = CENSUS.filter((row) => row.code !== null && FIRST_RUN_CODES.has(row.code));
const FIRST_RUN_SITES = new Set(FIRST_RUN.map((row) => row.site));

/**
 * The 3 members the sanctioned dashboard/credential instrument still cannot construct.
 * Both ledger directions are checked below: an absent reason is unaccounted work; a reason for a
 * fired/non-universe site is stale bookkeeping.
 */
const EXTERNAL_RESIDUAL_REASONS: Readonly<Record<string, string>> = {
  'src/tools/cmos/client.ts:748':
    '`validateProjectId()` has zero production callers; only direct unit tests invoke the method.',
  'src/tools/cmos/client.ts:756':
    'The second PROJECT_ID_MISMATCH arm is in the same production-unreachable `validateProjectId()` method.',
  'src/tools/cmos/sync-mutable-push.ts:166':
    '`maybePropagateMutableStatus` returns before `pushMutableStatus` unless `isCollabStore` is true; ' +
    'the NOT_COLLAB_STORE defensive branch is construction-masked by its only production caller.',
};

const HTTP_EXTERNAL_SITES = new Set([
  'src/tools/cmos/cmos-auth.ts:610',
  'src/tools/cmos/cmos-auth.ts:1183',
  'src/tools/cmos/cmos-auth.ts:1192',
  'src/tools/cmos/cmos-auth.ts:1200',
  'src/tools/cmos/cmos-message.ts:1027',
  'src/tools/cmos/errors.ts:422',
  'src/tools/cmos/errors.ts:438',
  'src/tools/cmos/errors.ts:457',
  'src/tools/cmos/errors.ts:469',
  'src/tools/cmos/errors.ts:477',
  'src/tools/cmos/errors.ts:497',
]);
const SYNTHETIC_EXTERNAL_SITES = new Set([
  'src/tools/cmos/cmos-auth.ts:572',
  'src/tools/cmos/cmos-auth.ts:581',
  'src/tools/cmos/cmos-auth.ts:667',
  'src/tools/cmos/cmos-auth.ts:807',
  'src/tools/cmos/cmos-auth.ts:942',
  'src/tools/cmos/cmos-auth.ts:949',
  'src/tools/cmos/cmos-auth.ts:1124',
  'src/tools/cmos/cmos-auth.ts:1133',
  'src/tools/cmos/dashboard-client.ts:270',
  'src/tools/cmos/errors.ts:487',
]);

/** Shared with the private T7 ledger; the replay fence remains private and unchanged. */
const externalFiredSites = new Set<string>();
const externalScratchRoots = new Set<string>();
const externalCredentialPaths = new Set<string>();
const externalCredentialResolutions = new Map<string, string>();

describe('s89-m08 CENSUS — the universe re-derives at build time, never from a remembered number', () => {
  it('re-derives the sites / forwarding split and the ratified authored-base delta', () => {
    const { sites, forwarding, files } = countAllSuggestionSites();
    const authored = sites - forwarding;
    // eslint-disable-next-line no-console
    console.log(
      `[s89-m08 census] sites=${sites} forwarding=${forwarding} authored=${authored} files=${files} ` +
        `callBearing=${CENSUS.filter((r) => r.callBearing).length}`
    );
    expect(CENSUS).toHaveLength(authored);
    // fold 4 — the RULE, not the number. A mission that adds an authored site enumerates it.
    expect(authored).toBe(RATIFIED_AUTHORED_BASE + RATIFIED_SITE_ADDS.length);
    expect(SITES_BY_MISSION['s90-m07']).toEqual([]);
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

  it('PROVES every consumer-resolved premise instead of trusting its override', () => {
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

    const senderSourcePath = path.join(SRC_ROOT, 'intelligence', 'sender-context.ts');
    const senderSource = ts.createSourceFile(
      senderSourcePath,
      fs.readFileSync(senderSourcePath, 'utf8'),
      ts.ScriptTarget.ES2020,
      true
    );
    const constructions: ts.NewExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'SenderResolutionError'
      ) {
        constructions.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(senderSource);
    expect(constructions).toHaveLength(1);
    expect(constructions[0]?.arguments).toHaveLength(2);
    expect(fs.readFileSync(path.join(SRC_ROOT, 'tools', 'cmos', 'errors.ts'), 'utf8')).toContain(
      'code: string = CMOS_ERROR_CODES.SENDER_UNRESOLVABLE'
    );
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

// ────────────────────────────────────────────────────────────────────────────────────────────────
// s90-m07 — THE PORTABLE EXTERNAL + FIRST-RUN INSTRUMENT
// ──────────────────────────────────────────────────────────────────────────────────────────────

const EXTERNAL_ENV_KEYS = [
  'CMOS_CONFIG_DIR',
  'CMOS_DASHBOARD_URL',
  'CMOS_DASHBOARD_API_KEY',
  'CMOS_DASHBOARD_USER',
  'CMOS_DASHBOARD_PASSWORD',
] as const;

type ExternalEnvKey = (typeof EXTERNAL_ENV_KEYS)[number];
type CredentialShape = 'none' | 'user' | 'project' | 'two-user';

interface ExternalSeedOptions {
  seedProject?: boolean;
  registered?: boolean;
  credentials?: CredentialShape;
  legacyApiKey?: boolean;
  removeSlug?: boolean;
  projectName?: string;
  projectId?: string;
  slug?: string;
  cmosAddress?: string;
  dashboardUrl?: 'loopback' | 'unset';
}

interface ExternalCaseState {
  caseRoot: string;
  configDir: string;
  projectRoot: string;
  credentialsPath: string;
  dbPath?: string;
}

interface PortableEvidence extends DrivenCall {
  family: 'external-http' | 'external-synthetic' | 'driveable' | 'first-run';
  expectedCode: string;
  expectsHttp: boolean;
  fired: string[];
  requests: Array<{
    method: string;
    url: string;
    authorization: string;
    matchedScenario: boolean;
  }>;
}

interface PortableReplay {
  site: string;
  caseName: string;
  triggerCode: string | undefined;
  suggestion: string;
  tool: string;
  action: string | undefined;
  outcome: Outcome;
  code?: string;
  thrown?: string;
  durationMs: number;
  resolverOutputs: string[];
  requests: PortableEvidence['requests'];
}

const portableEvidence: PortableEvidence[] = [];
const portableReplays: PortableReplay[] = [];
const blockedOutboundUrls: string[] = [];
const blockedTriggerOutboundUrls: string[] = [];
let externalFencePositiveControls = 0;
let externalTriggerFencePositiveControl = false;
const externalCredentialModes = new Map<string, number>();
let externalDouble!: DashboardDouble;
let savedExternalFetch: typeof fetch | undefined;
let externalCaseSeq = 0;
let externalReplaySnapshotSeq = 0;
let savedExternalEnv!: Record<ExternalEnvKey, string | undefined>;
let unknownRouteProbe!: { status: number; body: string };

interface IsolatedDashboardBoundary {
  double: DashboardDouble;
  configDir: string;
  blockedUrls: string[];
  positiveControlBlocked: boolean;
  sourceCredentialPath: string;
  mirrorCredentialPath?: string;
  close(): Promise<void>;
}

async function installIsolatedDashboardBoundary(label: string): Promise<IsolatedDashboardBoundary> {
  const savedEnv = Object.fromEntries(
    EXTERNAL_ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Record<ExternalEnvKey, string | undefined>;
  const savedFetch = globalThis.fetch;
  const blockedUrls: string[] = [];
  const configDir = mkTmp(`cmos-${label}-config-`);
  const double = await startDashboardDouble({
    kind: 'device-code-error',
    expectedAuthorization: '',
    status: 503,
    body: { type: 'text', value: `${label} loopback boundary` },
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    globalThis.fetch = savedFetch;
    CredentialStore.resetInstance();
    ProjectGraphRegistry.resetInstance();
    CmosDetector.resetInstance();
    if (mirror?.root) resetMirroredExternalState();
    for (const key of EXTERNAL_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await double.close();
  };

  try {
    externalScratchRoots.add(fs.realpathSync(configDir));
    externalScratchRoots.add(double.scratchRoot);
    for (const key of EXTERNAL_ENV_KEYS) delete process.env[key];
    process.env.CMOS_CONFIG_DIR = configDir;
    process.env.CMOS_DASHBOARD_URL = double.origin;
    CredentialStore.resetInstance();
    ProjectGraphRegistry.resetInstance();
    CmosDetector.resetInstance();
    if (mirror?.root) resetMirroredExternalState();
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(raw).origin !== double.origin) {
        blockedUrls.push(raw);
        throw new Error(`non-loopback fetch blocked by ${label}: ${raw}`);
      }
      return savedFetch(...args);
    }) as typeof fetch;

    const probeUrl = 'http://127.0.0.1:1/s90-m08-positive-control';
    let positiveControlBlocked = false;
    try {
      await globalThis.fetch(probeUrl);
    } catch (error) {
      positiveControlBlocked =
        error instanceof Error && error.message.includes(`non-loopback fetch blocked by ${label}`);
    }
    if (!positiveControlBlocked || blockedUrls.pop() !== probeUrl) {
      throw new Error(`${label} boundary did not block and record its positive-control URL`);
    }
    const sourceCredentialPath = CredentialStore.getInstance().path;
    const mirrorCredentialPath = mirror?.root ? mirroredCredentialStorePath() : undefined;
    return {
      double,
      configDir,
      blockedUrls,
      positiveControlBlocked,
      sourceCredentialPath,
      mirrorCredentialPath,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function resetMirroredExternalState(): void {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { CredentialStore } = require(`${mirror.root}/intelligence/credential-store.js`) as {
    CredentialStore: { resetInstance(): void };
  };
  const { ProjectGraphRegistry } = require(
    `${mirror.root}/intelligence/project-graph-registry.js`
  ) as { ProjectGraphRegistry: { resetInstance(): void } };
  const { CmosDetector } = require(`${mirror.root}/intelligence/cmos-detector.js`) as {
    CmosDetector: { resetInstance(): void };
  };
  const { resetDeliveryAckCache } = require(`${mirror.root}/auth/delivery-ack-cache.js`) as {
    resetDeliveryAckCache(): void;
  };
  const { __resetDirectoryCacheForTesting } = require(
    `${mirror.root}/tools/cmos/cmos-message.js`
  ) as { __resetDirectoryCacheForTesting(): void };
  /* eslint-enable @typescript-eslint/no-var-requires */
  CredentialStore.resetInstance();
  ProjectGraphRegistry.resetInstance();
  CmosDetector.resetInstance();
  resetDeliveryAckCache();
  __resetDirectoryCacheForTesting();
}

function mirroredCredentialStorePath(): string {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { CredentialStore } = require(`${mirror.root}/intelligence/credential-store.js`) as {
    CredentialStore: { getInstance(): { readonly path: string } };
  };
  /* eslint-enable @typescript-eslint/no-var-requires */
  return CredentialStore.getInstance().path;
}

function restoreExternalEnvironment(): void {
  if (!savedExternalEnv) return;
  for (const key of EXTERNAL_ENV_KEYS) {
    const value = savedExternalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function markRegistered(dbPath: string): void {
  withDb(dbPath, (db) => {
    db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`).run(
      'dashboard_registered',
      'true'
    );
  });
}

function seedPortableState(label: string, options: ExternalSeedOptions = {}): ExternalCaseState {
  const safeLabel = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const caseRoot = path.join(
    externalDouble.scratchRoot,
    `${String(externalCaseSeq++).padStart(2, '0')}-${safeLabel}`
  );
  const configDir = path.join(caseRoot, 'config');
  const projectRoot = path.join(caseRoot, 'project');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  externalScratchRoots.add(caseRoot);
  externalScratchRoots.add(configDir);
  externalScratchRoots.add(projectRoot);

  for (const key of EXTERNAL_ENV_KEYS) delete process.env[key];
  process.env.CMOS_CONFIG_DIR = configDir;
  if (options.dashboardUrl !== 'unset') process.env.CMOS_DASHBOARD_URL = externalDouble.origin;
  if (options.legacyApiKey) process.env.CMOS_DASHBOARD_API_KEY = 'cmk_legacy_fixture';

  let dbPath: string | undefined;
  if (options.seedProject !== false) {
    dbPath = seedCmosDb(projectRoot, {
      projectName: options.projectName ?? 'External Fixture',
      projectId: options.projectId ?? 'external-fixture',
      slug: options.slug ?? 'external-fixture',
      dashboardProjectId: options.registered ? '11111111-1111-4111-8111-111111111111' : undefined,
      cmosAddress: options.cmosAddress ?? 'cmos://local/external-fixture',
    });
    if (options.registered) markRegistered(dbPath);
    if (options.removeSlug) {
      withDb(dbPath, (db) => {
        db.prepare(`DELETE FROM metadata WHERE key = 'dashboard_slug'`).run();
      });
    }
  }

  const shape = options.credentials ?? 'none';
  const userKeys =
    shape === 'two-user'
      ? [
          { keyId: 'user-key-1', key: 'cmk_user_fixture_1' },
          { keyId: 'user-key-2', key: 'cmk_user_fixture_2' },
        ]
      : shape === 'user' || shape === 'project'
        ? [{ keyId: 'user-key-1', key: 'cmk_user_fixture_1' }]
        : [];
  const credentialsPath = seedTempCredentials({
    configDir,
    projectRoot,
    userKeys,
    ...(shape === 'project'
      ? {
          projectKey: {
            key: 'cmk_project_fixture',
            keyId: 'project-key-1',
            parentKeyId: 'user-key-1',
          },
        }
      : {}),
  });
  externalCredentialPaths.add(credentialsPath);
  externalCredentialModes.set(credentialsPath, fs.statSync(credentialsPath).mode & 0o777);
  resetMirroredExternalState();
  return {
    caseRoot,
    configDir,
    projectRoot,
    credentialsPath,
    ...(dbPath ? { dbPath } : {}),
  };
}

function externalReplayParams(
  prescription: PrescribedCall,
  state: ExternalCaseState
): Record<string, unknown> {
  const params: Record<string, unknown> = { projectRoot: state.projectRoot };
  if (prescription.action !== undefined) params.action = prescription.action;
  if (prescription.action === 'login_complete') {
    params.deviceCode = 'replay-device';
    params.pollIntervalSeconds = 0;
    params.maxWaitSeconds = 1;
  }
  if (prescription.action === 'revoke') params.keyId = 'project-key-1';
  return params;
}

function externalReplayScenario(prescription: PrescribedCall): DashboardScenario {
  if (['login', 'login_init', 'login_complete'].includes(prescription.action ?? '')) {
    return { kind: 'device-terminal', expectedAuthorization: '', outcome: 'approved' };
  }
  if (prescription.action === 'list') {
    return {
      kind: 'http',
      expected: { method: 'GET', path: '/api/keys', authorization: 'Bearer cmk_project_fixture' },
      status: 200,
      body: { type: 'json', value: { keys: [] } },
    };
  }
  if (prescription.action === 'reissue') {
    return {
      kind: 'http',
      expected: {
        method: 'POST',
        path: '/api/projects/11111111-1111-4111-8111-111111111111/keys/reissue',
        authorization: 'Bearer cmk_user_fixture_1',
      },
      status: 200,
      body: {
        type: 'json',
        value: {
          key: 'cmk_reissued_fixture',
          keyId: 'reissued-project-key',
          label: 'suggestion replay',
          revokedKeyIds: [],
        },
      },
    };
  }
  if (prescription.action === 'revoke') {
    return {
      kind: 'http',
      expected: {
        method: 'POST',
        path: '/api/keys/project-key-1/revoke',
        authorization: 'Bearer cmk_project_fixture',
      },
      status: 200,
      body: {
        type: 'json',
        value: { keyId: 'project-key-1', revokedAt: '2026-09-01T00:00:00.000Z' },
      },
    };
  }
  return {
    kind: 'http',
    expected: { method: 'GET', path: '/__unexpected-remedy__', authorization: '' },
    status: 599,
    body: { type: 'text', value: 'unexpected external remedy route' },
  };
}

async function replayPortableExternalRemedies(
  state: ExternalCaseState,
  trigger: DrivenCall
): Promise<void> {
  if (trigger.outcome !== 'REFUSES' || !trigger.suggestion) return;
  const externalCallBearingSites = trigger.sites.filter((site) =>
    EXTERNAL.some((row) => row.site === site && row.callBearing)
  );
  if (externalCallBearingSites.length === 0) return;

  /* eslint-disable @typescript-eslint/no-var-requires */
  const dashboardModule = require(`${mirror.root}/tools/cmos/dashboard-client.js`) as {
    DEFAULT_DASHBOARD_URL: string;
    resolveDashboardBaseUrl(override?: string): string;
  };
  /* eslint-enable @typescript-eslint/no-var-requires */
  const savedDefault = dashboardModule.DEFAULT_DASHBOARD_URL;
  const savedResolver = dashboardModule.resolveDashboardBaseUrl;
  const savedDashboardUrl = process.env.CMOS_DASHBOARD_URL;
  const savedFetch = globalThis.fetch;
  const resolverOutputs: string[] = [];
  const snapshotRoot = path.join(
    externalDouble.scratchRoot,
    `replay-baseline-${String(externalReplaySnapshotSeq++).padStart(2, '0')}`
  );

  try {
    resetMirroredExternalState();
    fs.cpSync(state.caseRoot, snapshotRoot, { recursive: true });

    delete process.env.CMOS_DASHBOARD_URL;
    dashboardModule.DEFAULT_DASHBOARD_URL = externalDouble.origin;
    if (savedResolver() !== externalDouble.origin) {
      throw new Error(
        'mirrored canonical dashboard default did not resolve to the loopback double'
      );
    }
    dashboardModule.resolveDashboardBaseUrl = (override?: string): string => {
      const resolved = savedResolver(override);
      resolverOutputs.push(resolved);
      return resolved;
    };
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(raw).origin !== externalDouble.origin) {
        blockedOutboundUrls.push(raw);
        throw new Error(`non-loopback fetch blocked by suggestion replay: ${raw}`);
      }
      return savedFetch(...args);
    }) as typeof fetch;

    const probeUrl = 'http://127.0.0.1:1/s90-m08-replay-positive-control';
    let positiveControlBlocked = false;
    try {
      await globalThis.fetch(probeUrl);
    } catch (error) {
      positiveControlBlocked =
        error instanceof Error &&
        error.message.includes('non-loopback fetch blocked by suggestion replay');
    }
    if (!positiveControlBlocked || blockedOutboundUrls.pop() !== probeUrl) {
      throw new Error('external replay fence did not block and record its positive-control URL');
    }
    externalFencePositiveControls += 1;

    const seen = new Set<string>();
    for (const site of externalCallBearingSites) {
      for (const prescription of extractPrescribedCalls(trigger.suggestion)) {
        const key = `${site}|${prescription.tool}|${prescription.action ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resetMirroredExternalState();
        fs.rmSync(state.caseRoot, { recursive: true, force: true });
        fs.cpSync(snapshotRoot, state.caseRoot, { recursive: true });
        resetMirroredExternalState();
        if (mirroredCredentialStorePath() !== state.credentialsPath) {
          throw new Error('external replay escaped its isolated credential store');
        }
        externalDouble.setScenario(externalReplayScenario(prescription));
        externalDouble.clearRequests();
        sink.reset();
        const resolverStart = resolverOutputs.length;
        const started = Date.now();
        const executed = await driveMirrored(
          `${trigger.caseName} remedy`,
          'external-replay',
          prescription.tool,
          externalReplayParams(prescription, state)
        );
        portableReplays.push({
          site,
          caseName: trigger.caseName,
          triggerCode: trigger.code,
          suggestion: trigger.suggestion,
          tool: prescription.tool,
          action: prescription.action,
          outcome: executed.outcome,
          code: executed.code,
          thrown: executed.thrown,
          durationMs: Date.now() - started,
          resolverOutputs: resolverOutputs.slice(resolverStart),
          requests: [...externalDouble.requests],
        });
      }
    }
  } finally {
    globalThis.fetch = savedFetch;
    dashboardModule.resolveDashboardBaseUrl = savedResolver;
    dashboardModule.DEFAULT_DASHBOARD_URL = savedDefault;
    if (savedDashboardUrl === undefined) delete process.env.CMOS_DASHBOARD_URL;
    else process.env.CMOS_DASHBOARD_URL = savedDashboardUrl;
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

async function runPortableCase(options: {
  name: string;
  family: PortableEvidence['family'];
  expectedCode: string;
  expectsHttp: boolean;
  scenario: DashboardScenario;
  seed?: ExternalSeedOptions;
  tool: string;
  params: (state: ExternalCaseState) => Record<string, unknown>;
  setup?: (state: ExternalCaseState) => void;
}): Promise<void> {
  const state = seedPortableState(options.name, options.seed);
  options.setup?.(state);
  // A setup may create another mirrored-detector-visible project.
  resetMirroredExternalState();
  const resolvedCredentialsPath = mirroredCredentialStorePath();
  externalCredentialResolutions.set(state.credentialsPath, resolvedCredentialsPath);
  if (resolvedCredentialsPath !== state.credentialsPath) {
    throw new Error(
      `mirrored CredentialStore resolved ${resolvedCredentialsPath}; expected isolated ${state.credentialsPath}`
    );
  }
  externalDouble.setScenario(options.scenario);
  externalDouble.clearRequests();
  sink.reset();
  const call = await driveMirrored(
    options.name,
    options.family,
    options.tool,
    options.params(state)
  );
  const fired = [...sink.fired].sort();
  for (const site of fired) externalFiredSites.add(site);
  portableEvidence.push({
    ...call,
    family: options.family,
    expectedCode: options.expectedCode,
    expectsHttp: options.expectsHttp,
    fired,
    requests: [...externalDouble.requests],
  });
  await replayPortableExternalRemedies(state, call);
}

interface DirectDashboardUrlRead {
  site: string;
  canonical: boolean;
  syntax: 'dot' | 'element' | 'destructure';
}

function directDashboardUrlReadsInSource(
  relative: string,
  source: ts.SourceFile
): DirectDashboardUrlRead[] {
  const reads: DirectDashboardUrlRead[] = [];
  const isProcessEnv = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env';
  const recordsUrlName = (node: ts.Node | undefined): boolean => {
    if (!node) return false;
    if (ts.isComputedPropertyName(node)) return recordsUrlName(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text === 'CMOS_DASHBOARD_URL';
    return (
      ts.isIdentifier(node) &&
      (node.text === 'CMOS_DASHBOARD_URL' || node.text === 'CMOS_DASHBOARD_URL_ENV')
    );
  };

  const add = (node: ts.Node, syntax: DirectDashboardUrlRead['syntax']): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    let owner: ts.Node | undefined = node.parent;
    while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
    reads.push({
      site: `${relative}:${line}`,
      canonical:
        relative === 'src/tools/cmos/dashboard-client.ts' &&
        !!owner &&
        ts.isFunctionDeclaration(owner) &&
        owner.name?.text === 'resolveDashboardBaseUrl',
      syntax,
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      node.name.text === 'CMOS_DASHBOARD_URL'
    ) {
      add(node, 'dot');
    } else if (
      ts.isElementAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      recordsUrlName(node.argumentExpression)
    ) {
      add(node, 'element');
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isProcessEnv(node.initializer)
    ) {
      for (const element of node.name.elements) {
        if (recordsUrlName(element.propertyName ?? element.name)) add(element, 'destructure');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/** Spelling-independent over dot, element/constant-element and object-destructuring env reads. */
function directDashboardUrlReads(): DirectDashboardUrlRead[] {
  const reads: DirectDashboardUrlRead[] = [];
  for (const absolute of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(absolute, 'utf8');
    if (!content.includes('CMOS_DASHBOARD_URL')) continue;
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    const source = ts.createSourceFile(absolute, content, ts.ScriptTarget.ES2020, true);
    reads.push(...directDashboardUrlReadsInSource(relative, source));
  }
  return reads.sort((a, b) => a.site.localeCompare(b.site));
}

describe('s90-m07 PORTABLE EXTERNAL + FIRST-RUN LEDGER — loopback, never live credentials', () => {
  const NO_AUTH = '';
  const PROJECT_AUTH = 'Bearer cmk_project_fixture';
  const USER_AUTH = 'Bearer cmk_user_fixture_1';
  const noHttpScenario: DashboardScenario = {
    kind: 'http',
    expected: { method: 'GET', path: '/__unexpected-no-http__', authorization: NO_AUTH },
    status: 599,
    body: { type: 'text', value: 'an alleged no-HTTP case reached the dashboard double' },
  };

  beforeAll(async () => {
    savedExternalEnv = Object.fromEntries(
      EXTERNAL_ENV_KEYS.map((key) => [key, process.env[key]])
    ) as Record<ExternalEnvKey, string | undefined>;
    mirror = buildSuggestionMirror();
    sink = installSuggestionSink();
    sink.reset();
    mirrorRouters = loadMirrorRouters();
    externalDouble = await startDashboardDouble();
    externalScratchRoots.add(externalDouble.scratchRoot);
    savedExternalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(raw).origin !== externalDouble.origin) {
        blockedTriggerOutboundUrls.push(raw);
        throw new Error(`non-loopback fetch blocked by portable trigger: ${raw}`);
      }
      return savedExternalFetch!(...args);
    }) as typeof fetch;
    const triggerProbeUrl = 'http://127.0.0.1:1/s90-m08-trigger-positive-control';
    try {
      await globalThis.fetch(triggerProbeUrl);
    } catch (error) {
      externalTriggerFencePositiveControl =
        error instanceof Error &&
        error.message.includes('non-loopback fetch blocked by portable trigger');
    }
    if (
      !externalTriggerFencePositiveControl ||
      blockedTriggerOutboundUrls.pop() !== triggerProbeUrl
    ) {
      throw new Error('portable trigger fence did not block and record its positive-control URL');
    }
    externalDouble.setScenario({
      kind: 'http',
      expected: { method: 'GET', path: '/configured-only', authorization: NO_AUTH },
      status: 418,
      body: { type: 'text', value: 'configured route only' },
    });
    const unknownResponse = await fetch(`${externalDouble.origin}/never-stubbed`);
    unknownRouteProbe = { status: unknownResponse.status, body: await unknownResponse.text() };
    externalDouble.clearRequests();

    await runPortableCase({
      name: 'rotate has no local project key',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { registered: true, credentials: 'user' },
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({ action: 'rotate', projectRoot }),
    });
    await runPortableCase({
      name: 'rotate project is not dashboard registered',
      family: 'external-synthetic',
      expectedCode: 'PROJECT_NOT_REGISTERED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { credentials: 'project' },
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({ action: 'rotate', projectRoot }),
    });
    await runPortableCase({
      name: 'rotate receives dashboard 401',
      family: 'external-http',
      expectedCode: 'DASHBOARD_AUTH_FAILED',
      expectsHttp: true,
      scenario: {
        kind: 'http',
        expected: {
          method: 'POST',
          path: '/api/projects/11111111-1111-4111-8111-111111111111/keys/rotate',
          authorization: PROJECT_AUTH,
        },
        status: 401,
        body: { type: 'json', value: { error: 'revoked fixture key' } },
      },
      seed: { credentials: 'project', registered: true },
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({ action: 'rotate', projectRoot }),
    });
    await runPortableCase({
      name: 'revoke cannot derive an absent project key',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({ action: 'revoke', projectRoot }),
    });
    await runPortableCase({
      name: 'reissue project is not dashboard registered',
      family: 'external-synthetic',
      expectedCode: 'PROJECT_NOT_REGISTERED',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({ action: 'reissue', projectRoot }),
    });
    await runPortableCase({
      name: 'reissue has no device-code user credential',
      family: 'external-synthetic',
      expectedCode: 'DEVICE_CODE_REQUIRED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { registered: true },
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({ action: 'reissue', projectRoot }),
    });
    await runPortableCase({
      name: 'reissue selected a legacy unattributable credential',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_ATTRIBUTABLE',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { registered: true, legacyApiKey: true },
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({ action: 'reissue', projectRoot }),
    });
    await runPortableCase({
      name: 'logout explicit key is not a local user key',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { credentials: 'project' },
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({
        action: 'logout',
        keyId: 'missing-user-key',
        projectRoot,
      }),
    });
    await runPortableCase({
      name: 'logout has no local user key',
      family: 'external-synthetic',
      expectedCode: 'CREDENTIAL_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({ action: 'logout', projectRoot }),
    });
    await runPortableCase({
      name: 'login device code expires',
      family: 'external-http',
      expectedCode: 'DEVICE_CODE_EXPIRED',
      expectsHttp: true,
      scenario: {
        kind: 'device-terminal',
        expectedAuthorization: NO_AUTH,
        outcome: 'expired_token',
        errorDescription: 'fixture terminal',
        deviceCode: 'dc-expired',
        expiresIn: 30,
      },
      seed: { seedProject: false },
      tool: 'cmos_auth',
      params: () => ({ action: 'login' }),
    });
    await runPortableCase({
      name: 'login device code is denied',
      family: 'external-http',
      expectedCode: 'DEVICE_CODE_ACCESS_DENIED',
      expectsHttp: true,
      scenario: {
        kind: 'device-terminal',
        expectedAuthorization: NO_AUTH,
        outcome: 'access_denied',
        errorDescription: 'fixture denied',
        deviceCode: 'dc-denied',
        expiresIn: 30,
      },
      seed: { seedProject: false },
      tool: 'cmos_auth',
      params: () => ({ action: 'login' }),
    });
    await runPortableCase({
      name: 'login init device endpoint fails',
      family: 'external-http',
      expectedCode: 'DASHBOARD_ERROR',
      expectsHttp: true,
      scenario: {
        kind: 'device-code-error',
        expectedAuthorization: NO_AUTH,
        status: 503,
        body: { type: 'text', value: 'dashboard down' },
      },
      seed: { seedProject: false },
      tool: 'cmos_auth',
      params: () => ({ action: 'login_init' }),
    });

    for (const statusCase of [
      {
        name: 'directory socket disconnect',
        expectedCode: 'DASHBOARD_UNREACHABLE',
        scenario: {
          kind: 'socket-disconnect',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 401',
        expectedCode: 'DASHBOARD_AUTH_FAILED',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 401,
          body: { type: 'json', value: { error: 'revoked fixture key' } },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 403',
        expectedCode: 'DASHBOARD_FORBIDDEN',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 403,
          body: { type: 'json', value: { error: 'forbidden', hint: 'fixture hint' } },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 404',
        expectedCode: 'DASHBOARD_NOT_FOUND',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 404,
          body: { type: 'json', value: { error: 'missing', hint: 'fixture hint' } },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 500',
        expectedCode: 'DASHBOARD_ERROR',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 500,
          body: { type: 'text', value: 'upstream exploded' },
        } as DashboardScenario,
      },
      {
        name: 'directory dashboard 402',
        expectedCode: 'DASHBOARD_UPGRADE_REQUIRED',
        scenario: {
          kind: 'http',
          expected: {
            method: 'GET',
            path: '/api/projects/directory/public',
            authorization: PROJECT_AUTH,
          },
          status: 402,
          body: { type: 'text', value: 'upgrade required' },
        } as DashboardScenario,
      },
    ]) {
      await runPortableCase({
        ...statusCase,
        family: 'external-http',
        expectsHttp: true,
        seed: {
          credentials: 'project',
          registered: statusCase.expectedCode === 'DASHBOARD_AUTH_FAILED',
        },
        tool: 'cmos_message',
        params: ({ projectRoot }) => ({ action: 'directory', projectRoot }),
      });
    }

    await runPortableCase({
      name: 'directory has canonical default but no credential',
      family: 'external-synthetic',
      expectedCode: 'DASHBOARD_NOT_CONFIGURED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { dashboardUrl: 'unset' },
      tool: 'cmos_message',
      params: ({ projectRoot }) => ({ action: 'directory', projectRoot }),
    });

    let mismatchedAdvertisedRoot = '';
    await runPortableCase({
      name: 'send advertised roots mismatch the authoritative sender',
      family: 'external-http',
      expectedCode: 'SENDER_ATTRIBUTION_MISMATCH',
      expectsHttp: true,
      scenario: {
        kind: 'message-resolve-success',
        expectedAuthorization: USER_AUTH,
        resolved: {
          projectId: '33333333-3333-4333-8333-333333333333',
          projectName: 'Receiver',
          projectSlug: 'receiver',
        },
      },
      seed: {
        registered: true,
        credentials: 'user',
        projectName: 'Primary',
        projectId: 'primary',
        slug: 'primary',
        cmosAddress: 'cmos://local/primary',
      },
      setup: (state) => {
        mismatchedAdvertisedRoot = path.join(state.caseRoot, 'advertised-other');
        fs.mkdirSync(mismatchedAdvertisedRoot, { recursive: true });
        externalScratchRoots.add(mismatchedAdvertisedRoot);
        seedCmosDb(mismatchedAdvertisedRoot, {
          projectName: 'Other',
          projectId: 'other',
          slug: 'other',
          dashboardProjectId: '22222222-2222-4222-8222-222222222222',
          cmosAddress: 'cmos://local/other',
        });
      },
      tool: 'cmos_message',
      params: ({ projectRoot }) => ({
        action: 'send',
        targetAddress: 'cmos://target/receiver',
        type: 'question',
        summary: 's90-m07 portable sender mismatch',
        projectRoot,
        advertisedRoots: [mismatchedAdvertisedRoot],
      }),
    });

    await runPortableCase({
      name: 'purge expected slug differs from local identity',
      family: 'external-synthetic',
      expectedCode: 'EXPECTED_SLUG_MISMATCH',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { credentials: 'project', projectName: 'Actual Project', slug: 'actual-project' },
      tool: 'cmos_db',
      params: ({ projectRoot }) => ({
        action: 'purge',
        confirm: true,
        expectedSlug: 'different-slug',
        projectRoot,
      }),
    });

    await runPortableCase({
      name: 'logout with two local user keys needs an explicit keyId',
      family: 'driveable',
      expectedCode: 'MISSING_PARAMETER',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { credentials: 'two-user' },
      tool: 'cmos_auth',
      params: ({ projectRoot }) => ({ action: 'logout', projectRoot }),
    });
    await runPortableCase({
      name: 'whoami cannot resolve a project without sender identity',
      family: 'driveable',
      expectedCode: 'SENDER_UNRESOLVABLE',
      expectsHttp: false,
      scenario: noHttpScenario,
      tool: 'cmos_message',
      params: ({ projectRoot }) => ({ action: 'whoami', projectRoot }),
    });
    await runPortableCase({
      name: 'message is absent from exact and bounded fallback reads',
      family: 'driveable',
      expectedCode: 'MESSAGE_NOT_FOUND',
      expectsHttp: true,
      scenario: { kind: 'message-not-found', expectedAuthorization: PROJECT_AUTH },
      seed: { credentials: 'project' },
      tool: 'cmos_message',
      params: ({ projectRoot }) => ({
        action: 'get',
        messageId: '44444444-4444-4444-8444-444444444444',
        projectRoot,
      }),
    });
    for (const action of ['clone', 'pull'] as const) {
      await runPortableCase({
        name: `${action} has configured auth but no dashboard slug`,
        family: 'driveable',
        expectedCode: 'MISSING_PARAMETER',
        expectsHttp: false,
        scenario: noHttpScenario,
        seed: { credentials: 'project', removeSlug: true },
        tool: 'cmos_db',
        params: ({ projectRoot }) => ({ action, projectRoot }),
      });
    }

    await runPortableCase({
      name: 'register on an empty first-run root',
      family: 'first-run',
      expectedCode: 'CMOS_NOT_DETECTED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { seedProject: false },
      tool: 'cmos_project',
      params: ({ projectRoot }) => ({ action: 'register', projectRoot }),
    });
    await runPortableCase({
      name: 'health on an empty first-run root',
      family: 'first-run',
      expectedCode: 'CMOS_NOT_DETECTED',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { seedProject: false },
      tool: 'cmos_db',
      params: ({ projectRoot }) => ({ action: 'health', projectRoot }),
    });
    await runPortableCase({
      name: 'health with cmos directory but no SQLite file',
      family: 'first-run',
      expectedCode: 'DB_NOT_FOUND',
      expectsHttp: false,
      scenario: noHttpScenario,
      seed: { seedProject: false },
      setup: ({ projectRoot }) =>
        fs.mkdirSync(path.join(projectRoot, 'cmos', 'db'), { recursive: true }),
      tool: 'cmos_db',
      params: ({ projectRoot }) => ({ action: 'health', projectRoot }),
    });
  });

  afterAll(async () => {
    if (mirror?.root) resetMirroredExternalState();
    restoreExternalEnvironment();
    if (savedExternalFetch) globalThis.fetch = savedExternalFetch;
    if (externalDouble) await externalDouble.close();
  });

  it('drives every case to its named refusal with no crash or timeout', () => {
    const wrong = portableEvidence.filter(
      (entry) => entry.outcome !== 'REFUSES' || entry.code !== entry.expectedCode
    );
    for (const entry of wrong) {
      // eslint-disable-next-line no-console
      console.log(
        `  WRONG ${entry.caseName}: expected REFUSES/${entry.expectedCode}, got ${entry.outcome}/${entry.code ?? entry.thrown ?? '—'}`
      );
    }
    expect(wrong.map((entry) => entry.caseName)).toEqual([]);
  });

  it('uses loopback HTTP exactly for declared HTTP cases and never proxies an unknown route', () => {
    const transportMismatch = portableEvidence.filter(
      (entry) => entry.requests.length > 0 !== entry.expectsHttp
    );
    expect(transportMismatch.map((entry) => entry.caseName)).toEqual([]);
    const unmatchedRequests = portableEvidence.flatMap((entry) =>
      entry.requests
        .filter((request) => !request.matchedScenario)
        .map(
          (request) =>
            `${entry.caseName}: ${request.method} ${request.url} auth=${request.authorization || '<none>'}`
        )
    );
    expect(unmatchedRequests).toEqual([]);
    expect(externalTriggerFencePositiveControl).toBe(true);
    expect(blockedTriggerOutboundUrls).toEqual([]);
    expect(externalDouble.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(unknownRouteProbe.status).toBe(404);
    expect(unknownRouteProbe.body).toContain('Unstubbed dashboard route GET /never-stubbed');
    const mismatch = portableEvidence.find((entry) =>
      entry.caseName.startsWith('send advertised roots')
    );
    expect(mismatch?.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('EXTERNAL REPLAY — T2/T3/T4 apply to every reached call-bearing EXTERNAL site', () => {
    const universe = EXTERNAL.filter((row) => row.callBearing);
    const replayable = universe.filter((row) => externalFiredSites.has(row.site));
    const residual = universe.filter((row) => !externalFiredSites.has(row.site));
    const replayedSites = new Set(portableReplays.map((replay) => replay.site));
    const unstable = portableReplays.filter(
      (replay) => replay.outcome === 'CRASHES' || replay.outcome === 'TIMEOUT'
    );
    const reproduced = portableReplays.filter(
      (replay) =>
        replay.outcome === 'REFUSES' &&
        replay.code !== undefined &&
        replay.code === replay.triggerCode
    );
    const undisclosed = portableReplays.filter(
      (replay) => replay.outcome === 'REFUSES' && !disclosesCondition(replay.suggestion)
    );
    const refused = portableReplays.filter((replay) => replay.outcome === 'REFUSES');
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m08 external replay] universe=${universe.length} replayable=${replayable.length} ` +
        `residual=${residual.length} replayed-sites=${replayedSites.size} ` +
        `executions=${portableReplays.length} refused=${refused.length} ` +
        `T2-unstable=${unstable.length} ` +
        `T3-reproduced=${reproduced.length} T4-undisclosed=${undisclosed.length}`
    );
    for (const replay of reproduced) {
      // eslint-disable-next-line no-console
      console.log(
        `  EXTERNAL REMEDY REPRODUCES ${replay.code} :: ${replay.site} -> ` +
          `${replay.tool}(${replay.action ?? '—'})`
      );
    }
    expect([...replayedSites].sort()).toEqual(replayable.map((row) => row.site).sort());
    expect(residual.every((row) => EXTERNAL_RESIDUAL_REASONS[row.site])).toBe(true);
    expect(unstable).toEqual([]);
    expect(reproduced).toEqual([]);
    expect(undisclosed).toEqual([]);
  });

  it('EXTERNAL REPLAY — canonical default resolution is loopback-only and bounded', () => {
    const loginFamily = portableReplays.filter((replay) =>
      ['login', 'login_init', 'login_complete'].includes(replay.action ?? '')
    );
    const unmatched = portableReplays.flatMap((replay) =>
      replay.requests.filter((request) => !request.matchedScenario)
    );
    expect(loginFamily.length).toBeGreaterThan(0);
    expect(externalFencePositiveControls).toBeGreaterThan(0);
    expect(loginFamily.every((replay) => replay.resolverOutputs.length > 0)).toBe(true);
    expect(
      loginFamily.every((replay) =>
        replay.resolverOutputs.every((output) => output === externalDouble.origin)
      )
    ).toBe(true);
    expect(portableReplays.every((replay) => replay.durationMs < 5_000)).toBe(true);
    expect(unmatched).toEqual([]);
    expect(blockedOutboundUrls).toEqual([]);
  });

  it('EXTERNAL LEDGER — bidirectional E + R equals the re-derived universe', () => {
    const examined = [...EXTERNAL_SITES].filter((site) => externalFiredSites.has(site)).sort();
    const residual = [...EXTERNAL_SITES].filter((site) => !externalFiredSites.has(site)).sort();
    const callBearing = EXTERNAL.filter((row) => row.callBearing);
    const httpFired = new Set(
      portableEvidence
        .filter((entry) => entry.family === 'external-http')
        .flatMap((entry) => entry.fired)
        .filter((site) => EXTERNAL_SITES.has(site))
    );
    const syntheticFired = new Set(
      portableEvidence
        .filter((entry) => entry.family === 'external-synthetic')
        .flatMap((entry) => entry.fired)
        .filter((site) => EXTERNAL_SITES.has(site))
    );
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m07 external] universe=${EXTERNAL.length} examined=${examined.length} ` +
        `http=${httpFired.size} synthetic=${syntheticFired.size} residual=${residual.length} ` +
        `real-credentials=0`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m08 external replay universe] rule=EXTERNAL&&callBearing count=${callBearing.length} ` +
        `sites=${callBearing
          .map(
            (row) =>
              `${row.site}->${extractPrescribedCalls(row.text)
                .map((call) => `${call.tool}(${call.action ?? '—'})`)
                .join('+')}`
          )
          .join(',')}`
    );
    for (const site of residual) {
      // eslint-disable-next-line no-console
      console.log(
        `  EXTERNAL RESIDUAL ${site} :: ${EXTERNAL_RESIDUAL_REASONS[site] ?? '*** MISSING ***'}`
      );
    }
    expect(examined.length + residual.length).toBe(EXTERNAL.length);
    expect(residual.filter((site) => !EXTERNAL_RESIDUAL_REASONS[site])).toEqual([]);
    expect(
      Object.keys(EXTERNAL_RESIDUAL_REASONS).filter((site) => !residual.includes(site))
    ).toEqual([]);
    expect([...httpFired].sort()).toEqual([...HTTP_EXTERNAL_SITES].sort());
    expect([...syntheticFired].sort()).toEqual([...SYNTHETIC_EXTERNAL_SITES].sort());
    expect([...httpFired].filter((site) => syntheticFired.has(site))).toEqual([]);
    expect(HTTP_EXTERNAL_SITES.size + SYNTHETIC_EXTERNAL_SITES.size + residual.length).toBe(
      EXTERNAL.length
    );
    expect(callBearing.length).toBeGreaterThan(0);
  });

  it('FIRST-RUN LEDGER — E + R equals its re-derived in-process universe with zero wire credit', () => {
    const examined = [...FIRST_RUN_SITES].filter((site) => externalFiredSites.has(site)).sort();
    const residual = [...FIRST_RUN_SITES].filter((site) => !externalFiredSites.has(site)).sort();
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m07 first-run] universe=${FIRST_RUN.length} examined=${examined.length} residual=${residual.length} ` +
        `scope=in-process-mirror wire-credit=0 (wire owner: s90-m04)`
    );
    expect(examined.length + residual.length).toBe(FIRST_RUN.length);
    expect(residual).toEqual([]);
  });

  it('allows one explicit-intent read; every effective dashboard URL uses the canonical resolver', () => {
    const syntheticSource = ts.createSourceFile(
      'synthetic-dashboard-url-reads.ts',
      `
        process.env.CMOS_DASHBOARD_URL;
        process.env['CMOS_DASHBOARD_URL'];
        process.env[CMOS_DASHBOARD_URL_ENV];
        { const { CMOS_DASHBOARD_URL } = process.env; void CMOS_DASHBOARD_URL; }
        { const { CMOS_DASHBOARD_URL: aliased } = process.env; void aliased; }
        { const { [CMOS_DASHBOARD_URL_ENV]: computed } = process.env; void computed; }
        { const { ['CMOS_DASHBOARD_URL']: literalComputed } = process.env; void literalComputed; }
      `,
      ts.ScriptTarget.ES2020,
      true
    );
    const syntheticReads = directDashboardUrlReadsInSource(
      'src/synthetic-dashboard-url-reads.ts',
      syntheticSource
    );
    expect(syntheticReads).toHaveLength(7);
    expect(syntheticReads.filter((read) => read.syntax === 'dot')).toHaveLength(1);
    expect(syntheticReads.filter((read) => read.syntax === 'element')).toHaveLength(2);
    expect(syntheticReads.filter((read) => read.syntax === 'destructure')).toHaveLength(4);
    expect(syntheticReads.filter((read) => read.canonical)).toEqual([]);

    const reads = directDashboardUrlReads();
    const canonical = reads.filter((read) => read.canonical);
    const bypasses = reads.filter((read) => !read.canonical);
    // This startup check asks whether the operator EXPLICITLY opted into dashboard warnings; it
    // deliberately does not ask for the effective URL, whose baked default would make every local-
    // only install warn. All network/display consumers must go through the canonical resolver.
    const explicitIntentReads = new Set(['src/auth/project-key-capture.ts']);
    // eslint-disable-next-line no-console
    console.log(
      `[s90-m07 dashboard-url reads] total=${reads.length} canonical=${canonical.length} ` +
        `bypasses=${bypasses.length} :: ${reads.map((read) => `${read.site}[${read.syntax}]`).join(' ')}`
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.site.startsWith('src/tools/cmos/dashboard-client.ts:')).toBe(true);
    expect(bypasses.map((read) => read.site.replace(/:\d+$/, '')).sort()).toEqual(
      [...explicitIntentReads].sort()
    );
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
    let boundary!: IsolatedDashboardBoundary;

    beforeAll(async () => {
      boundary = await installIsolatedDashboardBoundary('s89m08-t6');
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

    afterAll(async () => boundary?.close());

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

    it('T1/T6 (HARD) — untouched actions cannot escape isolated credentials or loopback', () => {
      expect(boundary.blockedUrls).toEqual([]);
      expect(boundary.positiveControlBlocked).toBe(true);
      expect(boundary.double.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(path.dirname(boundary.sourceCredentialPath)).toBe(boundary.configDir);
      expect(fs.realpathSync(boundary.configDir).startsWith(fs.realpathSync(os.tmpdir()))).toBe(
        true
      );
    });

    it('every APPLICABLE wrong-typed value is refused as INVALID_PARAMETER naming the field', () => {
      expect(unguardedApplicable).toEqual([]);
    });

    it('the guard is SCOPED to the action, and that scope still covers every crashing triple', () => {
      // s90-m02. The old arm claimed to test the guard in both directions but only filtered the
      // static applicability table. This arm drives the guard itself. Deleting the guard's
      // applicable-set `continue` must make `overBroad` non-empty; removing or narrowing the guard
      // must make `missed` or `uncoveredHistorical` non-empty.
      const refusedKeys = new Set<string>();
      const malformedRefusals: string[] = [];
      for (const triple of triples) {
        const schema = CMOS_TOOL_DEFINITIONS.find((tool) => tool.name === triple.tool)!.inputSchema;
        const params: Record<string, unknown> = { [triple.field]: 12_345 };
        if (triple.action !== undefined) params.action = triple.action;
        const refusal = findWrongTypedStringParam(schema, applicableParamsFor(triple), params);
        if (refusal === null) continue;
        const key = `${triple.tool}|${triple.action ?? ''}|${triple.field}`;
        refusedKeys.add(key);
        if (refusal.code !== 'INVALID_PARAMETER' || refusal.field !== triple.field) {
          malformedRefusals.push(`${key} -> ${refusal.code} field=${String(refusal.field)}`);
        }
      }

      const applicableKeys = new Set(
        triples
          .filter(appliesToAction)
          .map((triple) => `${triple.tool}|${triple.action ?? ''}|${triple.field}`)
      );
      const overBroad = [...refusedKeys].filter((key) => !applicableKeys.has(key));
      const missed = [...applicableKeys].filter((key) => !refusedKeys.has(key));
      const uncoveredHistorical = HISTORICALLY_CRASHING.filter((key) => !refusedKeys.has(key));
      // eslint-disable-next-line no-console
      console.log(
        `[s90-m02 T6 scope] triples=${triples.length} refused-by-guard=${refusedKeys.size} ` +
          `declared-applicable=${applicableKeys.size} over-broad=${overBroad.length} ` +
          `missed=${missed.length} historically-crashing=${HISTORICALLY_CRASHING.length} ` +
          `uncovered-historical=${uncoveredHistorical.length}`
      );
      expect(refusedKeys.size).toBeGreaterThan(0);
      expect(refusedKeys.size).toBeLessThan(triples.length);
      expect(malformedRefusals).toEqual([]);
      expect(overBroad).toEqual([]);
      expect(missed).toEqual([]);
      expect(uncoveredHistorical).toEqual([]);
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

  // ── CONSTRUCTION-MASKED PRECONDITIONS inside a VALIDATION/STATE-coded site ───────────────────
  // Driveable by CODE, but dispatcher and collab gates mask the triggers from every supported
  // construction the portable m07 instrument can establish. Four former entries moved to E.
  'src/tools/cmos/cmos-message.ts:1004':
    'A defensive branch whose own message says the dispatcher should have caught the condition via ' +
    'resolveSenderContext. Reaching it means reaching a state the dispatcher forbids.',
  'src/tools/cmos/sync-mutable-push.ts:111':
    'The missing-entityId refusal inside pushMutableStatus. Its only caller chain runs through ' +
    'maybePropagateMutableStatus, which early-returns unless isCollabStore(db) — so a solo store ' +
    'never enters the function at all, and a collab store needs a broker.',
  'src/tools/cmos/sync-mutable-push.ts:155':
    'Same collab-store gate as :111, one branch later on slug resolution.',
  // ── MASKED BY AN EARLIER REFUSAL ON EVERY PATH THIS MATRIX CAN DRIVE ─────────────────────────
  'src/tools/cmos/cmos-sprint-complete.ts:574':
    'MEASURED: masked. With master_context deleted and the sprint made closable, closeout refuses at ' +
    'the shared errors.ts contextNotFound BEFORE reaching this sprint-local branch, so :574 is ' +
    'unreachable while that earlier guard stands.',
  'src/tools/cmos/cmos-sprint-complete.ts:585': 'Same masking as :574, for project_context.',
};

const FAULT_SHAPED_DRIVEABLE_RESIDUALS = new Set([
  'src/tools/cmos/client.ts:671',
  'src/tools/cmos/client.ts:682',
  'src/tools/cmos/cmos-context-project-identity.ts:57',
  'src/tools/cmos/cmos-context-project-identity.ts:116',
]);
const INTERNAL_FAULT_RESUME_TRIGGER =
  'any one of these codes reported from the field by an external adopter, or any in-repo incident that reaches one on a healthy store.';
const MASKED_RESUME_TRIGGER =
  'any production caller or control-flow change that makes one of these sites constructible, or any field report or in-repo incident that reaches one on a healthy store.';

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
    let boundary!: IsolatedDashboardBoundary;

    beforeAll(async () => {
      mirror = buildSuggestionMirror();
      sink = installSuggestionSink();
      sink.reset();
      mirrorRouters = loadMirrorRouters();
      boundary = await installIsolatedDashboardBoundary('s89m08-private');

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
      // m07's portable double is evidence for reachability only. It does NOT widen T2/T3/T4:
      // remedy replay remains exactly the private matrix pass above.
      const fired = new Set([...sink.fired, ...externalFiredSites]);
      examinedDriveable = [...DRIVEABLE_SITES].filter((site) => fired.has(site)).sort();
      residualDriveable = [...DRIVEABLE_SITES].filter((site) => !fired.has(site)).sort();
    });

    afterAll(async () => boundary?.close());

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

    it('T1 (HARD) — private replay transport and credentials stay inside isolated loopback state', () => {
      expect(boundary.blockedUrls).toEqual([]);
      expect(boundary.positiveControlBlocked).toBe(true);
      expect(boundary.double.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(path.dirname(boundary.sourceCredentialPath)).toBe(boundary.configDir);
      expect(path.dirname(boundary.mirrorCredentialPath!)).toBe(boundary.configDir);
      expect(fs.realpathSync(boundary.configDir).startsWith(fs.realpathSync(os.tmpdir()))).toBe(
        true
      );
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
          `outside-driveable-examined=${CENSUS.length - examinedDriveable.length} (not Arc debt)`
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

    it('ARC F ITEM 1 ROUTER ADJUDICATION — partitions every authored site with zero wire credit', () => {
      const sorted = (sites: Iterable<string>): string[] => [...sites].sort();
      const intersection = (left: Set<string>, right: Set<string>): Set<string> =>
        new Set([...left].filter((site) => right.has(site)));
      const difference = (left: Set<string>, right: Set<string>): Set<string> =>
        new Set([...left].filter((site) => !right.has(site)));
      const examinedExternal = [...EXTERNAL_SITES].filter((site) => externalFiredSites.has(site));
      const residualExternal = [...EXTERNAL_SITES].filter((site) => !externalFiredSites.has(site));
      const examinedFirstRun = [...FIRST_RUN_SITES].filter((site) => externalFiredSites.has(site));
      const residualFirstRun = [...FIRST_RUN_SITES].filter((site) => !externalFiredSites.has(site));
      const preAdjudicationCandidates = new Set([
        ...DRIVEABLE_SITES,
        ...EXTERNAL_SITES,
        ...FIRST_RUN_SITES,
      ]);
      const routerExamined = new Set([
        ...examinedDriveable,
        ...examinedExternal,
        ...examinedFirstRun,
      ]);
      const adjudicatedUnreachable = new Set([
        ...residualDriveable,
        ...residualExternal,
        ...residualFirstRun,
      ]);
      const nonFirstRunFaults = CENSUS.filter(
        (row) => row.triggerClass === 'FAULT' && !FIRST_RUN_SITES.has(row.site)
      ).map((row) => row.site);
      const faultShapedDriveable = residualDriveable.filter((site) =>
        FAULT_SHAPED_DRIVEABLE_RESIDUALS.has(site)
      );
      const constructionMasked = [
        ...residualDriveable.filter((site) => !FAULT_SHAPED_DRIVEABLE_RESIDUALS.has(site)),
        ...residualExternal,
        ...CENSUS.filter((row) => row.triggerClass === 'UNTYPED').map((row) => row.site),
      ];
      const internalFaultPark = new Set([...nonFirstRunFaults, ...faultShapedDriveable]);
      const maskedPark = new Set(constructionMasked);
      const parkedComplement = new Set([...internalFaultPark, ...maskedPark]);
      const authoredSites = new Set(CENSUS.map((row) => row.site));

      expect(preAdjudicationCandidates.size).toBe(
        DRIVEABLE_SITES.size + EXTERNAL_SITES.size + FIRST_RUN_SITES.size
      );
      expect(sorted(intersection(routerExamined, adjudicatedUnreachable))).toEqual([]);
      expect(sorted(new Set([...routerExamined, ...adjudicatedUnreachable]))).toEqual(
        sorted(preAdjudicationCandidates)
      );
      expect(routerExamined.size + adjudicatedUnreachable.size).toBe(
        preAdjudicationCandidates.size
      );
      expect(residualFirstRun).toEqual([]);
      expect(sorted(faultShapedDriveable)).toEqual(sorted(FAULT_SHAPED_DRIVEABLE_RESIDUALS));
      expect(sorted(intersection(internalFaultPark, maskedPark))).toEqual([]);
      expect(sorted(intersection(routerExamined, parkedComplement))).toEqual([]);
      expect(sorted(new Set([...routerExamined, ...parkedComplement]))).toEqual(
        sorted(authoredSites)
      );
      expect(routerExamined.size + parkedComplement.size).toBe(authoredSites.size);
      expect(sorted(intersection(preAdjudicationCandidates, parkedComplement))).toEqual(
        sorted(adjudicatedUnreachable)
      );
      expect(sorted(difference(parkedComplement, adjudicatedUnreachable))).toEqual(
        sorted(difference(authoredSites, preAdjudicationCandidates))
      );

      // eslint-disable-next-line no-console
      console.log(
        `[s90-m08 Arc F router adjudication] pre-adjudication-candidates=${preAdjudicationCandidates.size} ` +
          `router-examined=${routerExamined.size} adjudicated-unreachable=${adjudicatedUnreachable.size} ` +
          `partition=${routerExamined.size}+${adjudicatedUnreachable.size}; ` +
          `first-run-router-examined=${examinedFirstRun.length} wire-credit=0`
      );
      // eslint-disable-next-line no-console
      console.log(
        `[s90-m08 Arc F authored partition] authored=${authoredSites.size} ` +
          `router-examined=${routerExamined.size} parked-complement=${parkedComplement.size} ` +
          `partition=${routerExamined.size}+${parkedComplement.size}; ` +
          `internal-fault=${internalFaultPark.size} construction-masked=${maskedPark.size}`
      );
      // eslint-disable-next-line no-console
      console.log(`[s90-m08 #1127 internal-fault resume trigger] ${INTERNAL_FAULT_RESUME_TRIGGER}`);
      // eslint-disable-next-line no-console
      console.log(`[s90-m08 masked resume trigger] ${MASKED_RESUME_TRIGGER}`);
      // eslint-disable-next-line no-console
      console.log(
        '[s90-m08 closure commands] CMOS_DASHBOARD_URL=http://127.0.0.1:9 npx jest ' +
          'tests/tools/cmos/suggestion-oracle.test.ts --runInBand --coverage=false; ' +
          'npx jest --config jest.e2e.config.js --runInBand tests/e2e/wire-preflight.e2e.ts'
      );
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
    // Scratch placement is deliberately stricter than identity detection: avoid every mirror
    // exclusion, including untracked leak guards, so a future tracking change stays harmless.
    expect(MIRROR_ROOT.startsWith(path.join(REPO_ROOT, 'tmp'))).toBe(false);
    const exclusions = readMirrorExclusions().all;
    for (const marker of exclusions) {
      expect(path.relative(REPO_ROOT, MIRROR_ROOT).split(path.sep)[0]).not.toBe(marker);
    }
    const realTemp = fs.realpathSync(os.tmpdir());
    const isDescendant = (parent: string, candidate: string): boolean => {
      const relative = path.relative(parent, candidate);
      return (
        relative.length > 0 &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    };
    expect(externalScratchRoots.size).toBeGreaterThan(0);
    for (const scratchRoot of externalScratchRoots) {
      expect(isDescendant(realTemp, scratchRoot)).toBe(true);
      expect(isDescendant(REPO_ROOT, scratchRoot)).toBe(false);
      for (const marker of exclusions) {
        expect(path.relative(REPO_ROOT, scratchRoot).split(path.sep)[0]).not.toBe(marker);
      }
    }
    expect(externalCredentialPaths.size).toBeGreaterThan(0);
    for (const credentialPath of externalCredentialPaths) {
      expect(isDescendant(realTemp, credentialPath)).toBe(true);
      expect(isDescendant(path.join(os.homedir(), '.config'), credentialPath)).toBe(false);
      expect(externalCredentialModes.get(credentialPath)).toBe(0o600);
      expect(externalCredentialResolutions.get(credentialPath)).toBe(credentialPath);
    }
  });
});
