// ABOUTME: s85-m01 agent-facing tool-name gate — every `cmos_*(...)` we print INTO an agent-facing
// ABOUTME: string must name a tool that exists, with an action that exists. No allowlist.

/**
 * Sprint 85 m01 — the published surface must be true.
 *
 * CMOS consolidated 38 per-operation tools into 15 action-dispatched ones, but strings that
 * TEACH agents how to call them were left behind in suggestedActions, warnings[], zod
 * `.describe()` text, JSON inputSchema descriptions and error `suggestion` fields. Those
 * strings ship to npm and are, for a fresh agent, indistinguishable from documentation.
 * Measured baseline on 2026-08-10: 17 references naming a tool or action that does not exist —
 * including two INVALID_ACTIONs in the general-tier first-session prompt (the first thing every
 * general-tier project ever sees) and two non-existent tools emitted into `warnings[]` on EVERY
 * stale-context session start.
 *
 * DISCRIMINATION IS BY RULE, NOT BY ALLOWLIST (Process Hardening #2). The sweep walks the
 * TypeScript AST and considers ONLY string-literal and template-literal nodes, so a `cmos_*(`
 * token in a `//` comment or a JSDoc block is excluded structurally — it was never a candidate.
 * That is why this file has no allowlist to grow silently. Two references the regex-based
 * approach flags and this one does not, by construction:
 *   - cmos-session-complete.ts — `cmos_session_capture` inside a `//` comment
 *   - project-identity.ts      — `cmos_address (to be rewritten…)` in JSDoc prose
 *
 * Deliberate deviation from the s85 build plan: the plan suggested cross-checking invalid names
 * against `DEPRECATED_TOOL_NAMES` in tool-definitions.test.ts. That list is already duplicated in
 * tests/index.test.ts; copying it a third time would create three lists to keep in sync — the
 * exact drift class this mission exists to close. The failure hint is instead DERIVED (longest
 * real tool name that prefixes the invalid one), which is self-maintaining.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { CMOS_TOOL_DEFINITIONS } from '../../../src/tools/cmos';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

/** tool name -> its action enum (null when the tool takes no `action` param). */
const TOOL_ACTIONS: Map<string, Set<string> | null> = new Map(
  CMOS_TOOL_DEFINITIONS.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, { enum?: unknown }> };
    const actionProp = schema?.properties?.action;
    const values = actionProp && Array.isArray(actionProp.enum) ? actionProp.enum : null;
    return [tool.name, values ? new Set(values.map(String)) : null] as const;
  })
);

