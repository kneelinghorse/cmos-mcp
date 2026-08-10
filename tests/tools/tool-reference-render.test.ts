// ABOUTME: s85-m01 TOOL_REFERENCE.md render VALIDITY gate — every generated table row must
// ABOUTME: carry exactly as many cells as its header, so a rendered value can never add a column.

/**
 * Sprint 85 m01 — the gate that `tool-reference-freshness.test.ts` structurally cannot be.
 *
 * The freshness gate is a CONSISTENCY test: it renders from the same `renderToolReference`
 * import that the build hook uses and asserts `rendered === committed`. That design (s77-m06)
 * is what eliminated false drift, and the price is that a formatting defect renders identically
 * on both sides and passes. Proven empirically on 2026-08-10: with a malformed row committed at
 * TOOL_REFERENCE.md:26, `tool-reference-freshness` PASSED while `tool-definitions` failed.
 *
 * What was missing is a VALIDITY test. This is it. Two assertions:
 *
 *  1. Column-count invariant over the REAL definitions — the file that actually ships in
 *     `package.json` `files` and is named the authoritative public reference by
 *     `scripts/mirror-to-public.sh:33`.
 *  2. The same invariant over an ADVERSARIAL SYNTHETIC definition. This half is load-bearing,
 *     not decoration: assertion 1 decays to a no-op the moment the real definitions happen to
 *     contain no pipe-bearing content, which is exactly the state the repo was in before
 *     `cmos_mission.context` gained `type: ['string','object']`.
 *
 * The defect class: `renderType` returns a JSON-Schema union as `string | object`. Interpolated
 * raw into a table row, that bare pipe splits the row into an extra column. Fixed by routing the
 * type cell through `cell()` (the table-layer escaper) — see render-tool-reference.js:36.
 */

import { describe, expect, it } from '@jest/globals';
import { CMOS_TOOL_DEFINITIONS } from '../../src/tools/cmos';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderToolReference } = require('../../scripts/lib/render-tool-reference.js') as {
  renderToolReference: (defs: unknown[]) => string;
};

/**
 * Split a markdown table row on UNESCAPED pipes. GFM treats `\|` as a literal pipe inside a
 * cell, and (unlike a code span) that is the only escape it honours in a table row.
 */
function splitCells(row: string): string[] {
  return row.split(/(?<!\\)\|/);
}

interface RowViolation {
  table: string;
  line: number;
  expected: number;
  actual: number;
  row: string;
}

/**
 * Walk the rendered markdown, group `|`-leading lines into tables (header, separator, body),
 * and report every body row whose unescaped-pipe cell count differs from its header's.
 */
function findColumnCountViolations(markdown: string): RowViolation[] {
  const lines = markdown.split('\n');
  const violations: RowViolation[] = [];
  const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;

  let headerCells: number | null = null;
  let headerLabel = '(unknown)';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) {
      headerCells = null;
      continue;
    }
    if (headerCells === null) {
      // Only treat this as a header if the NEXT line is the separator row.
      if (i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
        headerCells = splitCells(line).length;
        headerLabel = line.trim();
        i += 1; // consume the separator
      }
      continue;
    }
    const actual = splitCells(line).length;
    if (actual !== headerCells) {
      violations.push({
        table: headerLabel,
        line: i + 1,
        expected: headerCells,
        actual,
        row: line,
      });
    }
  }
  return violations;
}

function countBodyRows(markdown: string): number {
  const lines = markdown.split('\n');
  const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;
  let inTable = false;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      if (i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
        inTable = true;
        i += 1;
      }
      continue;
    }
    count++;
  }
  return count;
}

/**
 * Every hazard the renderer must survive, in one definition. Each property is here because it
 * exercises a distinct branch — do not prune this without replacing the coverage.
 */
const ADVERSARIAL_TOOL = {
  name: 'cmos_adversarial',
  description: 'A synthetic tool | whose own description carries a pipe.',
  inputSchema: {
    type: 'object',
    properties: {
      // renderType's array branch — the actual s85-m01 defect.
      unionType: { type: ['string', 'object'], description: 'A union type.' },
      // A 6-member union, matching cmos_context fieldUpdates[].value.
      wideUnion: {
        type: ['string', 'number', 'boolean', 'object', 'array', 'null'],
        description: 'The complete JSON Schema type set.',
      },
      // cell()'s pipe-escaping branch on the description column.
      pipedDescription: { type: 'string', description: 'Choose a | b | c.' },
      // cell()'s whitespace-collapsing branch.
      multilineDescription: {
        type: 'string',
        description: 'First line.\nSecond line.\n\tTabbed third.',
      },
      // renderType's enum-without-type branch (returns 'string').
      enumOnly: { enum: ['alpha', 'beta'], description: 'An enum with no declared type.' },
      // renderType's FALLBACK branch: neither type nor enum (returns 'object').
      untyped: { description: 'A property with neither type nor enum.' },
      // A nested object — its sub-shape is not rendered, but it must not break the row.
      nested: {
        type: 'object',
        properties: {
          inner: { type: ['string', 'null'], description: 'Nested | pipe.' },
        },
        description: 'A nested object.',
      },
      // An action enum, so renderTool's action-list branch runs too.
      action: { enum: ['run', 'halt'], description: 'Adversarial action.' },
    },
    required: ['unionType'],
  },
};

describe('TOOL_REFERENCE render validity (s85-m01)', () => {
  it('renders every real tool row with the same cell count as its header', () => {
    const markdown = renderToolReference(CMOS_TOOL_DEFINITIONS as unknown as unknown[]);
    const violations = findColumnCountViolations(markdown);
    expect(violations).toEqual([]);
  });

  it('renders a non-trivial number of body rows (the invariant must have something to check)', () => {
    // Guards against the invariant silently becoming vacuous if the walker or the renderer
    // stops emitting tables. 15 tools × their params was 194 rows on 2026-08-10.
    const markdown = renderToolReference(CMOS_TOOL_DEFINITIONS as unknown as unknown[]);
    expect(countBodyRows(markdown)).toBeGreaterThanOrEqual(150);
  });

  it('survives an adversarial definition: unions, pipes, newlines, enums, untyped, nested', () => {
    const markdown = renderToolReference([ADVERSARIAL_TOOL]);
    const violations = findColumnCountViolations(markdown);
    expect(violations).toEqual([]);
  });

  it('escapes the pipe in a union type rather than dropping or reordering it', () => {
    // Assert the ESCAPE, not just the column count — a renderer that fixed the count by
    // deleting the pipe (or by joining with ' or ') would pass the invariant while silently
    // discarding the JSON-Schema union convention.
    const markdown = renderToolReference([ADVERSARIAL_TOOL]);
    expect(markdown).toContain('| `unionType` | string \\| object | yes |');
    expect(markdown).toContain(
      '| `wideUnion` | string \\| number \\| boolean \\| object \\| array \\| null | no |'
    );
  });

  it('collapses newlines in a description so a cell can never break its row', () => {
    const markdown = renderToolReference([ADVERSARIAL_TOOL]);
    expect(markdown).toContain(
      '| `multilineDescription` | string | no | First line. Second line. Tabbed third. |'
    );
  });
});
