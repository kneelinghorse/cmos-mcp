// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m04 Part B — every agent-facing string that ENUMERATES a tool's actions must list
// ABOUTME: ALL of them. An incomplete enumeration hides working capability from every agent.

/**
 * Sprint 86 m04 Part B — "say only what you know", enforced on action enumerations.
 *
 * THE DEFECT CLASS, and why s85-m01's sweep could not see it. That gate checked that every
 * `cmos_*(action="…")` reference NAMES SOMETHING THAT EXISTS. This one checks the opposite
 * direction: that a string claiming to list a tool's actions lists them ALL. Both are "the
 * published surface must be true"; only the second catches an omission.
 *
 * MEASURED PRE-FIX BASELINE: 8 violations across 4 tools, every one shipped in TOOL_REFERENCE.md.
 *   cmos_sprint      zod .describe + JSON action description — listed 5 of 8 (no retro,
 *                    carry_forward, analytics)
 *   cmos_decisions   zod .describe + JSON action description — listed 3 of 5 (no review,
 *                    batch_update)
 *   cmos_context     zod .describe (6 of 8 — omitted BOTH constraints and search), tool
 *                    description (omitted constraints), JSON action description (omitted search)
 *   cmos_learnings   tool description — listed 3 of 4 (no reaffirm)
 * An agent reading `cmos_sprint`'s published parameter table could not learn that `analytics`
 * exists. The action worked; the sentence describing the tool did not mention it.
 *
 * LOCATED BY POSITION, NOT BY SCANNING FOR STRINGS THAT LOOK LIKE ENUMERATIONS. The three
 * candidate strings per tool are read from fixed structural positions — the zod `action` key's
 * description, `inputSchema.properties.action.description`, and the tool's own `description`.
 * A regex over arbitrary literals FALSE-POSITIVES immediately: cmos-project.ts declares
 * `.describe('Project type/tier for update action: general | managed | build')` on `projectType`,
 * which is a pipe-run after the word "action" and is not an action enumeration at all.
 *
 * READ AT RUNTIME, NOT FROM SOURCE TEXT. m04 makes these strings DERIVED
 * (`${CMOS_SPRINT_ACTIONS.join(' | ')}`), so a `ts.createSourceFile` literal walk would see a
 * template expression and find nothing to check. Reading the built values is also closer to what
 * an agent actually receives.
 *
 * CLAUSE DEFINED BY SHAPE, so the exclusions are structural rather than a list of names:
 *   • `<Word> action: a | b | c`  — a pipe-separated token run.
 *   • `Actions: a, b (gloss), c.` — a comma-separated token run where each token may carry a
 *     parenthetical gloss, terminated by the first period OUTSIDE parentheses. The paren-depth
 *     rule is load-bearing: cmos_auth's and cmos_message's glosses contain periods and commas.
 * A string carrying no clause falls through to a MEMBERSHIP FLOOR — every action must appear
 * somewhere in it. The floor is weaker on purpose and its weakness is recorded below.
 *
 * ── FALSE-NEGATIVE PROFILE ────────────────────────────────────────────────────────────────────
 *  1. THE MEMBERSHIP FLOOR CANNOT DETECT AN EXTRA. A prose description naming an action the tool
 *     does not have passes the floor, because the floor only asks whether each real action is
 *     mentioned. s85-m01's gate covers that direction.
 *  2. MEMBERSHIP IS SUBSTRING-BASED. An action whose name is a substring of another word in the
 *     same sentence counts as mentioned.
 *  3. IT CHECKS THE THREE STRUCTURAL POSITIONS ONLY. An enumeration written into some other
 *     description, a warning, or an error suggestion is not read here.
 */

import * as path from 'path';
import { z } from 'zod';

import { CMOS_TOOL_DEFINITIONS } from '../../../src/tools/cmos/index';

/**
 * Resolve a tool's ZodObject from its NAME, by the same derived rule the schema-parity gate uses.
 * No hand-written map: the one tool someone forgot to add would be the one that drifts.
 */
function resolveSchema(toolName: string): z.ZodObject<z.ZodRawShape> {
  const file = 'cmos-' + toolName.replace(/^cmos_/, '').replace(/_/g, '-');
  const exportName = toolName.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase()) + 'Schema';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.join('../../../src/tools/cmos', file)) as Record<string, unknown>;
  const schema = mod[exportName];
  if (!schema || !(schema instanceof z.ZodObject)) {
    throw new Error(`action-enumeration: cannot resolve a ZodObject for ${toolName}`);
  }
  return schema as z.ZodObject<z.ZodRawShape>;
}

