// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m08 — what a client pays for: tools/list under a 6K-token ceiling in a fixed order,
// ABOUTME: the same schemas as the long form, and server instructions whose first 512 chars stand alone.

import { describe, expect, it } from '@jest/globals';

import { getToolDefinitions } from '../../../src/index';
import {
  SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS_LEVELS,
  SERVER_INSTRUCTIONS_LOOP,
  SERVER_INSTRUCTIONS_PROPOSALS,
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

  // s93-m06: the convention reaches every harness, hook-less ones included, inside the ceiling.
  it('say which choices wait for the operator, and how to put one to them', () => {
    expect(SERVER_INSTRUCTIONS.endsWith(SERVER_INSTRUCTIONS_PROPOSALS)).toBe(true);
    expect(SERVER_INSTRUCTIONS_PROPOSALS).toContain('Would record: <decision and reason>');
    expect(SERVER_INSTRUCTIONS_PROPOSALS).toContain('fromDraft when CMOS gave it an id');
    expect(SERVER_INSTRUCTIONS_PROPOSALS).toMatch(/scope, cost, outside commitments/);
    expect(SERVER_INSTRUCTIONS_PROPOSALS).toMatch(/your own remit directly/);
  });
});

/**
 * s93-m11 (#604; operator Q3, decision #1163): CMOS is positioned as the record keeper agents keep,
 * "decisions that survive the session", never as "memory". This is the positioning check beside the
 * jargon check above.
 *
 * SCOPE AND WHAT IT CANNOT SEE (one contract). Scope: every string literal in src/ (the text the
 * server can send), the shipped seed, README.md, docs/getting-started.md, TOOL_REFERENCE.md and
 * SECURITY.md, matched on the word "memory" in any case. Rendered onboard text is composed at run
 * time, so it is checked by sampling: a fresh general-tier and build-tier onboard, not every state.
 * Not seen: CHANGELOG.md (a release record), code comments and module paths in imports (never
 * sent), and synonyms of the word.
 * Allowed: a technical term ("in-memory", SQLite's ":memory:") and the path of the agent-local
 * folder AGENTS.md tells agents never to write (~/.claude/projects/.../memory/), which names a
 * folder, not CMOS.
 */
describe('s93-m11 — no shipped self-description calls CMOS memory', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const ts = require('typescript') as typeof import('typescript');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const WORD = /\bmemory\b/i;
  const ALLOWED = [/in-memory/i, /:memory:/, /~\/\.claude\/projects\/\.\.\.\/memory\//];
  const offends = (text: string): boolean =>
    WORD.test(ALLOWED.reduce((rest, allowed) => rest.replace(new RegExp(allowed, 'gi'), ''), text));

  function walk(dir: string, keep: (file: string) => boolean): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full, keep));
      else if (keep(full)) out.push(full);
    }
    return out;
  }

  it('no string literal in src/ says it', () => {
    const hits: string[] = [];
    for (const file of walk(path.join(ROOT, 'src'), (f) => f.endsWith('.ts'))) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      const visit = (node: import('typescript').Node): void => {
        const isModulePath =
          ts.isStringLiteral(node) &&
          (ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent) ||
            (ts.isCallExpression(node.parent) &&
              (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.parent.expression) &&
                  node.parent.expression.text === 'require'))));
        if (
          !isModulePath &&
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)) &&
          offends(node.text)
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          hits.push(`${path.relative(ROOT, file)}:${line + 1}: ${node.text.slice(0, 80)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(hits).toEqual([]);
  });

  it('no shipped document or seed file says it', () => {
    const shipped = [
      ...walk(path.join(ROOT, 'cmos-seed'), () => true),
      ...['README.md', 'docs/getting-started.md', 'TOOL_REFERENCE.md', 'SECURITY.md'].map((f) =>
        path.join(ROOT, f)
      ),
    ];
    const hits: string[] = [];
    for (const file of shipped) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (offends(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('the rendered onboard text does not say it (sampled: a fresh general and a build project)', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const os = require('os') as typeof import('os');
    const { cmosAgentOnboard, formatAgentOnboardForLLM } =
      require('../../../src/tools/cmos/cmos-agent-onboard') as typeof import('../../../src/tools/cmos/cmos-agent-onboard');
    const { seedCmosDb } =
      require('../../helpers/seedCmosDb') as typeof import('../../helpers/seedCmosDb');
    /* eslint-enable @typescript-eslint/no-require-imports */
    for (const tier of ['general', 'build']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `cmos-s93m11-memory-${tier}-`));
      try {
        seedCmosDb(root, { projectName: `positioning ${tier}`, tier });
        const onboard = await cmosAgentOnboard({
          projectRoot: root,
          callerProvidedProjectRoot: true,
        });
        expect(onboard.success).toBe(true);
        expect(offends(formatAgentOnboardForLLM(onboard))).toBe(false);
        expect(offends(JSON.stringify(onboard.data))).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
