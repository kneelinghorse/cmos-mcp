// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Every LEAF format*ForLLM render path must render the ENVELOPE warning channel.
// ABOUTME: AST-derived candidate, dispatcher, error-preamble, and return-dominance rules; no allowlist.

/**
 * Sprint 86 m02 — make the warnings channel real.
 *
 * `CmosToolResult.warnings` (types.ts:84) is written by `createSuccess` (errors.ts:147-158) and
 * shipped to the agent inside `structuredContent`. But an agent reads `content[0].text`, which is
 * the output of a `format*ForLLM` function (src/index.ts:609-614) — so a formatter that never
 * reads `result.warnings` makes the warning UNREADABLE in practice even though it is present in
 * the payload. s85-m04's `missionId` supply-lever advisory has been shipping invisible since
 * 2.5.0 for exactly this reason.
 *
 * MEASURED RED BASELINE (2026-08-11, before the fix): **57** leaves rendered nothing on the
 * envelope channel — 52 exported plus 5 module-private. 14 already rendered it (13 exported +
 * formatWhoamiForLLM), and 4 rendered only the DATA-level `result.data.warnings`.
 *
 * Two earlier figures are superseded, and both are recorded here so neither is re-litigated:
 *   - The build doc's **53** counted only the 79 EXPORTED formatters, so it never enumerated the
 *     7 module-private ones in cmos-message.ts (5 of which rendered nothing) — and it counted
 *     formatSyncHealthForLLM twice over, once as "renders nothing" and again as the structural
 *     exclusion. It cannot render the envelope; it has none. 53 - 1 + 5 = 57.
 *   - Decision #978's **58** corrected the first omission but inherited that double-count.
 * The measured number wins (success criterion 3).
 *
 * s88-m09 RETURN-PATH CENSUS (2026-08-28). The old backlog shape count — "70 of 76 leaf
 * formatters have >1 terminal return but only one appendWarnings" — did not measure coverage:
 * one append can dominate every success return, and a second return can be a deliberate
 * INVALID_ACTION/error preamble. The executable rule below supersedes that shape heuristic while
 * preserving the s86 baseline above. Fresh census: 87 declarations / 10 dispatchers / 77 leaves /
 * 1 non-envelope structural exclusion / 86 envelope formatters (76 leaves + 10 dispatchers).
 * Their 265 owned terminal returns classify structurally as 91 deliberate `!result.success`
 * error preambles, 71 direct delegations, and 103 genuine render modes. The dispatcher-aware RED
 * was 93/103 genuine returns warning-dominated; the fixed contract is 103/103. The 10 extra final
 * error preambles are the explicit failure halves split out of the former mixed dispatcher
 * fallback ternaries; that source rewrite is why the final denominator is 265 rather than the
 * pre-fix RED's 255.
 *
 * DISCRIMINATION IS BY RULE, NOT BY ALLOWLIST (Process Hardening #2). This file contains no
 * allowlist of exempt formatters. Three rules do all the work:
 *
 *   1. CANDIDATE   — a function DECLARATION named /^format.*ForLLM$/ under src/tools/cmos/.
 *                    Declarations, not exports: the 7 private cmos-message.ts formatters are
 *                    reached by real calls and must render like any other leaf. Scoping the
 *                    sweep to exported names would report GREEN while every cmos_message answer
 *                    except whoami stayed fail-quiet — a gate that is green about a dead channel,
 *                    which is the defect class this sprint exists to close.
 *   2. DISPATCHER  — has >= 1 `return` whose expression is a direct call to another format*ForLLM
 *                    DECLARED IN THE MODULE, where "the module" is src/tools/cmos as a whole, not
 *                    the single file: nine of the ten routers delegate to formatters they IMPORT
 *                    (cmos-session.ts -> cmos-session-start.ts), and a per-file sibling set
 *                    selects exactly ONE of them. The callee need NOT be exported: requiring that
 *                    selects nine and misses formatMessageForLLM, whose seven delegates are all
 *                    private. Direct delegations are exempt so a warning renders EXACTLY ONCE at
 *                    the leaf; the dispatcher itself is NOT wholesale exempt. Its INVALID_ACTION
 *                    and explicit failure returns classify as error preambles, while each
 *                    non-delegating success fallback must render. Do NOT restate this as "EVERY
 *                    return is a delegating call" — measured, zero formatters satisfy that.
 *   3. LEAF        — everything else. A leaf must call `appendWarnings`, UNLESS it takes no
 *                    `CmosToolResult` parameter at all, in which case it is a STRUCTURAL
 *                    EXCLUSION and this file PRINTS IT BY NAME rather than skipping it silently.
 *
 * The envelope parameter is located BY TYPE, never by position: of the 87 declarations, 74 take it
 * at index 0, 12 at index 1 (the `(action, result)` router-leaf shape), and 1 not at all. A
 * positional rule would silently exempt those 12. (Decision #978's 66/12 split counted only the 78
 * EXPORTED declarations that have an envelope; the 7 private cmos-message formatters all take it
 * at index 0, and 66 + 7 = 73. s86-m08 then added one exported index-0 formatter, producing the
 * current 74/12/1 split.) `locateEnvelopeParam` is exercised against both shapes below.
 *
 * FALSE-NEGATIVE PROFILE (what this gate CANNOT see — stated so the green is honest):
 *   - SYNTACTIC DOMINANCE, NOT A CONTROL-FLOW GRAPH. Every genuine return now requires a direct
 *     earlier `appendWarnings` statement in its block or an ancestor block AND that specific
 *     return must join the append's buffer; a later return of the right buffer cannot rescue an
 *     earlier return of a different one. A call after an early return or hidden in a conditional
 *     no longer passes. The rule can still false-RED a logically dominating helper/conditional,
 *     so the shipped convention stays a direct append statement. It deliberately does not require
 *     appendWarnings to be the final statement: cmos-session-start.ts renders warnings mid-body
 *     and pushes more lines afterward.
 *   - INDIRECTION. `appendWarnings` located by callee IDENTIFIER text. A formatter that wraps it
 *     in a local helper, or calls it through an alias, reads as not calling it (false RED, which
 *     is safe) — but a formatter that calls a DIFFERENT function named `appendWarnings` would
 *     read as calling it (false GREEN).
 *   - EMPTY-SINK. It cannot prove the warning was ever PUSHED. A handler that never populates
 *     result.warnings renders nothing and passes. The write side is s86-m02b's job.
 *   - DYNAMIC DISPATCH. A formatter reached only through a computed reference is neither
 *     classified as a dispatcher's delegate nor excluded — it is simply a leaf, which is the
 *     conservative reading.
 *   - SCOPE. src/tools/cmos/ only. A format*ForLLM declared elsewhere in src/ is not swept.
 *     Verified empty at 2026-08-11 (`grep -rn 'function format.*ForLLM' src --include=*.ts` is
 *     wholly inside src/tools/cmos/), and asserted below so it cannot drift unnoticed.
 *   - THE NAMING CONVENTION IS THE SWEEP. Candidates are chosen by name, so a renderer named off
 *     the convention is invisible here. s86-m02 created four deliberately: formatAuthForLLM,
 *     formatConstraintsForLLM, formatNextStepsForLLM and formatFeedbackForLLM each return one
 *     short string per action branch, so threading appendWarnings through every branch would mean
 *     dozens of call sites and dozens of chances to miss one. Each is now a thin tail over a
 *     private `render*Body` holding the original branches, and the tail — which the gate DOES
 *     see — renders the channel once for every branch. The exposure is that a future author could
 *     hide a real renderer the same way; that is a review concern, not something an AST rule over
 *     a naming convention can catch.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { formatContextForLLM } from '../../../src/tools/cmos/cmos-context';
import { formatDbForLLM } from '../../../src/tools/cmos/cmos-db';
import { formatDecisionsForLLM } from '../../../src/tools/cmos/cmos-decisions';
import { formatLearningsForLLM } from '../../../src/tools/cmos/cmos-learnings';
import { formatMissionForLLM } from '../../../src/tools/cmos/cmos-mission';
import { formatMissionTransitionForLLM } from '../../../src/tools/cmos/cmos-mission-transition';
import { formatProjectForLLM } from '../../../src/tools/cmos/cmos-project';
import { formatSessionForLLM } from '../../../src/tools/cmos/cmos-session';
import { formatSprintForLLM } from '../../../src/tools/cmos/cmos-sprint';
import { formatMessageForLLM } from '../../../src/tools/cmos/cmos-message';
import { formatSyncPullForLLM } from '../../../src/tools/cmos/sync-pull';
import { formatSyncHealthForLLM } from '../../../src/tools/cmos/sync-health-check';

const CMOS_ROOT = path.resolve(__dirname, '../../../src/tools/cmos');
const SRC_ROOT = path.resolve(__dirname, '../../../src');

/** Census figures ratified in decision #978. A drift here is a real change, not a nit. */
// s86-m08: 86 -> 87 and 76 -> 77 — formatMissionMoveForLLM (cmos-mission-move.ts), the one
// formatter this mission adds. It is a LEAF (it delegates to no other format*ForLLM), so both
// the declaration count and the leaf count move by exactly one and the dispatcher count is
// unchanged at 10.
const EXPECTED_DECLARATIONS = 87;
const EXPECTED_DISPATCHERS = 10;
const EXPECTED_LEAVES = 77;
/** The one leaf with no CmosToolResult parameter — reported by name, never skipped silently. */
const STRUCTURAL_EXCLUSION = 'formatSyncHealthForLLM';