interface ActionProp {
  readonly enum?: readonly string[];
  readonly description?: string;
}

/** The tool definitions are `as const`, so every cast through them must go via `unknown`. */
type PropsOf = { properties: Record<string, ActionProp> };
function propsOf(def: (typeof CMOS_TOOL_DEFINITIONS)[number]): Record<string, ActionProp> {
  return (def.inputSchema as unknown as PropsOf).properties;
}

/** One agent-facing string that should enumerate a tool's actions, with where it came from. */
interface Candidate {
  readonly tool: string;
  readonly position: 'zod-action-describe' | 'json-action-description' | 'tool-description';
  readonly text: string;
}

/**
 * Extract an action-enumeration clause, or `undefined` when the string carries none.
 * Returns the token run so the caller can compare it to the real enum.
 */
export function parseActionClause(text: string): string[] | undefined {
  // Shape 1: "<Word> action: a | b | c"
  const pipe = /(?:^|\.\s+)\w[\w\s]*?\baction:\s*([^.]+)$/i.exec(text.trim());
  if (pipe && pipe[1].includes('|')) {
    return pipe[1]
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // Shape 2: "Actions: a, b (gloss with, commas. and periods), c." — terminated by the first
  // period at paren depth 0.
  const idx = text.indexOf('Actions:');
  if (idx === -1) return undefined;
  let depth = 0;
  let end = text.length;
  for (let i = idx + 'Actions:'.length; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '.' && depth === 0) {
      end = i;
      break;
    }
  }
  const body = text.slice(idx + 'Actions:'.length, end);

  // Split on commas at paren depth 0.
  const parts: string[] = [];
  let cur = '';
  depth = 0;
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);

  // SHAPE 2 IS A COMMA-RUN. A single part means there was no comma at paren depth 0, which is
  // what distinguishes an enumeration from multi-sentence prose that merely opens with "Actions:".
  // cmos_auth's description is the live instance: its commas all sit INSIDE parenthetical glosses
  // and its actions are joined by periods, so it has no depth-0 comma, is not a clause, and falls
  // through to the membership floor. That exclusion is structural — no tool is named for it.
  if (parts.length < 2) return undefined;

  // A token is the leading identifier of each part; a parenthetical gloss is dropped.
  const tokens = parts
    .map((p) =>
      p
        .trim()
        .replace(/\s*\(.*$/s, '')
        .trim()
    )
    .filter((t) => t.length > 0);

  // Only a run of bare identifiers counts as a CLAUSE. Anything else falls to the membership floor.
  if (tokens.length === 0 || !tokens.every((t) => /^[a-z][a-z_]*$/.test(t))) return undefined;
  return tokens;
}

interface Finding {
  readonly tool: string;
  readonly position: string;
  readonly detail: string;
}

