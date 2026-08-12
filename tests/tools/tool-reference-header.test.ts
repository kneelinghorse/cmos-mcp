// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m04 header-derivation gate — TOOL_REFERENCE.md's opening sentence may state the
// ABOUTME: action partition and nothing else, so it cannot contradict the tables three lines below.

/**
 * Sprint 86 m04 — the defect this gate closes was IN the file this mission rewrites, and it is the
 * sprint's own class.
 *
 * scripts/lib/render-tool-reference.js emitted, verbatim: "The CMOS MCP server exposes 15 tools.
 * Most select an operation with an `action` parameter; `cmos_agent_onboard`, `cmos_status`, and
 * `cmos_review` take only `projectRoot`." That was published at TOOL_REFERENCE.md:7 — three lines
 * above the cmos_agent_onboard table listing its OTHER parameter, `agentFeedback`. The
 * authoritative public reference contradicted itself on the same page, and had done so since
 * `agentFeedback` was added in Sprint 56.
 *
 * THE FIX IS BY DERIVATION, NOT BY REWORDING. Rewriting the list to "…take only `projectRoot` and
 * `agentFeedback`" would be correct today and wrong at the next parameter. So the rule below is
 * structural: the header may name TOOLS and it may name the discriminant `action`, because both
 * are derivable from the partition it describes. It may not name a PARAMETER — naming one is
 * asserting something about a tool's parameter set, which is the tables' job.
 *
 * FALSE-NEGATIVE PROFILE: the rule polices backticked tokens. A parameter claim written in bare
 * prose ("these three take only a project root") is invisible to it. That residue is accepted;
 * every generated sentence in this renderer is code, and code that interpolates a parameter name
 * does it with backticks, as the defect above did.
 */

import * as fs from 'fs';
import * as path from 'path';

import { CMOS_ACTION_PARAMS, CMOS_TOOL_DEFINITIONS } from '../../src/tools/cmos';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderToolReference } = require('../../scripts/lib/render-tool-reference.js') as {
  renderToolReference: (
    defs: unknown[],
    actionParams?: Record<string, Record<string, readonly string[]>>
  ) => string;
};

type ToolDef = {
  name: string;
  inputSchema?: { properties?: Record<string, { enum?: readonly string[] } | undefined> };
};

const DEFS = CMOS_TOOL_DEFINITIONS as unknown as readonly ToolDef[];
const TOOL_REFERENCE_PATH = path.resolve(__dirname, '../../TOOL_REFERENCE.md');

function actionEnumOf(def: ToolDef): readonly string[] | undefined {
  const prop = def.inputSchema?.properties?.action;
  return prop && Array.isArray(prop.enum) ? prop.enum : undefined;
}

/** The header is everything before the first `## ` tool heading. */
function headerOf(markdown: string): string {
  const idx = markdown.indexOf('\n## ');
  return idx === -1 ? markdown : markdown.slice(0, idx);
}

/**
 * Backticked tokens in the header that are neither a registered tool name nor the discriminant.
 * Each one is a claim the header is not entitled to make.
 */
function unlicensedClaims(markdown: string): string[] {
  const toolNames = new Set(DEFS.map((d) => d.name));
  const header = headerOf(markdown);
  // Only the prose lines — the HTML comment block names the generator script and its gate.
  const prose = header
    .split('\n')
    .filter((line) => !line.trim().startsWith('<!--'))
    .join('\n');
  const tokens = [...prose.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return tokens.filter((t) => t !== 'action' && !toolNames.has(t));
}

/** The rendered `## <tool>` section, up to the next tool heading. */
function sectionOf(markdown: string, toolName: string): string {
  const start = markdown.indexOf(`## ${toolName}\n`);
  if (start === -1) return '';
  const next = markdown.indexOf('\n## ', start + 1);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, next);
}

