// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m06 — no text CMOS publishes to a model or ships to a stranger may cite this
// ABOUTME: repository's own sprints, missions, decisions or issues; worked examples are named.

/**
 * A stranger reading "(Sprint 56 m03)", "(#487 mission -> row trail)" or "s84-m05: on reaffirm" in
 * a tool's parameter table learns nothing, and a model reading it in tools/list spends tokens on a
 * reference it cannot follow. The audit (cmos/research/2026-10-strategy/first-run-and-plugin.md
 * §4.3) counted 6 such references in TOOL_REFERENCE.md, 5 in SECURITY.md and 22 in the seed schema
 * every project receives.
 *
 * THE PREDICATE is the audit's own: `Sprint N`, a mission id `sNN-mNN`, `decision #N`, `#NNN`.
 * Worked examples use the same shapes on purpose (`missionId="s01-m01"`), so a match is an example
 * when it sits inside a fenced code block or an `e.g.` / "for example" parenthetical. The few
 * examples written in prose are named in ALLOWLIST below, each with its reason; an entry that no
 * longer matches anything fails the gate, so the list cannot rot into a blanket exemption.
 *
 * WHAT IS CHECKED: every description string in the tool definitions the server publishes, both
 * the full definitions (which generate TOOL_REFERENCE.md) and the tools/list definitions, and the
 * shipped prose: README.md, SECURITY.md, docs/getting-started.md, TOOL_REFERENCE.md, and the seed's
 * README, docs, templates, tiers and schema.
 *
 * NOT CHECKED, by rule: CHANGELOG.md (an immutable record of what each release did, sprint ids
 * included) and comments compiled into dist/ (maintainer commentary no answer carries).
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { CMOS_TOOL_DEFINITIONS } from '../../src/tools/cmos';
import { toWireDefinition } from '../../src/tools/cmos/wire-descriptions';

const REPO_ROOT = path.resolve(__dirname, '../..');

const INTERNAL_REFERENCE =
  /Sprint [0-9]+|\bs[0-9]{1,3}-m[0-9]{2}[a-z]?\b|decision #[0-9]+|#[0-9]{3,4}\b/g;

/** Worked examples written in prose, where neither rule can see them as examples. */
const ALLOWLIST: ReadonlyArray<{ file: string; match: string; reason: string }> = [
  {
    file: 'cmos-seed/tiers/managed.md',
    match: 's42-m01',
    reason: 'the guide quotes the mission id an agent should NOT show a managed-tier user',
  },
];

const SHIPPED_FILES = [
  'README.md',
  'SECURITY.md',
  'docs/getting-started.md',
  'TOOL_REFERENCE.md',
  'cmos-seed/README.md',
  'cmos-seed/db/schema.sql',
  ...['docs', 'templates', 'tiers'].flatMap((dir) =>
    fs
      .readdirSync(path.join(REPO_ROOT, 'cmos-seed', dir))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `cmos-seed/${dir}/${name}`)
  ),
];

interface Finding {
  where: string;
  match: string;
  text: string;
}

/** Whether the match at `index` sits inside an open `(` whose text so far says it is an example. */
function insideExample(text: string, index: number): boolean {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') {
      if (depth === 0) return /\be\.g\.|for example/i.test(text.slice(i, index));
      depth -= 1;
    }
  }
  return false;
}

function findingsIn(where: string, text: string): Finding[] {
  const found: Finding[] = [];
  for (const m of text.matchAll(INTERNAL_REFERENCE)) {
    if (insideExample(text, m.index ?? 0)) continue;
    found.push({ where, match: m[0], text: text.trim().slice(0, 160) });
  }
  return found;
}

/** Every description string in a definition, with a dotted path to it. */
function descriptions(value: unknown, at: string, out: Array<{ at: string; text: string }>): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => descriptions(item, `${at}[${i}]`, out));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'description' && typeof child === 'string')
      out.push({ at: `${at}.${key}`, text: child });
    else descriptions(child, `${at}.${key}`, out);
  }
}

function definitionFindings(definitions: readonly unknown[], label: string): Finding[] {
  const strings: Array<{ at: string; text: string }> = [];
  for (const definition of definitions) {
    const name = (definition as { name: string }).name;
    descriptions(definition, `${label}:${name}`, strings);
  }
  return strings.flatMap((s) => findingsIn(s.at, s.text));
}

/** A shipped file's lines outside fenced code blocks, with their line numbers. */
function proseLines(rel: string): Array<{ line: number; text: string }> {
  const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
  if (!rel.endsWith('.md')) return lines.map((text, i) => ({ line: i + 1, text }));
  const out: Array<{ line: number; text: string }> = [];
  let fenced = false;
  lines.forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ line: i + 1, text });
  });
  return out;
}

function fileFindings(): Finding[] {
  return SHIPPED_FILES.flatMap((rel) =>
    proseLines(rel).flatMap(({ line, text }) => findingsIn(`${rel}:${line}`, text))
  );
}

function allowed(finding: Finding): boolean {
  return ALLOWLIST.some(
    (entry) => finding.where.startsWith(`${entry.file}:`) && finding.match === entry.match
  );
}

describe('s92-m06 — no internal sprint, mission, decision or issue references in published text', () => {
  it('the predicate and the example rules behave as stated (positive and negative controls)', () => {
    const hits = (text: string): string[] => findingsIn('control', text).map((f) => f.match);
    expect(hits('Optional free-text UX feedback (Sprint 56 m03).')).toEqual(['Sprint 56']);
    expect(hits('Filter to rows (#487 mission -> row trail)')).toEqual(['#487']);
    expect(hits('s84-m05: on reaffirm, set the flag')).toEqual(['s84-m05']);
    expect(hits('see decision #841')).toEqual(['decision #841']);
    expect(hits('The mission ID (e.g., "s12-m06")')).toEqual([]);
    expect(hits('A label (for example "Sprint 12 completed")')).toEqual([]);
    expect(hits('a sprint id such as sprint-22, and port 8080')).toEqual([]);
    const fencedProbe = ['```', 'cmos_mission(action="add", missionId="s01-m01")', '```'];
    expect(fencedProbe.join('\n').match(INTERNAL_REFERENCE)).not.toBeNull();
  });

  it('no tool definition the server publishes carries one, full or tools/list', () => {
    const definitions = CMOS_TOOL_DEFINITIONS as unknown as readonly Record<string, unknown>[];
    expect(definitions.length).toBe(15);
    const findings = [
      ...definitionFindings(definitions, 'full'),
      ...definitionFindings(
        definitions.map((d) => toWireDefinition(d as never) as unknown),
        'tools/list'
      ),
    ];
    expect(findings).toEqual([]);
  });

  it('no shipped document carries one outside worked examples', () => {
    expect(SHIPPED_FILES.length).toBeGreaterThan(10);
    expect(fileFindings().filter((f) => !allowed(f))).toEqual([]);
  });

  it('every allowlisted example still exists, so the list cannot outlive its reason', () => {
    const findings = fileFindings();
    for (const entry of ALLOWLIST) {
      expect({
        entry: entry.match,
        found: findings.some(
          (f) => f.where.startsWith(`${entry.file}:`) && f.match === entry.match
        ),
      }).toEqual({ entry: entry.match, found: true });
    }
  });
});