describe('action enumerations are complete (s86-m04 Part B)', () => {
  const actionBearing = CMOS_TOOL_DEFINITIONS.filter((t) => propsOf(t).action?.enum);

  const findings: Finding[] = [];
  let clausesFound = 0;
  let floorsApplied = 0;
  const candidates: Candidate[] = [];

  for (const def of actionBearing) {
    const props = propsOf(def);
    const actions = props.action.enum!;
    // THE THIRD POSITION. The zod `action` key's own `.describe()` — read from the built schema
    // rather than the source, because m04 makes these strings derived template expressions.
    const zodActionDescription =
      (resolveSchema(def.name).shape.action?._def as { description?: string } | undefined)
        ?.description ?? '';
    candidates.push(
      { tool: def.name, position: 'zod-action-describe', text: zodActionDescription },
      { tool: def.name, position: 'json-action-description', text: props.action.description ?? '' },
      { tool: def.name, position: 'tool-description', text: def.description ?? '' }
    );

    for (const c of candidates.filter((x) => x.tool === def.name)) {
      const clause = parseActionClause(c.text);
      if (clause) {
        clausesFound += 1;
        const got = [...clause].sort();
        const want = [...actions].sort();
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          findings.push({
            tool: def.name,
            position: c.position,
            detail: `clause lists [${got}] but the enum is [${want}] — "${c.text.slice(0, 120)}"`,
          });
        }
        continue;
      }
      // NO SILENT SKIP: a string that ANNOUNCES an enumeration but carries no parseable clause is
      // reported with the string quoted, unless every action is at least mentioned (the floor).
      if (/\bActions:/.test(c.text) || /\baction:\s/i.test(c.text)) {
        floorsApplied += 1;
        const missing = actions.filter((a) => !c.text.includes(a));
        if (missing.length > 0) {
          findings.push({
            tool: def.name,
            position: c.position,
            detail:
              `announces an enumeration but no clause parses, and these actions are not even ` +
              `mentioned: [${missing}] — "${c.text.slice(0, 160)}"`,
          });
        }
      }
    }
  }

  it('reports every candidate string it read, and how it judged each', () => {
    // eslint-disable-next-line no-console
    console.log(
      `\n[s86-m04] action enumerations — ${actionBearing.length} action-bearing tools, ` +
        `${candidates.length} candidate strings, ${clausesFound} parsed as clauses, ` +
        `${floorsApplied} fell through to the membership floor\n` +
        findings.map((f) => `  ${f.tool} [${f.position}] ${f.detail}`).join('\n')
    );
    expect(actionBearing).toHaveLength(12);
  });

  it('every parseable clause lists EXACTLY its tool action enum', () => {
    expect(findings.map((f) => `${f.tool} [${f.position}]: ${f.detail}`)).toEqual([]);
  });

  it('VACUITY FLOOR — a parser that stopped parsing must fail here, not report zero', () => {
    expect(candidates.length).toBeGreaterThanOrEqual(36);
    expect(clausesFound + floorsApplied).toBeGreaterThanOrEqual(30);
  });

  it('does NOT false-positive on a non-action pipe-run that mentions the word "action"', () => {
    // cmos-project.ts's `projectType` describe. A regex over arbitrary literals flags this; the
    // position rule never offers it to the parser in the first place. Asserted directly so the
    // exclusion is demonstrated rather than merely claimed structural.
    // The ZOD describe is where the trap lives: '…for update action: general | managed | build'
    // is a pipe-run immediately after the word "action", and a literal scan flags it. The position
    // rule never offers it to the parser, and the parser WOULD have mis-read it if it had.
    const projectTypeDescribe = (
      resolveSchema('cmos_project').shape.projectType?._def as { description?: string } | undefined
    )?.description;
    expect(projectTypeDescribe).toBe(
      'Project type/tier for update action: general | managed | build'
    );
    // THE POSITION RULE IS WHAT EXCLUDES IT, and this is the assertion that matters: the string is
    // never offered to the parser at all.
    expect(candidates.some((c) => c.text === projectTypeDescribe)).toBe(false);

    // Do NOT rest on "the parser wouldn't have matched it anyway". It declines this exact string
    // only because "type/tier" contains a slash, which is luck, not rule. A near-identical
    // non-action describe DOES parse as a clause — so a gate that located candidates by scanning
    // literals would report cmos_project as having three actions called general/managed/build.
    expect(parseActionClause('Project type for update action: general | managed | build')).toEqual([
      'general',
      'managed',
      'build',
    ]);
  });

  it('a prose description with no parseable clause is covered by the floor, not skipped', () => {
    // cmos_auth enumerates its 8 actions in multi-sentence prose with parenthetical glosses that
    // themselves contain periods. Whether it parses as a clause is a property of the text; either
    // way it is JUDGED — the floor requires every action to be mentioned.
    const auth = CMOS_TOOL_DEFINITIONS.find((t) => t.name === 'cmos_auth')!;
    const actions = propsOf(auth).action.enum!;
    for (const a of actions) {
      expect(auth.description).toContain(a);
    }
  });

  it('FAILS LOUDLY on an "Actions:" tail it cannot parse and whose actions are unmentioned', () => {
    // Synthetic: proves the no-silent-skip arm fires rather than being assumed.
    expect(parseActionClause('Actions: see the documentation for details.')).toBeUndefined();
    expect(parseActionClause('Sprint action: list | show | add')).toEqual(['list', 'show', 'add']);
    expect(parseActionClause('Actions: list, show (with a. period), add.')).toEqual([
      'list',
      'show',
      'add',
    ]);
    expect(parseActionClause('No enumeration here at all')).toBeUndefined();
  });
});
