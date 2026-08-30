// SPDX-License-Identifier: Apache-2.0
// ABOUTME: One schema-driven boundary guard for wrong-typed published string parameters.
// ABOUTME: Scoped to the parameters the ACTION actually applies to, per the published contract.

import { CmosErrors } from './errors';
import type { CmosToolError } from './types';

/**
 * s89-m08 — THE CLASS, AND WHY IT IS GUARDED IN ONE PLACE.
 *
 * `@modelcontextprotocol/sdk` types tool arguments as `z.record(z.string(), z.unknown())` and
 * `src/index.ts` forwards `request.params.arguments` to the routers with NO per-tool inputSchema
 * validation. So a client can legally put a JSON number where the published schema declares
 * `type: "string"`, and the value reaches an unguarded `String.prototype` method or `path.resolve`
 * and THROWS. The thrown call is then dressed by the catch-all boundary as `TOOL_EXECUTION_ERROR`
 * with the suggestion *"This is an internal error, not an input-validation problem — retry the
 * call"*: a false cause and a remedy that is a loop with no exit.
 *
 * MEASURED, over every (tool, valid action, declared-string-parameter) triple x five wrong JSON
 * types = 714 triples / 3,570 router calls (decision #1117, `tmp/s89-m08-baseline.ts`):
 *
 *   CRASH 42   SUCCEED 236   REFUSE 436   TIMEOUT 0      (total and disjoint, sum 714)
 *
 * The ratified figure entering the mission was 25. All 25 reproduce; 17 more were never swept,
 * and every one of them is the `projectRoot` field itself — those throw
 * `The "paths[0]" argument must be of type string` from `path.resolve`, not
 * `<param>.trim is not a function`, which is why a throw-message-shaped predicate missed them.
 * Guarding per-handler would have regrown that list: there are 186 `.trim()` call sites in src/
 * and no reliable static receiver-to-schema mapping. ONE guard is the whole point (learning #364).
 *
 * ── WHY THE GUARD IS SCOPED TO THE ACTION'S OWN PARAMETERS (s89-m09) ───────────────────────────
 *
 * The first cut of this guard refused a wrong-typed value on EVERY declared string property of the
 * tool, whether or not the action reads it. That is defensible on the letter of the schema, and it
 * is far too blunt in practice: measured, it converted 210 of the 714 triples from SUCCESS to
 * INVALID_PARAMETER, and 179 of those 210 were parameters the action never looks at.
 * `cmos_message(action="whoami", body=12345)` is the representative case — `whoami` has no use for
 * `body`, the call did exactly what the caller wanted, and failing it buys nothing.
 *
 * The guard is therefore scoped by `CMOS_*_ACTION_PARAMS`, the per-action applicability contract
 * s86-m04 authored. That contract is not an allowlist bolted on here: it is PUBLISHED as the
 * per-action tables in TOOL_REFERENCE.md, CONSUMED by the reference renderer, and CHECKED IN BOTH
 * DIRECTIONS by `tests/tools/cmos/action-params.test.ts` — every entry must be something the router
 * demonstrably does with that key, and every published key must be claimed by some action. The
 * "a (tool, action) -> parameter map would drift from the schema" objection does not apply to a map
 * that is itself gated against the schema in both directions.
 *
 * MEASURED EFFECT OF THE NARROWING, which is why it is the right call rather than merely a softer
 * one: all 42 CRASH triples are still covered — ZERO missed, because a parameter that crashes the
 * handler is by construction a parameter the handler reads — while the SUCCESS-to-error blast
 * radius drops from 210 triples to 31.
 *
 * AND THE 31 THAT REMAIN ARE THE ONES WORTH KEEPING. Every one is a parameter the action genuinely
 * consumes, and silently ignoring it produces a WRONG ANSWER rather than a harmless no-op:
 * `cmos_learnings(action="list", category=12345)` and `cmos_decisions(action="list", since=12345)`
 * returned an UNFILTERED result set that the caller had every reason to read as filtered. Refusing
 * those is the fix, not the collateral.
 *
 * WHY JSON `null` IS PASSED THROUGH RATHER THAN REFUSED — answered from the measurement rather
 * than from taste. `null` CRASHES at 0 of the 714 triples. It REFUSES at 476 and SUCCEEDS at 238.
 * It is therefore NOT a member of the defect class this guard exists to close, and refusing it
 * would convert 238 currently-working calls into errors to fix a fault it does not cause — while
 * breaking every client whose JSON serializer emits `null` for an absent optional field, which is
 * a very common shape. `null` is treated exactly as absent.
 *
 * THIS MODULE AUTHORS NO `suggestion:` LITERAL (s89-m08 fold 4). It returns
 * `CmosErrors.invalidParameter`, whose own `validValues` branch owns the only suggestion string
 * involved — the same way `cmos-learnings-search.ts` and `cmos-decisions-search.ts` already pass a
 * described expectation rather than an enum. So the Arc F denominator of 181 authored sites is
 * unchanged by this file.
 */

interface StringSchemaProperty {
  readonly type?: unknown;
  readonly enum?: unknown;
}

interface ToolInputSchemaLike {
  readonly properties?: Readonly<Record<string, StringSchemaProperty | undefined>>;
}

/** What a `type: "string"` property will accept, phrased for the caller that got it wrong. */
function expectationFor(property: StringSchemaProperty): string[] {
  return Array.isArray(property.enum) && property.enum.length > 0
    ? property.enum.map(String)
    : ['a JSON string'];
}

/**
 * The first published `type: "string"` property that the ACTION APPLIES TO and that arrived as a
 * non-string, non-null, non-undefined JSON value — or `null` when the request is type-clean.
 *
 * @param inputSchema      the tool's own shipped `inputSchema`.
 * @param applicableParams the parameter names this action applies to, from the tool's own
 *                         `CMOS_*_ACTION_PARAMS` entry. Pass `undefined` for an ACTION-LESS tool
 *                         (`cmos_agent_onboard`, `cmos_status`, `cmos_review`), where every
 *                         published parameter applies. An unknown action also yields `undefined`
 *                         and is guarded in full, which fails safe — though the routers reject an
 *                         unknown action before reaching here.
 *
 * Property order is the shipped schema's own declaration order, so the same malformed request
 * always names the same field and the refusal is reproducible.
 */
export function findWrongTypedStringParam(
  inputSchema: unknown,
  applicableParams: readonly string[] | undefined,
  params: unknown
): CmosToolError | null {
  const properties = (inputSchema as ToolInputSchemaLike | undefined)?.properties;
  if (!properties || typeof params !== 'object' || params === null) return null;
  const provided = params as Record<string, unknown>;
  const applicable = applicableParams ? new Set(applicableParams) : undefined;

  for (const [name, property] of Object.entries(properties)) {
    if (!property || property.type !== 'string') continue;
    if (applicable && !applicable.has(name)) continue;
    if (!Object.prototype.hasOwnProperty.call(provided, name)) continue;
    const value = provided[name];
    // `undefined` is absent. `null` is absent too — see the null rationale above; it is measured,
    // not assumed.
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') continue;
    return CmosErrors.invalidParameter(name, value, expectationFor(property));
  }
  return null;
}
