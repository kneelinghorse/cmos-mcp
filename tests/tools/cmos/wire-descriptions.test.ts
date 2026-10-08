// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m08 — what a client pays for: tools/list under a 6K-token ceiling in a fixed order,
// ABOUTME: the same schemas as the long form, and server instructions whose first 512 chars stand alone.

import { describe, expect, it } from '@jest/globals';

import { getToolDefinitions } from '../../../src/index';
import {
  SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS_LEVELS,
  SERVER_INSTRUCTIONS_LOOP,
} from '../../../src/server-instructions';
import { CMOS_ACTION_PARAMS, CMOS_TOOL_DEFINITIONS } from '../../../src/tools/cmos';
import { WIRE_TEXT } from '../../../src/tools/cmos/wire-descriptions';

// The shared renderer is plain JS under scripts/; required the way the freshness test does.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderToolReference } = require('../../../scripts/lib/render-tool-reference') as {
  renderToolReference: (defs: unknown, actionParams: unknown) => string;
};

interface Definition {
  name: string;
  description: string;
  inputSchema: { properties?: Record<string, { description?: string }> };
}

const longForm = CMOS_TOOL_DEFINITIONS as unknown as Definition[];
const wire = (): Definition[] => getToolDefinitions() as unknown as Definition[];

/**
 * THE RULE: tokens are estimated as characters / 4 over the exact JSON tools/list returns. The
 * ceiling is 6,000 tokens, so 24,000 characters. Measured at s92-m08: 38,141 before, about 19,000
 * after; names, types and enums alone are about 13,000.
 */
const TOKEN_CEILING = 6_000;
const CHARS_PER_TOKEN = 4;

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, child]) => !(key === 'description' && typeof child === 'string'))
      .map(([key, child]) => [key, withoutDescriptions(child)])
  );
}

describe('s92-m08 — tools/list', () => {
  it(`fits under ${TOKEN_CEILING} tokens at ${CHARS_PER_TOKEN} characters a token`, () => {
    const chars = JSON.stringify(wire()).length;
    // eslint-disable-next-line no-console
    console.log(
      `[s92-m08 tools/list] ${chars} chars ≈ ${Math.round(chars / CHARS_PER_TOKEN)} tokens`
    );
    expect(chars / CHARS_PER_TOKEN).toBeLessThanOrEqual(TOKEN_CEILING);
    // Non-vacuity: the long form is what this replaced, and it was over the line.
    expect(JSON.stringify(longForm).length / CHARS_PER_TOKEN).toBeGreaterThan(TOKEN_CEILING);
  });

  it('keeps every schema exactly: only the description text differs from the long form', () => {
    expect(withoutDescriptions(wire())).toEqual(withoutDescriptions(longForm));
  });

  it('lists the tools in one fixed order, the order they are declared in', () => {
    const first = wire().map((d) => d.name);
    expect(wire().map((d) => d.name)).toEqual(first);
    expect(first).toEqual(longForm.map((d) => d.name));
    expect(first).toEqual([
      'cmos_mission',
      'cmos_mission_transition',
      'cmos_sprint',
      'cmos_context',
      'cmos_session',
      'cmos_decisions',
      'cmos_db',
      'cmos_project',
      'cmos_learnings',
      'cmos_feedback',
      'cmos_auth',
      'cmos_message',
      'cmos_agent_onboard',
      'cmos_status',
      'cmos_review',
    ]);
  });

  it('has short text for exactly the published tools and parameters, no more', () => {
    expect(Object.keys(WIRE_TEXT).sort()).toEqual(longForm.map((d) => d.name).sort());
    for (const definition of longForm) {
      const published = Object.keys(definition.inputSchema.properties ?? {}).sort();
      expect({
        tool: definition.name,
        parameters: Object.keys(WIRE_TEXT[definition.name].parameters).sort(),
      }).toEqual({ tool: definition.name, parameters: published });
    }
  });

  it('never names actions in a parameter hint (the per-action tables do that)', () => {
    const offenders: string[] = [];
    for (const [tool, text] of Object.entries(WIRE_TEXT)) {
      for (const [parameter, hint] of Object.entries(text.parameters)) {
        if (hint && /\b[a-z_]+\s+actions?\b/i.test(hint)) offenders.push(`${tool}.${parameter}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the long form in TOOL_REFERENCE.md', () => {
    const reference = renderToolReference(longForm, CMOS_ACTION_PARAMS);
    for (const definition of longForm) {
      // The renderer escapes pipes; every long description's first sentence survives verbatim.
      const firstSentence = definition.description.split('. ')[0].replace(/\|/g, '\\|');
      expect(reference).toContain(firstSentence);
    }
  });
});

describe('s92-m08 — server instructions', () => {
  it('state the whole loop in the first 512 characters, on their own', () => {
    expect(SERVER_INSTRUCTIONS_LOOP.length).toBeLessThanOrEqual(512);
    expect(SERVER_INSTRUCTIONS.slice(0, SERVER_INSTRUCTIONS_LOOP.length)).toBe(
      SERVER_INSTRUCTIONS_LOOP
    );
    expect(SERVER_INSTRUCTIONS_LOOP.endsWith('.')).toBe(true);
    for (const step of [
      'cmos_review',
      'cmos_decisions(action="record")',
      'supersedes=',
      'Never edit a decision',
      'projectRoot',
    ]) {
      expect(SERVER_INSTRUCTIONS_LOOP).toContain(step);
    }
  });

  it('follow with a short levels paragraph, and use no internal jargon', () => {
    expect(SERVER_INSTRUCTIONS).toContain(SERVER_INSTRUCTIONS_LEVELS);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1_200);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\bs\d{2}-m\d{2}\b|sprint-\d+|#\d+|\bArc [A-Z]\b/);
  });
});
