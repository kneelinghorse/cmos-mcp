// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m04 — a parameter description that names the actions it applies to must name the
// ABOUTME: SAME actions ACTION_PARAMS does, or the published page contradicts itself row by row.

/**
 * Sprint 86 m04, folded from a build-time critic finding.
 *
 * THE DEFECT THIS CLOSES EXISTS BECAUSE OF THIS MISSION'S OWN CHANGE. Before per-action tables,
 * `| sprintId | string | no | Sprint ID for show/add/update/complete actions |` sat in one
 * action-agnostic table, where the clause read as an incomplete hint. Rendering one table per
 * action puts that same row under `### cmos_sprint(action="retro")` — a heading asserting exactly
 * what the description denies. Thirteen parameters were in that state; `cmos_sprint(retro)` will
 * in fact return MISSING_PARAMETER without `sprintId` (cmos-sprint-retro.ts:134), so an agent that
 * believed the description would have been wrong in the direction that fails.
 *
 * THE RULE. For every published parameter of an action-bearing tool, find any clause of the shape
 * `<a>/<b>/<c> action(s)` in its description whose tokens are ALL members of that tool's action
 * enum, and require that token set to EQUAL the set of actions ACTION_PARAMS assigns the
 * parameter to. Equality, not subset, in both directions: naming an action the parameter does not
 * apply to is a false claim, and omitting one it does apply to is the `learningId` defect — the
 * exact string cmos/planning/s86-say-only-what-you-know.md cites as this arc's motivating example.
 *
 * MEASURED RED BASELINE (2026-08-12, this tree): 107 clauses across 10 tools, 13 of them
 * disagreeing — cmos_mission.status/.limit/.fromId/.toId, cmos_sprint.sprintId/.limit,
 * cmos_session.type/.sprintId/.category, cmos_db.confirm, cmos_project.prune,
 * cmos_learnings.limit/.learningId. All 13 UNDER-stated (named a subset); zero over-stated.
 *
 * SCOPED TO THE PUBLISHED JSON DESCRIPTIONS, deliberately. The zod `.describe()` strings reach no
 * consumer — the consolidated schemas are never parsed and never rendered — so gating them would
 * assert a contract nobody reads. Where the two sides carried the same clause the fix corrected
 * both, so they still state one thing.
 *
 * FALSE-NEGATIVE PROFILE, accepted and recorded:
 *  a. A description that names its actions in a shape the clause rule cannot see — prose, a
 *     parenthetical, or a token that is not an action name — is not checked. `projectRoot`'s
 *     universal description names no action and is correctly ignored.
 *  b. A clause whose tokens are not ALL action names is skipped rather than failed, because
 *     "for search action" inside a sentence about something else would otherwise fire. This is the
 *     opposite trade from CORRECTION 9's enumeration gate, and for the opposite reason: that gate
 *     locates its clause BY POSITION (the action key) so it can afford to fail loudly on an
 *     unparseable tail; here the clause can be anywhere in any description, so a
 *     fail-on-unparseable rule would fire on ordinary English.
 *  c. It cannot detect a description that names the right actions and is wrong about what the
 *     parameter DOES. That is prose review, not a rule.
 */

import { CMOS_ACTION_PARAMS, CMOS_TOOL_DEFINITIONS } from '../../../src/tools/cmos/index';

type ToolDef = {
  name: string;
  inputSchema?: {
    properties?: Record<string, { enum?: readonly string[]; description?: string } | undefined>;
  };
};

const DEFS = CMOS_TOOL_DEFINITIONS as unknown as readonly ToolDef[];
const MAPS = CMOS_ACTION_PARAMS as Record<string, Record<string, readonly string[]>>;

/**
 * A run of lowercase/underscore tokens joined by `/`, `,`, `and` or `or`, followed by
 * `action`/`actions`. Matches "for list action", "for show/add/update actions" and
 * "for list, search and update actions" alike.
 */
const CLAUSE = /\b((?:[a-z_]+)(?:(?:\s*\/\s*|,\s*|\s+and\s+|\s+or\s+)[a-z_]+)*)\s+actions?\b/g;

interface Clause {
  tool: string;
  param: string;
  /** The UNION of every clause in the description — see clausesOf. */
  named: string[];
  applies: string[];
  /** How many separate clauses contributed, for the vacuity floor. */
  matches: number;
}

/**
 * One entry per parameter that names any action, with the named set UNIONED across clauses.
 *
 * UNIONED, not per-clause: a description may spread its claim over several sentences —
 * "Status filter for list action, or initial status for add action" is ONE claim about two
 * actions, and scoring each clause against the full applicable set would call both halves wrong.
 */