const FORMATTER_NAME = /^format.*ForLLM$/;

interface Formatter {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly decl: ts.FunctionDeclaration;
}

function listTsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listTsFiles(full);
      return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
        ? [full]
        : [];
    })
    .sort();
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
}

/** Every `function format*ForLLM(...)` declaration in one source file — exported or not. */
function collectFormatters(sourceFile: ts.SourceFile, label: string): Formatter[] {
  const found: Formatter[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && FORMATTER_NAME.test(node.name.text)) {
      found.push({
        name: node.name.text,
        file: label,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        decl: node,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * RULE 2. True when the body has at least one `return <identifier>(...)` whose callee is a
 * format*ForLLM declared anywhere in the module (src/tools/cmos), imported or local.
 */
function isDispatcher(decl: ts.FunctionDeclaration, siblingNames: ReadonlySet<string>): boolean {
  let delegating = false;
  const visit = (node: ts.Node): void => {
    if (delegating) return;
    if (ts.isReturnStatement(node) && node.expression && ts.isCallExpression(node.expression)) {
      const callee = node.expression.expression;
      if (ts.isIdentifier(callee) && siblingNames.has(callee.text)) {
        delegating = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(decl, visit);
  return delegating;
}

/** A dispatcher return delegated to another formatter, and therefore rendered by that callee. */
function isDelegatingReturn(
  statement: ts.ReturnStatement,
  siblingNames: ReadonlySet<string>
): boolean {
  if (!statement.expression || !ts.isCallExpression(statement.expression)) return false;
  const callee = statement.expression.expression;
  return ts.isIdentifier(callee) && siblingNames.has(callee.text);
}

/**
 * Locate the envelope parameter BY TYPE. Returns its index, or -1 when the signature carries no
 * `CmosToolResult` at all (the structural-exclusion case). Matching is on the type NODE, so it
 * finds `CmosToolResult<X>`, a bare `CmosToolResult`, and a union containing one — at whatever
 * position it sits.
 */
export function locateEnvelopeParam(decl: ts.FunctionDeclaration): number {
  return decl.parameters.findIndex((param) => {
    if (!param.type) return false;
    let hit = false;
    const visit = (node: ts.Node): void => {
      if (hit) return;
      if (ts.isTypeReferenceNode(node)) {
        const name = ts.isQualifiedName(node.typeName)
          ? node.typeName.right.text
          : node.typeName.text;
        if (name === 'CmosToolResult') {
          hit = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(param.type);
    return hit;
  });
}

/** Every `appendWarnings(...)` call in a body. */
function appendWarningsCalls(decl: ts.FunctionDeclaration): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'appendWarnings'
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(decl, visit);
  return calls;
}

/** True when the body calls `appendWarnings(...)` anywhere. */
function callsAppendWarnings(decl: ts.FunctionDeclaration): boolean {
  return appendWarningsCalls(decl).length > 0;
}

/** Return statements owned by this formatter, excluding returns inside nested callbacks. */
function ownedReturns(decl: ts.FunctionDeclaration): ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== decl) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  if (decl.body) ts.forEachChild(decl.body, visit);
  return returns;
}

function containsNode(container: ts.Node, target: ts.Node): boolean {
  return container.pos <= target.pos && target.end <= container.end;
}

/**
 * Deliberate error preambles are classified by effect, not by line or formatter name: a return
 * in the THEN branch of an `if` that tests `!<envelope>.success`. A successful empty/no-op mode
 * does not match this rule and therefore still has to render warnings.
 */
function isErrorPreambleReturn(
  decl: ts.FunctionDeclaration,
  statement: ts.ReturnStatement,
  envelopeName: string
): boolean {
  for (let current = statement.parent; current && current !== decl; current = current.parent) {
    if (!ts.isIfStatement(current) || !containsNode(current.thenStatement, statement)) continue;
    let testsFailure = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isPropertyAccessExpression(node.operand) &&
        ts.isIdentifier(node.operand.expression) &&
        node.operand.expression.text === envelopeName &&
        node.operand.name.text === 'success'
      ) {
        testsFailure = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(current.expression);
    if (testsFailure) return true;
  }
  return false;
}

interface WarningAppend {
  readonly call: ts.CallExpression;
  readonly sink: string;
}

function directEnvelopeWarningAppend(
  statement: ts.Statement,
  envelopeName: string
): WarningAppend | undefined {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isCallExpression(statement.expression) ||
    !ts.isIdentifier(statement.expression.expression) ||
    statement.expression.expression.text !== 'appendWarnings'
  ) {
    return undefined;
  }
  const [sink] = statement.expression.arguments;
  if (
    !sink ||
    !ts.isIdentifier(sink) ||
    !statement.expression.arguments.some(
      (argument) => ts.isIdentifier(argument) && argument.text === envelopeName
    )
  ) {
    return undefined;
  }
  return { call: statement.expression, sink: sink.text };
}

/**
 * Conservative dominance rule: collect direct appendWarnings calls that are earlier statements
 * in this return's block or in an ancestor block. Calls hidden in a conditional do not count.
 */
function dominatingWarningAppends(
  decl: ts.FunctionDeclaration,
  statement: ts.ReturnStatement,
  envelopeName: string
): WarningAppend[] {
  const appends: WarningAppend[] = [];
  let child: ts.Node = statement;
  for (let current = statement.parent; current && current !== decl; current = current.parent) {
    if (!ts.isBlock(current)) continue;
    const holder = current.statements.find((candidate) => containsNode(candidate, child));
    if (!holder) continue;
    const holderIndex = current.statements.indexOf(holder);
    for (const candidate of current.statements.slice(0, holderIndex)) {
      const append = directEnvelopeWarningAppend(candidate, envelopeName);
      if (append) appends.push(append);
    }
    child = current;
  }
  return appends;
}

/**
 * The identifier-backed buffers joined by THIS return — `name.join(...)`, including through a
 * trailing `.trim()` / `.filter(Boolean)` chain. Looking only at this return is load-bearing: a
 * later `return a.join(...)` cannot make an earlier `return b.join(...)` warning-safe.
 */
function joinedBuffersReturnedBy(statement: ts.ReturnStatement): ReadonlySet<string> {
  const joined = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === 'join') {
        let base: ts.Expression = node.expression.expression;
        while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)) {
          base = base.expression.expression;
        }
        if (ts.isIdentifier(base)) joined.add(base.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (statement.expression) visit(statement.expression);
  return joined;
}

function warningSinkReachesReturn(
  decl: ts.FunctionDeclaration,
  statement: ts.ReturnStatement,
  envelopeName: string
): boolean {
  const returnedBuffers = joinedBuffersReturnedBy(statement);
  return dominatingWarningAppends(decl, statement, envelopeName).some((append) =>
    returnedBuffers.has(append.sink)
  );
}

interface FormatterReturnCoverage {
  readonly formatter: Formatter;
  readonly statement: ts.ReturnStatement;
  readonly errorPreamble: boolean;
  readonly delegated: boolean;
  readonly warningDominated: boolean;
}

function classifyFormatterReturns(
  formatter: Formatter,
  siblingNames: ReadonlySet<string>
): FormatterReturnCoverage[] {
  const envelopeIndex = locateEnvelopeParam(formatter.decl);
  if (envelopeIndex === -1) return [];
  const envelopeName = (formatter.decl.parameters[envelopeIndex].name as ts.Identifier).text;
  return ownedReturns(formatter.decl).map((statement) => ({
    formatter,
    statement,
    errorPreamble: isErrorPreambleReturn(formatter.decl, statement, envelopeName),
    delegated: isDelegatingReturn(statement, siblingNames),
    warningDominated: warningSinkReachesReturn(formatter.decl, statement, envelopeName),
  }));
}

// --- the sweep, run once ------------------------------------------------------------------

const formatters: Formatter[] = listTsFiles(CMOS_ROOT).flatMap((file) =>
  collectFormatters(parse(file), path.relative(CMOS_ROOT, file))
);

/**
 * Delegation targets are resolved against EVERY formatter declared in the module, because nine of
 * the ten routers delegate across files (cmos-session.ts imports formatSessionStartForLLM). The
 * `no format*ForLLM outside src/tools/cmos` assertion below is what makes this name-based
 * resolution safe: there is no other declaration an identifier could be referring to.
 */
const declaredNames: ReadonlySet<string> = new Set(formatters.map((f) => f.name));

/** Per-file sets, used only for the uniqueness assertion. */
const siblingsByFile = new Map<string, Set<string>>();
for (const f of formatters) {
  const set = siblingsByFile.get(f.file) ?? new Set<string>();
  set.add(f.name);
  siblingsByFile.set(f.file, set);
}

const dispatchers = formatters.filter((f) => isDispatcher(f.decl, declaredNames));
const leaves = formatters.filter((f) => !dispatchers.includes(f));
const exclusions = leaves.filter((f) => locateEnvelopeParam(f.decl) === -1);
const mustRender = leaves.filter((f) => locateEnvelopeParam(f.decl) !== -1);
const envelopeFormatters = formatters.filter((f) => locateEnvelopeParam(f.decl) !== -1);
const notRendering = mustRender.filter((f) => !callsAppendWarnings(f.decl));
const returnCoverage = envelopeFormatters.flatMap((formatter) =>
  classifyFormatterReturns(formatter, declaredNames)
);
const genuineRenderReturns = returnCoverage.filter((row) => !row.errorPreamble && !row.delegated);
const uncoveredGenuineReturns = genuineRenderReturns.filter((row) => !row.warningDominated);

const at = (f: Formatter): string => `${f.name} (${f.file}:${f.line})`;

describe('s86-m02 Step 1 — the envelope warnings channel is universal', () => {
  it('sweeps every format*ForLLM declaration in src/tools/cmos, exported or not', () => {
    expect(formatters.map(at).sort()).toHaveLength(EXPECTED_DECLARATIONS);
    // Names are unique across the tree EXCEPT where a module keeps a private formatter; assert
    // per-file uniqueness so a duplicate name inside one module cannot shadow a sibling.
    for (const [file, names] of siblingsByFile) {
      const inFile = formatters.filter((f) => f.file === file);
      expect(`${file}: ${inFile.length}`).toBe(`${file}: ${names.size}`);
    }
  });

  it('finds no format*ForLLM outside src/tools/cmos — the sweep scope is complete', () => {
    const strays = listTsFiles(SRC_ROOT)
      .filter((file) => !file.startsWith(CMOS_ROOT + path.sep))
      .flatMap((file) => collectFormatters(parse(file), path.relative(SRC_ROOT, file)))
      .map(at);
    expect(strays).toEqual([]);
  });

  it('classifies dispatchers and leaves BY RULE, with no allowlist', () => {
    expect(dispatchers.map((f) => f.name).sort()).toHaveLength(EXPECTED_DISPATCHERS);
    expect(leaves).toHaveLength(EXPECTED_LEAVES);
    // formatMessageForLLM delegates ONLY to module-private formatters. It is the reason the rule
    // says "declared in the module" rather than "exported" — the exported-callee wording selects
    // nine and leaves every cmos_message answer uncovered.
    expect(dispatchers.map((f) => f.name)).toContain('formatMessageForLLM');
  });

  it('reports the structural exclusion BY NAME instead of skipping it silently', () => {
    // A leaf with no CmosToolResult parameter cannot satisfy an envelope rule. There is exactly
    // one, and naming it here is the whole point: an unnamed skip is indistinguishable from a
    // gate that never looked.
    // eslint-disable-next-line no-console
    console.log(
      `[formatter-warnings] structural exclusion (no CmosToolResult parameter): ${exclusions
        .map(at)
        .join(', ')}`
    );
    expect(exclusions.map((f) => f.name)).toEqual([STRUCTURAL_EXCLUSION]);
  });

  it('requires every remaining leaf to call appendWarnings', () => {
    expect({
      count: notRendering.length,
      leaves: notRendering.map(at),
    }).toEqual({ count: 0, leaves: [] });
    expect(mustRender).toHaveLength(EXPECTED_LEAVES - exclusions.length);
  });

  it('renders warnings on every non-delegating success return, excluding error preambles by rule', () => {
    const errorPreambles = returnCoverage.filter((row) => row.errorPreamble);
    const delegatedReturns = returnCoverage.filter((row) => row.delegated);
    // eslint-disable-next-line no-console
    console.log(
      `[formatter-warning-return-census] declarations=${formatters.length} ` +
        `dispatchers=${dispatchers.length} leaves=${leaves.length} ` +
        `envelopeFormatters=${envelopeFormatters.length} envelopeLeaves=${mustRender.length} ` +
        `terminalReturns=${returnCoverage.length} errorPreambles=${errorPreambles.length} ` +
        `delegatedReturns=${delegatedReturns.length} ` +
        `genuineRenderReturns=${genuineRenderReturns.length} ` +
        `covered=${genuineRenderReturns.length - uncoveredGenuineReturns.length} ` +
        `uncovered=${uncoveredGenuineReturns.length}`
    );

    expect({
      terminalReturns: returnCoverage.length,
      errorPreambles: errorPreambles.length,
      delegatedReturns: delegatedReturns.length,
      genuineRenderReturns: genuineRenderReturns.length,
    }).toEqual({
      terminalReturns: 265,
      errorPreambles: 91,
      delegatedReturns: 71,
      genuineRenderReturns: 103,
    });
    expect(
      uncoveredGenuineReturns.map(
        ({ formatter, statement }) =>
          `${at(formatter)} -> return:${
            formatter.decl
              .getSourceFile()
              .getLineAndCharacterOfPosition(statement.getStart(formatter.decl.getSourceFile()))
              .line + 1
          }`
      )
    ).toEqual([]);
  });

  it('passes the ENVELOPE parameter, and each append reaches a return of that same buffer', () => {
    // Presence alone is not enough. Two ways to satisfy the rule above and still render nothing:
    // hand appendWarnings a DIFFERENT `CmosToolResult`-shaped value than the one the caller
    // passed, or append into a scratch array that is never joined into the return. Both would
    // leave a green gate over a dead channel — this mission's whole subject.
    const wrongEnvelope: string[] = [];
    const orphanSink: string[] = [];
    for (const f of envelopeFormatters) {
      const envelopeName = (f.decl.parameters[locateEnvelopeParam(f.decl)].name as ts.Identifier)
        .text;
      for (const call of appendWarningsCalls(f.decl)) {
        const [sink, envelope] = call.arguments;
        if (!envelope || envelope.getText() !== envelopeName) {
          wrongEnvelope.push(
            `${at(f)} → passes '${envelope?.getText()}', expected '${envelopeName}'`
          );
        }
        const reachesReturn =
          sink &&
          ts.isIdentifier(sink) &&
          ownedReturns(f.decl).some(
            (statement) =>
              dominatingWarningAppends(f.decl, statement, envelopeName).some(
                (append) => append.call === call
              ) && joinedBuffersReturnedBy(statement).has(sink.text)
          );
        if (!reachesReturn) {
          orphanSink.push(
            `${at(f)} → appends to '${sink?.getText()}', which reaches no return of that buffer`
          );
        }
      }
    }
    expect({ wrongEnvelope, orphanSink }).toEqual({ wrongEnvelope: [], orphanSink: [] });
  });

  it('locates the envelope parameter BY TYPE, at index 0 and at index 1 alike', () => {
    const fixture = ts.createSourceFile(
      'fixture.ts',
      `
        export function formatAtZeroForLLM(result: CmosToolResult<Thing>, action: string): string {}
        export function formatAtOneForLLM(action: string, result: CmosToolResult<Thing>): string {}
        export function formatUnionForLLM(action: string, r: CmosToolResult<A> | null): string {}
        export function formatNoneForLLM(result: SyncHealthCheckResult): string {}
      `,
      ts.ScriptTarget.Latest,
      true
    );
    const byName = new Map(
      collectFormatters(fixture, 'fixture.ts').map((f) => [f.name, locateEnvelopeParam(f.decl)])
    );
    expect(byName.get('formatAtZeroForLLM')).toBe(0);
    expect(byName.get('formatAtOneForLLM')).toBe(1);
    expect(byName.get('formatUnionForLLM')).toBe(1);
    expect(byName.get('formatNoneForLLM')).toBe(-1);

    // And the real tree carries both shapes, so the fixture is not the only thing keeping the
    // by-type rule honest.
    const positions = mustRender.map((f) => locateEnvelopeParam(f.decl));
    expect(positions.filter((p) => p === 0).length).toBeGreaterThan(0);
    expect(positions.filter((p) => p === 1).length).toBeGreaterThan(0);
  });

  it('recognises delegation to a module-private callee (the formatMessageForLLM shape)', () => {
    const fixture = ts.createSourceFile(
      'fixture.ts',
      `
        function formatPrivateLeafForLLM(result: CmosToolResult<A>): string { return ''; }
        export function formatRouterForLLM(action: string, result: CmosToolResult<A>): string {
          if (!action) { const lines = []; return lines.join('\\n'); }
          switch (action) {
            case 'a': return formatPrivateLeafForLLM(result);
            default: return 'unknown';
          }
        }
        export function formatLoneLeafForLLM(result: CmosToolResult<A>): string { return ''; }
      `,
      ts.ScriptTarget.Latest,
      true
    );
    const found = collectFormatters(fixture, 'fixture.ts');
    const names = new Set(found.map((f) => f.name));
    const classified = found.map((f) => [f.name, isDispatcher(f.decl, names)] as const);
    expect(classified).toEqual([
      ['formatPrivateLeafForLLM', false],
      ['formatRouterForLLM', true],
      ['formatLoneLeafForLLM', false],
    ]);
  });

  it("does not exempt a dispatcher's non-delegating success fallback", () => {
    const fixture = ts.createSourceFile(
      'fixture.ts',
      `
        function formatLeafForLLM(result: CmosToolResult<A>): string {
          const lines: string[] = [];
          appendWarnings(lines, result);
          return lines.join('\\n');
        }
        export function formatRouterForLLM(
          action: string,
          result: CmosToolResult<A>
        ): string {
          if (!result.success) {
            const lines = ['failed'];
            return lines.join('\\n');
          }
          switch (action) {
            case 'known':
              return formatLeafForLLM(result);
            default:
              return 'completed';
          }
        }
      `,
      ts.ScriptTarget.Latest,
      true
    );
    const found = collectFormatters(fixture, 'fixture.ts');
    const names = new Set(found.map((f) => f.name));
    const router = found.find((f) => f.name === 'formatRouterForLLM')!;
    expect(
      classifyFormatterReturns(router, names).map(
        ({ errorPreamble, delegated, warningDominated }) => ({
          errorPreamble,
          delegated,
          warningDominated,
        })
      )
    ).toEqual([
      { errorPreamble: true, delegated: false, warningDominated: false },
      { errorPreamble: false, delegated: true, warningDominated: false },
      { errorPreamble: false, delegated: false, warningDominated: false },
    ]);
  });

  it('does not let append-to-a / return-b pass because a later return joins a', () => {
    const fixture = ts.createSourceFile(
      'fixture.ts',
      `
        export function formatMismatchedForLLM(result: CmosToolResult<A>): string {
          const a: string[] = [];
          const b: string[] = [];
          appendWarnings(a, result);
          if (result.data?.empty) return b.join('\\n');
          return a.join('\\n');
        }
      `,
      ts.ScriptTarget.Latest,
      true
    );
    const [formatter] = collectFormatters(fixture, 'fixture.ts');
    const rows = classifyFormatterReturns(formatter, new Set([formatter.name]));
    expect(rows.map((row) => row.warningDominated)).toEqual([false, true]);
  });

  it('does NOT use the "every return delegates" rule, which selects zero formatters', () => {
    // Kept as an executable note: all 10 routers carry non-delegating returns (an INVALID_ACTION
    // preamble plus explicit failure and warning-rendering success returns in `default:`), so the
    // stricter phrasing two critics proposed would exempt nothing and demand appendWarnings on
    // delegated paths too — reintroducing the double-render those critics were trying to prevent.
    const everyReturnDelegates = (f: Formatter): boolean => {
      const names = siblingsByFile.get(f.file) as ReadonlySet<string>;
      const returns: ts.ReturnStatement[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isReturnStatement(node)) returns.push(node);
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(f.decl, visit);
      return (
        returns.length > 0 &&
        returns.every(
          (r) =>
            r.expression !== undefined &&
            ts.isCallExpression(r.expression) &&
            ts.isIdentifier(r.expression.expression) &&
            names.has(r.expression.expression.text)
        )
      );
    };
    expect(formatters.filter(everyReturnDelegates).map(at)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The gate above proves the CALL exists. These prove the RENDER is right: exactly once, through
// the dispatcher an agent actually reaches, and without either channel swallowing the other.
// ---------------------------------------------------------------------------------------------

/** How many times `needle` occurs in `haystack`. A count, never a presence check. */
function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

describe('s86-m02 Step 1 — the channel renders exactly once, through the real entrypoint', () => {
  const ENVELOPE_WARNING =
    'This decision was captured without a missionId while 2 mission(s) are open: s86-m02 (In Progress).';

  const dispatcherFallbacks: ReadonlyArray<{
    readonly name: string;
    readonly format: (result: CmosToolResult<unknown>) => string;
    readonly success: string;
    readonly failure: string;
  }> = [
    {
      name: 'context',
      format: (result) => formatContextForLLM(undefined, result as never),
      success: '✓ Context action completed',
      failure: '❌ Failed to execute cmos_context',
    },
    {
      name: 'db',
      format: (result) => formatDbForLLM(undefined, result as never),
      success: '✓ Database action completed',
      failure: '❌ Failed to execute cmos_db',
    },
    {
      name: 'decisions',
      format: (result) => formatDecisionsForLLM(undefined, result as never),
      success: '✓ Decisions action completed',
      failure: '❌ Failed to execute cmos_decisions',
    },
    {
      name: 'learnings',
      format: (result) => formatLearningsForLLM(undefined, result as never),
      success: '✓ Learnings action completed',
      failure: '❌ Failed to execute cmos_learnings',
    },
    {
      name: 'message',
      format: (result) => formatMessageForLLM(undefined, result as never),
      success: 'Message action completed',
      failure: 'Failed to execute cmos_message',
    },
    {
      name: 'mission transition',
      format: (result) => formatMissionTransitionForLLM(undefined, result as never),
      success: '✓ Mission transition completed',
      failure: '❌ Failed to execute cmos_mission_transition',
    },
    {
      name: 'mission',
      format: (result) => formatMissionForLLM(undefined, result as never),
      success: '✓ Mission action completed',
      failure: '❌ Failed to execute cmos_mission',
    },
    {
      name: 'project',
      format: (result) => formatProjectForLLM(undefined, result as never),
      success: '✓ Project action completed',
      failure: '❌ Failed to execute cmos_project',
    },
    {
      name: 'session',
      format: (result) => formatSessionForLLM(undefined, result as never),
      success: '✓ Session action completed',
      failure: '❌ Failed to execute cmos_session',
    },
    {
      name: 'sprint',
      format: (result) => formatSprintForLLM(undefined, result as never),
      success: '✓ Sprint action completed',
      failure: '❌ Failed to execute cmos_sprint',
    },
  ];

  it('renders every dispatcher success fallback once without changing warning-free text', () => {
    for (const fallback of dispatcherFallbacks) {
      const clean = fallback.format({ success: true, data: {} });
      expect(`${fallback.name}: ${clean}`).toBe(`${fallback.name}: ${fallback.success}`);

      const warned = fallback.format({
        success: true,
        data: {},
        warnings: [ENVELOPE_WARNING],
      });
      expect(warned.startsWith(fallback.success)).toBe(true);
      expect(occurrences(warned, ENVELOPE_WARNING)).toBe(1);

      const failed = fallback.format({
        success: false,
        error: { code: 'DB_QUERY_FAILED', message: 'forced failure' },
      });
      expect(`${fallback.name}: ${failed}`).toBe(`${fallback.name}: ${fallback.failure}`);
    }
  });

  it('renders an envelope warning EXACTLY ONCE through the formatSessionForLLM dispatcher', () => {
    // Asserted through the dispatcher, not the leaf: src/index.ts calls the dispatcher, so a
    // double-render introduced by appending at BOTH layers would only be visible from here.
    const result = {
      success: true,
      data: {
        sessionId: 'PS-2026-08-11-001',
        category: 'decision',
        content: 'Split m02 into a channel mission and a write-guard mission.',
        timestamp: '2026-08-11T21:00:00.000Z',
        captureCount: 3,
        message: 'Capture recorded.',
      },
      warnings: [ENVELOPE_WARNING],
    } as unknown as CmosToolResult<unknown>;

    const text = formatSessionForLLM('capture', result as never);
    expect(occurrences(text, ENVELOPE_WARNING)).toBe(1);
    expect(text).toContain('Warnings:');
  });

  it('renders it EXACTLY ONCE through formatMessageForLLM, whose delegates are all private', () => {
    // The dispatcher §2's "exported callee" wording would have misclassified as a leaf. If the
    // seven private formatters had been left out of the sweep, this would render zero times while
    // the AST gate stayed green — the exact failure mode decision #978 corrected.
    const result = {
      success: true,
      data: {
        messageId: 'msg-1',
        targetAddress: 'cmos://derek/tracelab',
        status: 'pending',
        summary: 'Backlog request',
        verb: 'create',
        object: 'mission',
      },
      warnings: [ENVELOPE_WARNING],
    } as unknown as CmosToolResult<unknown>;

    const text = formatMessageForLLM('send', result as never);
    expect(occurrences(text, ENVELOPE_WARNING)).toBe(1);
  });

  it('does not render an envelope warning at the dispatcher when there is no warning', () => {
    const result = {
      success: true,
      data: {
        messageId: 'msg-2',
        targetAddress: 'cmos://derek/tracelab',
        status: 'pending',
        summary: 'Backlog request',
        verb: 'create',
        object: 'mission',
      },
    } as unknown as CmosToolResult<unknown>;

    expect(formatMessageForLLM('send', result as never)).not.toContain('Warnings:');
  });

  it('keeps the DATA-level and ENVELOPE channels distinct, each rendered exactly once', () => {
    // result.data.warnings (declared sync-pull.ts:152, built :210, emitted :308) is a DIFFERENT
    // channel from the envelope field createSuccess writes. Both must survive, neither twice.
    const DATA_WARNING = 'Broker returned 3 events with malformed provenance.';
    const result = {
      success: true,
      data: {
        slug: 'cmos-mcp-pro',
        fromCursor: 0,
        toCursor: 12,
        pages: 1,
        received: 12,
        inserted: 9,
        duplicates: 3,
        transitionsApplied: 0,
        transitionsSkipped: 0,
        transitionsDeferred: 0,
        skippedMissingProvenance: 3,
        skippedUnknownType: 0,
        failed: 0,
        insertedByType: {},
        message: 'Pulled 12 events.',
        warnings: [DATA_WARNING],
      },
      warnings: [ENVELOPE_WARNING],
    } as unknown as CmosToolResult<unknown>;

    const text = formatSyncPullForLLM(result as never);
    expect(occurrences(text, DATA_WARNING)).toBe(1);
    expect(occurrences(text, ENVELOPE_WARNING)).toBe(1);
    // Distinguishable: the data-level channel keeps its ⚠ marker, the envelope its heading.
    expect(text).toContain(`⚠ ${DATA_WARNING}`);
    expect(text).toContain(`- ${ENVELOPE_WARNING}`);
  });

  it('renders the structural exclusion’s OWN warnings field, which was dead until s86-m02', () => {
    // formatSyncHealthForLLM has no envelope to render, but SyncHealthCheckResult.warnings was
    // populated and never printed. Excluding it from the gate must not leave it a live defect.
    const text = formatSyncHealthForLLM({
      checked: true,
      allMatch: true,
      totalDelta: 0,
      mismatchedTables: 0,
      mismatches: [],
      message: 'ok',
      warnings: ['PG mirror unreachable; counts are local-only.'],
    } as never);
    expect(occurrences(text, 'PG mirror unreachable; counts are local-only.')).toBe(1);
    expect(text).toContain('Sync health: all tables match');
  });
});