describe('TOOL_REFERENCE.md header states only the partition (s86-m04)', () => {
  const rendered = renderToolReference(
    CMOS_TOOL_DEFINITIONS as unknown as unknown[],
    CMOS_ACTION_PARAMS
  );

  it('makes no claim about any tool\u2019s parameter set', () => {
    expect(unlicensedClaims(rendered)).toEqual([]);
  });

  it('is RED against the pre-fix sentence, which claimed one', () => {
    // The exact string the renderer emitted before this mission, at TOOL_REFERENCE.md:7.
    const preFix =
      '# CMOS MCP Tool Reference\n\n' +
      'The CMOS MCP server exposes 15 tools. Most select an operation with an `action` parameter; ' +
      '`cmos_agent_onboard`, `cmos_status`, and `cmos_review` take only `projectRoot`.\n\n' +
      '## cmos_mission\n';
    expect(unlicensedClaims(preFix)).toEqual(['projectRoot']);
  });

  it('states counts that are derived from the definitions, not written down', () => {
    const header = headerOf(rendered);
    const actionLess = DEFS.filter((d) => actionEnumOf(d) === undefined);
    expect(header).toContain(`exposes ${DEFS.length} tools`);
    expect(header).toContain(`${DEFS.length - actionLess.length} select an operation`);
    expect(header).toContain(`the remaining ${actionLess.length}`);
    for (const def of actionLess) expect(header).toContain(`\`${def.name}\``);
    // Measured today: 15 tools, 12 with an action, 3 without.
    expect(actionLess.map((d) => d.name)).toEqual([
      'cmos_agent_onboard',
      'cmos_status',
      'cmos_review',
    ]);
  });

  it('says what the Required column actually means, since per-action tables imply otherwise', () => {
    // One table per action reads as the complete contract for that action, so "Required: no"
    // invites the reading "optional on this action". JSON Schema `required` is declared per SHAPE
    // and no shape states a per-action requirement, so the header has to say so — and it must do
    // it without naming a parameter, which the first case above enforces.
    const header = headerOf(rendered);
    expect(header).toContain('the tool for a top-level parameter, the sub-shape for a dotted row');
    // Proof the claim it disclaims is real: at least one action needs a parameter the schema does
    // not require. cmos_mission(show) cannot work without missionId, which is not in `required`.
    const mission = DEFS.find((d) => d.name === 'cmos_mission') as ToolDef & {
      inputSchema?: { required?: readonly string[] };
    };
    expect(mission.inputSchema?.required ?? []).not.toContain('missionId');
    expect(sectionOf(rendered, 'cmos_mission')).toContain('| `missionId` | string | no |');
    // And the sub-shape half of the same sentence: a dotted row's requirement comes from its own
    // block, not the tool's, so the wording had to cover both (build-time critic finding).
    expect(sectionOf(rendered, 'cmos_context')).toContain(
      '| `fieldUpdates[].path` | string | yes |'
    );
  });

  it('agrees with the tables: every tool it calls action-less renders no action row', () => {
    // THE CONSISTENCY CHECK the old header failed. Read the claim out of the rendered header and
    // hold the rendered tables to it, rather than trusting both to be separately correct.
    const header = headerOf(rendered);
    for (const def of DEFS) {
      const namedAsActionLess = new RegExp(`the remaining [0-9]+ \\([^)]*\`${def.name}\``).test(
        header
      );
      const section = sectionOf(rendered, def.name);
      expect(section).not.toBe('');
      const hasActionRow = section.includes('| `action` |');
      expect({ tool: def.name, namedAsActionLess, hasActionRow }).toEqual({
        tool: def.name,
        namedAsActionLess: !hasActionRow,
        hasActionRow,
      });
    }
  });

  it('the committed file carries the derived header, not a stale one', () => {
    const committed = fs.readFileSync(TOOL_REFERENCE_PATH, 'utf8');
    expect(unlicensedClaims(committed)).toEqual([]);
    expect(headerOf(committed)).toContain('take no `action`');
  });
});