function clausesOf(defs: readonly ToolDef[]): Clause[] {
  const out: Clause[] = [];
  for (const def of defs) {
    const actions = def.inputSchema?.properties?.action?.enum;
    const map = MAPS[def.name];
    if (!Array.isArray(actions) || !map) continue;
    const actionSet = new Set(actions);
    for (const [param, prop] of Object.entries(def.inputSchema?.properties ?? {})) {
      if (param === 'action' || !prop) continue;
      const named = new Set<string>();
      let matches = 0;
      CLAUSE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CLAUSE.exec(prop.description ?? '')) !== null) {
        const tokens = m[1].split(/\s*\/\s*|,\s*|\s+and\s+|\s+or\s+/).filter(Boolean);
        // FALSE-NEGATIVE (b): only a run made ENTIRELY of this tool's action names is a claim
        // about applicability. Anything else is ordinary prose that happens to end in "action".
        if (!tokens.every((n) => actionSet.has(n))) continue;
        matches += 1;
        for (const t of tokens) named.add(t);
      }
      if (matches === 0) continue;
      out.push({
        tool: def.name,
        param,
        named: [...named],
        applies: Object.entries(map)
          .filter(([, keys]) => keys.includes(param))
          .map(([a]) => a),
        matches,
      });
    }
  }
  return out;
}

function disagreements(clauses: readonly Clause[]): string[] {
  return clauses
    .map((c) => {
      const named = new Set(c.named);
      const applies = new Set(c.applies);
      const over = [...named].filter((a) => !applies.has(a));
      const under = [...applies].filter((a) => !named.has(a));
      if (over.length === 0 && under.length === 0) return '';
      return (
        `${c.tool}.${c.param}: description names [${c.named.join(', ')}] but ACTION_PARAMS ` +
        `assigns it to [${c.applies.join(', ')}]` +
        (over.length ? ` — names ${over.join(', ')} which do not apply` : '') +
        (under.length ? ` — omits ${under.join(', ')} which do` : '')
      );
    })
    .filter(Boolean);
}

describe('a parameter description names the actions ACTION_PARAMS gives it (s86-m04)', () => {
  const clauses = clausesOf(DEFS);

  it('no published description contradicts the map its table is rendered from', () => {
    expect(disagreements(clauses)).toEqual([]);
  });

  it('carries a vacuity floor, so a broken clause parser fails rather than passes', () => {
    // MEASURED 2026-08-12: 107 clauses across 10 of the 12 action-bearing tools (cmos_auth and
    // cmos_message describe their params without naming actions). Floors, not equalities — a new
    // parameter should not redden this.
    expect(clauses.reduce((n, c) => n + c.matches, 0)).toBeGreaterThanOrEqual(100);
    expect(new Set(clauses.map((c) => c.tool)).size).toBeGreaterThanOrEqual(10);
  });

  it('fires in BOTH directions, proven on synthetic descriptions rather than on the tree', () => {
    // The tree's 13 were all UNDER-statements, so the over-statement arm has no live instance and
    // would otherwise ship unproven — the same reasoning Part A applied to its maximum and key-set
    // legs.
    const overStated = disagreements([
      {
        tool: 'cmos_learnings',
        param: 'learningId',
        named: ['list'],
        applies: ['update'],
        matches: 1,
      },
    ]);
    expect(overStated).toHaveLength(1);
    expect(overStated[0]).toContain('names list which do not apply');

    const underStated = disagreements([
      {
        tool: 'cmos_learnings',
        param: 'learningId',
        named: ['update'],
        applies: ['update', 'reaffirm'],
        matches: 1,
      },
    ]);
    expect(underStated).toHaveLength(1);
    expect(underStated[0]).toContain('omits reaffirm which do');
  });

  it('reproduces the measured RED baseline against the pre-fix descriptions', () => {
    // The 13 exact pre-fix strings, so the baseline in this file's header is checkable rather than
    // asserted. Feeding them through the SAME rule that is green above must reproduce all 13.
    const PRE_FIX: Array<[string, string, string]> = [
      ['cmos_mission', 'status', 'Status filter for list action'],
      ['cmos_mission', 'limit', 'Maximum missions to return for list action'],
      ['cmos_mission', 'fromId', 'Dependent mission ID for depends action'],
      ['cmos_mission', 'toId', 'Dependency mission ID for depends action'],
      ['cmos_sprint', 'sprintId', 'Sprint ID for show/add/update/complete actions'],
      ['cmos_sprint', 'limit', 'Maximum sprints to return for list action'],
      ['cmos_session', 'type', 'Session type for list/start actions'],
      ['cmos_session', 'sprintId', 'Sprint ID filter for list action'],
      ['cmos_session', 'category', 'Capture category for capture action'],
      ['cmos_db', 'confirm', 'Confirmation flag for restore action'],
      ['cmos_project', 'prune', 'Prune invalid entries for validate action'],
      ['cmos_learnings', 'limit', 'Maximum results for search action'],
      ['cmos_learnings', 'learningId', 'Learning ID for update action'],
    ];
    const mutated = DEFS.map((def) => {
      const mine = PRE_FIX.filter(([tool]) => tool === def.name);
      if (mine.length === 0) return def;
      const properties = { ...(def.inputSchema?.properties ?? {}) };
      for (const [, param, description] of mine) {
        properties[param] = { ...(properties[param] ?? {}), description };
      }
      return { ...def, inputSchema: { ...def.inputSchema, properties } };
    });
    expect(disagreements(clausesOf(mutated))).toHaveLength(13);
  });
});