/** A `cmos_something(` call token. */
const CALL_RE = /\bcmos_[a-z_]+\s*\(/g;
/** `action: "x"` / `action="x"` as the first argument of that call. */
const ACTION_RE = /^\s*action\s*[:=]\s*["'`]([a-z_]+)["'`]/;
/** Any `cmos_*` identifier-shaped token, with or without a following call. */
const BARE_RE = /\bcmos_[a-z][a-z0-9_]*\b/g;

/**
 * True when `token` looks like a real tool name with an operation suffix appended —
 * `cmos_mission_show` from `cmos_mission`, `cmos_db_snapshot` from `cmos_db`. That shape is
 * the fingerprint of a pre-consolidation tool name. Derived entirely from the live tool set,
 * so it cannot drift: `cmos_address` and `cmos_sync_log` match no real tool prefix and are
 * therefore never candidates, and `cmos_sessions` (a dashboard table) lacks the `_` boundary.
 */
function derivesFromRealTool(token: string): boolean {
  for (const real of TOOL_ACTIONS.keys()) {
    if (token.startsWith(`${real}_`)) return true;
  }
  return false;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface StringNode {
  text: string;
  line: number;
}

/**
 * Every string-literal / template-literal chunk in a file, with its 1-based line. Comments are
 * not literal nodes, so they never appear here — that is the whole discrimination rule.
 */
function collectStringLiterals(file: string, content: string): StringNode[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const out: StringNode[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push({
        text: node.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Longest real tool name that is a prefix of `name` — a hint, not a rule. */
function suggestReplacement(name: string): string {
  let best = '';
  for (const real of TOOL_ACTIONS.keys()) {
    if (name.startsWith(`${real}_`) && real.length > best.length) best = real;
  }
  return best ? `did you mean ${best}(action="…")?` : 'no consolidated tool matches this prefix';
}

interface Violation {
  rel: string;
  line: number;
  message: string;
}

function sweepAgentFacingToolNames(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC_ROOT, file);
    for (const lit of collectStringLiterals(file, content)) {
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(lit.text)) !== null) {
        const name = m[0].slice(0, m[0].indexOf('(')).trim();
        const rest = lit.text.slice(m.index + m[0].length);

        if (!TOOL_ACTIONS.has(name)) {
          violations.push({
            rel,
            line: lit.line,
            message: `${rel}:${lit.line} names tool "${name}", which does not exist — ${suggestReplacement(name)}`,
          });
          continue;
        }
        const actions = TOOL_ACTIONS.get(name);
        const actionMatch = rest.match(ACTION_RE);
        if (actionMatch && actions && !actions.has(actionMatch[1])) {
          violations.push({
            rel,
            line: lit.line,
            message:
              `${rel}:${lit.line} calls ${name}(action="${actionMatch[1]}"), which is not a valid action — ` +
              `valid: ${[...actions].join(', ')}`,
          });
        }
      }

      // ARM 2 — bare mentions. A reference does not need parentheses to teach a false thing:
      // "Use cmos_db_snapshot to create a new snapshot" (errors.ts) named a tool that has not
      // existed since the 38→15 consolidation. Arm 1's `(`-requiring rule is structurally blind
      // to these, which is how 46 of them survived the s85 plan's measured baseline of 17.
      //
      // The discriminator is again STRUCTURAL, not an allowlist: a token is an IDENTIFIER when
      // the string literal is exactly that token (`name: 'cmos_mission_show'` on an internal
      // per-operation definition, `tool: 'cmos_mission_add'` on a telemetry row) and PROSE when
      // the literal says anything else around it. Only prose instructs an agent, so only prose
      // is checked. Candidates are derived from the live tool set (`<real tool>_<suffix>`), so
      // non-tool identifiers like `cmos_address` and `cmos_sync_log` are never candidates.
      const isIdentifierValue = lit.text.trim() === lit.text.trim().match(BARE_RE)?.[0];
      if (!isIdentifierValue) {
        BARE_RE.lastIndex = 0;
        let b: RegExpExecArray | null;
        while ((b = BARE_RE.exec(lit.text)) !== null) {
          const token = b[0];
          if (TOOL_ACTIONS.has(token)) continue;
          if (!derivesFromRealTool(token)) continue;
          violations.push({
            rel,
            line: lit.line,
            message: `${rel}:${lit.line} mentions tool "${token}", which does not exist — ${suggestReplacement(token)}`,
          });
        }
      }
    }
  }
  return violations;
}

describe('agent-facing tool references (s85-m01)', () => {
  const literalCount = walkTsFiles(SRC_ROOT).reduce(
    (n, f) => n + collectStringLiterals(f, fs.readFileSync(f, 'utf8')).length,
    0
  );

  it('parses the source tree (the sweep must not be silently vacuous)', () => {
    // If the AST walk breaks or SRC_ROOT resolves wrong, the sweep would report zero
    // violations for the wrong reason. ~140 .ts files carried tens of thousands of literals
    // on 2026-08-10; a floor of 1000 catches a walker that stopped walking.
    expect(walkTsFiles(SRC_ROOT).length).toBeGreaterThanOrEqual(100);
    expect(literalCount).toBeGreaterThanOrEqual(1000);
  });

  it('finds the cmos_* call tokens it is supposed to be checking', () => {
    // The invariant only bites if the extractor still matches real calls. The valid,
    // consolidated references we DO emit must be visible to the sweep.
    let found = 0;
    for (const file of walkTsFiles(SRC_ROOT)) {
      for (const lit of collectStringLiterals(file, fs.readFileSync(file, 'utf8'))) {
        CALL_RE.lastIndex = 0;
        while (CALL_RE.exec(lit.text) !== null) found++;
      }
    }
    expect(found).toBeGreaterThanOrEqual(20);
  });

  it('never teaches an agent a tool or action that does not exist', () => {
    expect(sweepAgentFacingToolNames().map((v) => v.message)).toEqual([]);
  });

  /**
   * The seed docs are the same defect class in a different medium. `cmos-seed/` ships in
   * package.json `files` and is copied verbatim into every project by `cmos_project(init)` —
   * `cmos-seed/docs/build-session-prompt.md` is literally the recipe a fresh project's build
   * agent follows. On 2026-08-10 those five files carried 118 references to tools removed in
   * the 38→15 consolidation.
   *
   * SCOPE BOUNDARY, stated rather than allowlisted: only `cmos-seed/**` is checked. The root
   * README / CHANGELOG / SECURITY are project-HISTORY documents, where naming a retired tool
   * in a past release note is correct and must stay correct. A seed template is never
   * historical — it describes the surface as of the version that ships with it.
   */
  const SEED_ROOT = path.resolve(__dirname, '../../../cmos-seed');

  function walkSeedDocs(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkSeedDocs(full));
      else if (/\.(md|ya?ml)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('ships seed templates that name only tools that exist', () => {
    const violations: string[] = [];
    for (const file of walkSeedDocs(SEED_ROOT)) {
      const rel = path.relative(SEED_ROOT, file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        BARE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = BARE_RE.exec(line)) !== null) {
          const token = m[0];
          if (TOOL_ACTIONS.has(token)) continue;
          if (!derivesFromRealTool(token)) continue;
          violations.push(
            `cmos-seed/${rel}:${i + 1} names tool "${token}", which does not exist — ${suggestReplacement(token)}`
          );
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('checks a non-empty set of seed templates', () => {
    // Same vacuity guard as the src sweep: 20 md/yaml files shipped on 2026-08-10.
    expect(walkSeedDocs(SEED_ROOT).length).toBeGreaterThanOrEqual(10);
  });
});
