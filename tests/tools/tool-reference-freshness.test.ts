// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m06 drift gate — re-render TOOL_REFERENCE.md from the SRC tool
// definitions with the SAME shared renderer the build hook uses, and fail if the
// committed file drifts. Keeps the shipped/documented tool surface honest.

import * as fs from 'fs';
import * as path from 'path';
import { CMOS_TOOL_DEFINITIONS } from '../../src/tools/cmos/index';

// The build hook (scripts/generate-tool-reference.js) and this test import the SAME
// renderer, so identical tool defs → identical bytes (no false drift). It is a plain
// CommonJS module with no type declarations; require keeps it out of the TS graph.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderToolReference } = require('../../scripts/lib/render-tool-reference');

const TOOL_REFERENCE_PATH = path.resolve(__dirname, '../../TOOL_REFERENCE.md');

describe('TOOL_REFERENCE.md freshness gate (s77-m06)', () => {
  it('matches the committed file byte-for-byte (rebuild + commit if this fails)', () => {
    const committed = fs.readFileSync(TOOL_REFERENCE_PATH, 'utf8');
    const rendered = renderToolReference(CMOS_TOOL_DEFINITIONS);

    if (rendered !== committed) {
      throw new Error(
        'TOOL_REFERENCE.md is stale. Run `npm run build` to regenerate it from the current ' +
          'tool definitions and commit the result.'
      );
    }
    expect(rendered).toBe(committed);
  });

  it('renders every registered tool, including the s77-m05 cmos_session search action', () => {
    const rendered: string = renderToolReference(CMOS_TOOL_DEFINITIONS);

    for (const tool of CMOS_TOOL_DEFINITIONS) {
      expect(rendered).toContain(`## ${tool.name}`);
    }
    // Ground-truth spot checks the drifted README table used to get wrong.
    expect(rendered).toContain('# CMOS MCP Tool Reference');
    expect(rendered).toMatch(/## cmos_session[\s\S]*\*\*Actions:\*\*[^\n]*`search`/);
    expect(rendered).toMatch(/## cmos_db[\s\S]*\*\*Actions:\*\*[^\n]*`clone`/);
  });

  it('re-rendering with an injected fake action would break the byte match (drift is caught)', () => {
    const committed = fs.readFileSync(TOOL_REFERENCE_PATH, 'utf8');
    // Simulate a tool-definition change without touching the committed file: the
    // gate must go red. (This is what a real enum/param edit does before a rebuild.)
    const mutated = CMOS_TOOL_DEFINITIONS.map((tool, i) =>
      i === 0
        ? {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: {
                ...(tool.inputSchema as { properties?: Record<string, unknown> }).properties,
                __fake_probe__: { type: 'string', description: 'injected drift probe' },
              },
            },
          }
        : tool
    );
    const rendered = renderToolReference(mutated);
    expect(rendered).not.toBe(committed);
    expect(rendered).toContain('__fake_probe__');
  });
});
