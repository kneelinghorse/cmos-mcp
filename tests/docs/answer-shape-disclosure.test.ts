// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Sprint 89 m04 answer-shape snapshot, mixed-kind disclosure, and currentState emit gate.
// ABOUTME: Pins exported CMOS Error/Result closures by symbol, declared syntax, and runtime JSON kind.

/**
 * Sprint 89 m04 — ANSWER-SHAPE DISCLOSURE GATE.
 *
 * Scope: every interface/type exported from a `src/tools/cmos` module under a name ending `Error`
 * or `Result`, plus every named interface/type transitively reached anywhere in the corresponding
 * `src/` program through references, import types, or heritage, is recorded here. Roots come from
 * TypeScript module export tables, so `export { XResult }` and an external declaration re-exported
 * as `*Result` count. Every closure declaration gets a module-qualified composition fingerprint
 * covering alias RHS, resolved semantic literals, type parameters, heritage, and every interface
 * member kind. Direct properties also record declared syntax and checker-resolved runtime kind.
 *
 * ARM 1 snapshots that surface. Regenerating the snapshot with `-u` carries a release-note
 * obligation: this gate exists because 2.8.0 changed `CmosToolError.currentState` on the wire and
 * nothing in the repository stopped that change from shipping without disclosure.
 *
 * ARM 2 ledgers mixed JSON kinds. `CmosToolError.currentState` requires a literal CHANGELOG token;
 * `RankedResult.id` is an in-process ranking row, not a tool answer, and predates 2.7.0.
 * `CMOS_ANSWER_SHAPE_CHANGELOG` may point at a scratch CHANGELOG for the pre-disclosure RED, and
 * `CMOS_ANSWER_SHAPE_SOURCE_ROOT` may point at a scratch cmos tree for a composition fire.
 *
 * ARM 3 counts direct `currentState:` assignments, direct object initializers, and the eight
 * unguarded `${error.currentState}` formatter interpolations. `CMOS_ANSWER_SHAPE_EMIT_ROOT` may
 * point at a scratch cmos source copy. Anti-vacuity tests mutate strings in memory, never files.
 *
 * FALSE-NEGATIVE PROFILE — the declared complement of the scope above:
 *
 * - Declared/runtime kind: explicit `any` / `unknown` carries no inspectable JSON kind. Exactly
 *   three reachable sites are opaque: `CmosToolError.providedValue`,
 *   `DashboardMessage.evidence` (`array<ANY>`), and `PulledSyncEvent.payload`.
 * - Generic kind is separate from explicit opacity. Exactly three rows are open type-parameter
 *   holes: `CmosToolResult.data`, `SingleCurrentSprintResult.data`, and
 *   `CrossStoreQueryResult.results` (`array<GENERIC>`). Call-site substitution can change their
 *   JSON kind without changing the declaration snapshot.
 * - Answer types: input shapes are outside this gate. The tool-definition snapshot owns the input
 *   half; `TOOL_REFERENCE.md`'s freshness test owns its generated prose.
 * - Exported roots: a module-private `*Result` is excluded unless an exported root references it.
 *   A non-exported named type that is referenced from a root IS followed into the closure. Runtime
 *   export conditions outside TypeScript's module table are not modeled.
 * - Reference rows: the checker follows named declarations across `src/`, including qualified
 *   `import()` types. A type hidden behind `Record<string, unknown>`, opacity, or a generic remains
 *   undiscoverable. Resolved semantic literal sets cover `typeof CONST[number]`/enum-like value
 *   dependencies; they do not prove runtime validation uses the same constant.
 * - Direct ownership: only PropertySignature members get kind rows. Other/anonymous composition is
 *   still syntax-fingerprinted, but has no independently TypeChecker-resolved property-kind row.
 * - Emit syntax: casts, aliases, calls, conditionals, shorthand properties, and spreads can hide an
 *   object emit from the direct-object census. Parentheses are unwrapped. This is not data flow.
 * - Runtime semantics: neither arm proves which error code reaches a site, whether serialization
 *   occurs, or what a consumer does with the value.
 * - CHANGELOG naming: ARM 2 proves only token presence, not sentence truth. CHANGELOG is excluded
 *   by shipped-prose-truth because release history must retain names that later disappear.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  analyzeAnswerShapes,
  CMOS_SOURCE_ROOT,
  compositionFingerprintsForSource,
  containsNestedKind,
  exportedShapeNamesForSource,
  jsonKind,
  sortedKinds,
} from '../helpers/answer-shape-analysis';
import {
  censusCurrentState,
  emitCensusFindings,
  EXPECTED_INTERPOLATION_FILES,
  loadSourceTexts,
  replaceExactlyOnce,
} from '../helpers/current-state-census';

const REPO_ROOT = path.resolve(__dirname, '../..');
const EMIT_SOURCE_ROOT = process.env.CMOS_ANSWER_SHAPE_EMIT_ROOT
  ? path.resolve(process.env.CMOS_ANSWER_SHAPE_EMIT_ROOT)
  : CMOS_SOURCE_ROOT;
const CHANGELOG_PATH = process.env.CMOS_ANSWER_SHAPE_CHANGELOG
  ? path.resolve(process.env.CMOS_ANSWER_SHAPE_CHANGELOG)
  : path.join(REPO_ROOT, 'CHANGELOG.md');
const SHAPE_SOURCE_ROOT = process.env.CMOS_ANSWER_SHAPE_SOURCE_ROOT
  ? path.resolve(process.env.CMOS_ANSWER_SHAPE_SOURCE_ROOT)
  : CMOS_SOURCE_ROOT;

const EXPECTED_TOTALS = {
  // s90-m05: the published sprint-close receipt replaces three scalar/list fields with the named
  // `SprintPendingNextStep`, `SprintPendingNextStepGroups`, and `SprintPendingNextStepsSurvey`
  // closure. That adds three declarations/compositions and nine property rows; the CHANGELOG's
  // Changed section discloses the corresponding answer-shape break.
  files: 121,
  roots: 137,
  declarations: 270,
  compositions: 270,
  rows: 1495,
} as const;
const EXPLICIT_OPAQUE_LEDGER = [
  'CmosToolError.providedValue = ANY',
  'DashboardMessage.evidence = array<ANY>',
  'PulledSyncEvent.payload = ANY',
] as const;
const GENERIC_HOLE_LEDGER = [
  'CmosToolResult.data = GENERIC',
  'CrossStoreQueryResult.results = array<GENERIC>',
  'SingleCurrentSprintResult.data = GENERIC',
] as const;
const MIXED_KIND_LEDGER = [
  {
    row: 'CmosToolError.currentState',
    runtimeKinds: ['object', 'string'],
    requiredChangelogToken: 'currentState',
    reason:
      'A tool error changed from a session-id string to an object for SESSION_ALREADY_ACTIVE in 2.8.0.',
  },
  {
    row: 'RankedResult.id',
    runtimeKinds: ['number', 'string'],
    requiredChangelogToken: null,
    reason:
      'Not a tool answer: fts5-retriever.ts uses this exported *Result in process; it predates 2.7.0.',
  },
] as const;

const ANSWER_SHAPES = analyzeAnswerShapes(SHAPE_SOURCE_ROOT);
const CANONICAL_EMIT_SOURCES = loadSourceTexts(CMOS_SOURCE_ROOT);
const CHECKED_EMIT_SOURCES =
  EMIT_SOURCE_ROOT === CMOS_SOURCE_ROOT
    ? CANONICAL_EMIT_SOURCES
    : loadSourceTexts(EMIT_SOURCE_ROOT);

function analyzeExternalFixture(toolSource: string, authSource: string) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-answer-shape-'));
  const toolRoot = path.join(fixture, 'src', 'tools', 'cmos');
  const authRoot = path.join(fixture, 'src', 'auth');
  fs.mkdirSync(toolRoot, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true });
  fs.writeFileSync(path.join(toolRoot, 'fixture.ts'), toolSource);
  fs.writeFileSync(path.join(authRoot, 'auth-state.ts'), authSource);
  try {
    return analyzeAnswerShapes(toolRoot);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

describe('answer-shape disclosure gate (Sprint 89 m04)', () => {
  it('derives the exact symbol-safe answer closure and keeps opacity ledgers explicit', () => {
    expect({
      files: ANSWER_SHAPES.fileCount,
      roots: ANSWER_SHAPES.roots.length,
      declarations: ANSWER_SHAPES.declarations.length,
      compositions: ANSWER_SHAPES.compositionRows.length,
      rows: ANSWER_SHAPES.rows.length,
    }).toEqual(EXPECTED_TOTALS);
    expect(
      new Set(ANSWER_SHAPES.declarations.map((declaration) => declaration.identity)).size
    ).toBe(ANSWER_SHAPES.declarations.length);

    for (const [, modules] of ANSWER_SHAPES.duplicateOwnerNames) {
      expect(modules.length).toBeGreaterThan(1);
      for (const moduleId of modules) expect(moduleId).toMatch(/^src\//);
    }
    for (const name of ANSWER_SHAPES.duplicateOwnerNames.keys()) {
      expect(ANSWER_SHAPES.rows.some((row) => row.key.startsWith(`${name}.`))).toBe(false);
      expect(ANSWER_SHAPES.rows.some((row) => row.key.startsWith(`${name}@`))).toBe(true);
    }
    const projectTypeFields = ANSWER_SHAPES.compositionRows.filter((row) =>
      row.startsWith('src/tools/cmos/project-identity.ts#ProjectTypeFields:')
    );
    expect(projectTypeFields).toHaveLength(1);
    expect(projectTypeFields[0]).toContain('[ key : string ] : unknown ;');
    const authState = ANSWER_SHAPES.compositionRows.filter((row) =>
      row.startsWith('src/auth/auth-state.ts#AuthState:')
    );
    expect(authState).toHaveLength(1);
    expect(authState[0]).toContain('identitySource');
    expect(
      ANSWER_SHAPES.compositionRows.some((row) =>
        row.startsWith('src/intelligence/cross-store-query.ts#CrossStoreRow:')
      )
    ).toBe(true);

    const unresolved = ANSWER_SHAPES.rows
      .filter((row) => row.runtimeKinds.some((kind) => kind.startsWith('UNRESOLVED')))
      .map((row) => row.snapshot);
    const opaque = ANSWER_SHAPES.rows
      .filter((row) => containsNestedKind(row.runtimeKinds, 'ANY'))
      .map((row) => `${row.key} = ${row.runtimeKinds.join(' | ')}`)
      .sort();
    const generics = ANSWER_SHAPES.rows
      .filter((row) => containsNestedKind(row.runtimeKinds, 'GENERIC'))
      .map((row) => `${row.key} = ${row.runtimeKinds.join(' | ')}`)
      .sort();
    expect(unresolved).toEqual([]);
    expect(opaque).toEqual([...EXPLICIT_OPAQUE_LEDGER].sort());
    expect(generics).toEqual([...GENERIC_HOLE_LEDGER].sort());
  });

  it('snapshots declaration composition and checker-resolved property JSON kinds', () => {
    expect({
      declarationComposition: ANSWER_SHAPES.compositionRows,
      propertyRows: ANSWER_SHAPES.rows.map((row) => row.snapshot),
    }).toMatchSnapshot();
  });

  it('changes a declaration fingerprint when a union member is removed', () => {
    const prefix = `
      export interface LoginActionResult { action: 'login' }
      export interface LogoutActionResult { action: 'logout' }
    `;
    const before = compositionFingerprintsForSource(
      `${prefix}\nexport type CmosAuthResult = LoginActionResult | LogoutActionResult;`
    ).find((row) => row.includes('#CmosAuthResult:'));
    const after = compositionFingerprintsForSource(
      `${prefix}\nexport type CmosAuthResult = LoginActionResult;`
    ).find((row) => row.includes('#CmosAuthResult:'));
    expect(before).toContain('LogoutActionResult');
    expect(after).not.toContain('LogoutActionResult');
    expect(after).not.toBe(before);
  });

  it('discovers an exported Result declared through an export list', () => {
    expect(
      exportedShapeNamesForSource(`
        interface ListedResult { value: string }
        interface HiddenResult { value: string }
        export { ListedResult };
      `)
    ).toEqual(['ListedResult']);
  });

  it('follows an external import type and ignores comments while catching shape/value drift', () => {
    const tool = `
      export interface WhoamiResult {
        authState: import('../../auth/auth-state').AuthState;
      }
    `;
    const auth = (values: string, extra = '', comment = '') => `
      export const VALID_AUTH_TIERS = [${values}] as const;
      export type AuthTier = (typeof VALID_AUTH_TIERS)[number];
      export interface AuthState {
        identitySource: string ${comment};
        authTier: AuthTier;
        ${extra}
      }
    `;
    const baseline = analyzeExternalFixture(tool, auth("'api-key', 'none'"));
    const commented = analyzeExternalFixture(tool, auth("'api-key', 'none'", '', '/* trivia */'));
    const newField = analyzeExternalFixture(
      tool,
      auth("'api-key', 'none'", 's89WireField: string;')
    );
    const newLiteral = analyzeExternalFixture(tool, auth("'api-key', 'none', 'refreshing'"));
    const enumAuth = (extra = '') => `
      export enum AuthMode { ApiKey = 'api-key', None = 'none' ${extra} }
      export interface AuthState { mode: AuthMode; }
    `;
    const enumBaseline = analyzeExternalFixture(tool, enumAuth());
    const enumChanged = analyzeExternalFixture(tool, enumAuth(", Refreshing = 'refreshing'"));
    const row = (analysis: typeof baseline, identity: string) =>
      analysis.compositionRows.find((entry) => entry.startsWith(identity));
    const authIdentity = 'src/auth/auth-state.ts#AuthState:';
    const tierIdentity = 'src/auth/auth-state.ts#AuthTier:';

    expect(row(baseline, authIdentity)).toBeDefined();
    expect(commented.compositionRows).toEqual(baseline.compositionRows);
    expect(row(newField, authIdentity)).toContain('s89WireField');
    expect(row(newField, authIdentity)).not.toBe(row(baseline, authIdentity));
    expect(row(newLiteral, tierIdentity)).toContain('refreshing');
    expect(row(newLiteral, tierIdentity)).not.toBe(row(baseline, tierIdentity));
    expect(row(enumChanged, authIdentity)).toContain('refreshing');
    expect(row(enumChanged, authIdentity)).not.toBe(row(enumBaseline, authIdentity));
  });

  it('treats an external declaration re-exported as *Result as a cmos answer root', () => {
    const analysis = analyzeExternalFixture(
      `export { AuthState as ExternalAuthResult } from '../../auth/auth-state';`,
      `export interface AuthState { identitySource: string; }`
    );
    expect(analysis.roots.map((root) => root.identity)).toEqual([
      'src/auth/auth-state.ts#AuthState',
    ]);
  });

  it('follows named constraints and defaults on generic answer declarations', () => {
    const analysis = analyzeExternalFixture(
      `
        interface BoundRow { id: string }
        export interface GenericResult<T extends BoundRow = BoundRow> { data: T }
      `,
      ''
    );
    expect(analysis.compositionRows.some((row) => row.includes('#BoundRow:'))).toBe(true);
  });

  it('ledgers every mixed JSON-kind row and requires disclosure for currentState', () => {
    const mixedRows = ANSWER_SHAPES.rows
      .filter((row) => {
        const kinds = new Set(
          row.runtimeKinds.map(jsonKind).filter((kind): kind is string => !!kind)
        );
        return kinds.size > 1;
      })
      .map((row) => ({
        row: row.key,
        runtimeKinds: sortedKinds(
          row.runtimeKinds.map(jsonKind).filter((kind): kind is string => !!kind)
        ),
      }))
      .sort((a, b) => a.row.localeCompare(b.row));
    expect(mixedRows).toEqual(
      MIXED_KIND_LEDGER.map((entry) => ({
        row: entry.row,
        runtimeKinds: [...entry.runtimeKinds],
      })).sort((a, b) => a.row.localeCompare(b.row))
    );

    const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
    for (const entry of MIXED_KIND_LEDGER) {
      console.log(`[answer-shape mixed-kind] ${entry.row}: ${entry.reason}`);
      if (entry.requiredChangelogToken && !changelog.includes(entry.requiredChangelogToken)) {
        throw new Error(
          `${entry.row} requires CHANGELOG token ${JSON.stringify(entry.requiredChangelogToken)}; ` +
            `token is absent from ${CHANGELOG_PATH}`
        );
      }
    }
  });

  it('censuses currentState emit sites and all eight unguarded string interpolations', () => {
    expect(emitCensusFindings(censusCurrentState(CHECKED_EMIT_SOURCES))).toEqual([]);
  });

  it('fails independently for a sixteenth direct currentState assignment', () => {
    const mutated = CANONICAL_EMIT_SOURCES.map((source, index) =>
      index === 0
        ? {
            ...source,
            text: `${source.text}\nconst s89AssignmentFire = { currentState: 'fixture' };\n`,
          }
        : source
    );
    const census = censusCurrentState(mutated);
    const findings = emitCensusFindings(census);
    expect(census.assignments).toBe(16);
    expect(census.directObjectLiterals).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('Expected 15 direct currentState property assignments; found 16');
    for (const file of EXPECTED_INTERPOLATION_FILES) expect(findings[0]).toContain(file);
  });

  it('fails independently for a second parenthesized currentState object literal', () => {
    const mutated = CANONICAL_EMIT_SOURCES.map((source) =>
      source.relativePath === 'cmos-mission-block.ts'
        ? replaceExactlyOnce(
            source,
            'currentState: currentStatus,',
            "currentState: ({ id: 's89-object-fire' }),"
          )
        : source
    );
    const census = censusCurrentState(mutated);
    const findings = emitCensusFindings(census);
    expect(census.assignments).toBe(15);
    expect(census.directObjectLiterals).toBe(2);
    expect(findings.some((finding) => finding.includes('found 2'))).toBe(true);
    expect(findings.every((finding) => finding.includes('[object Object]'))).toBe(true);
    for (const file of EXPECTED_INTERPOLATION_FILES) {
      expect(findings.every((finding) => finding.includes(file))).toBe(true);
    }
  });
});
