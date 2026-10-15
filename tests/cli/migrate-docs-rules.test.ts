// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m11 (#651) — migrate renames an old identifier only where it still names the old tooling.
// ABOUTME: Lines 4.0.1's migrate rewrote wrongly in the field are fixtures: hosts, file names, slugs, notes.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateIdentifiers, planDocumentEdits } from '../../src/cli/migrate-docs';
import { LEGACY } from '../../src/intelligence/legacy-compat';

// Quoted from each project's agents.md before 4.0.1's migrate rewrote it. Each project restored
// the line by hand afterwards: cmos-dashboard in 54cb719, aquex.ai in f7d0456, Meridian in place.
const DASHBOARD_HOSTS =
  '- **Hosts**: `reasonbook.ai` is canonical. `cmos.aquex.ai` and `cmos-mcp.com` redirect browser navigations (301); `reasonbook.aquex.ai` uses 302 until its launch page.';
const DASHBOARD_FORMERLY =
  '- **Reasonbook** (`@aquex/reasonbook`, formerly `cmos-mcp`): source of the uploaded SQLite records, agent-side MCP tools (`rbook_*`)';
const DASHBOARD_SCHEMES =
  '│   │   ├── cmos-address.ts    # address parser: rbook:// and cmos:// in, cmos:// on the wire';
const AQUEX_PRODUCTS =
  'Products: OODS Foundry (`@oods/foundry`, Apache-2.0), Stage1 (`@aquex/stage1`, Apache-2.0), Reasonbook, formerly CMOS (`@aquex/reasonbook`, Apache-2.0; `@aquex/cmos-mcp` is deprecated; optional dashboard at reasonbook.ai) and TraceLab (`@aquex/tracelab-mcp`, MIT adapter).';
const AQUEX_SPRINT =
  "**Current sprint (2026-10-13): S14.** Plan: [sprint-14-plan.md](cmos/planning/sprint-14-plan.md). CMOS is now Reasonbook: 4.0 renamed the tools (`rbook_*`), folders (`rbook/`), addresses (`rbook://`) and CLI (`reasonbook`). M04 moves this project's record from `cmos/` to `rbook/`; until then Reasonbook 4 reads it in place. The content authority is the [S12 content brief](cmos/planning/sprint-12-content-brief.md).";
const MERIDIAN_FILE =
  '- [src/meridian/processing/cmos_context.py](src/meridian/processing/cmos_context.py) — CMOS project state fetching';
const MERIDIAN_SLUGS =
  'oods, oods-foundry-mcp, meridian, tracelab, deepsearch, stage1, cmos-mcp, cmos-mcp-2';

describe('old names that no longer name the old tooling stay', () => {
  it.each([
    ['a host, where a dot and a letter follow (cmos-dashboard)', DASHBOARD_HOSTS],
    ['the old name after "formerly" (cmos-dashboard)', DASHBOARD_FORMERLY],
    ['a line that names both schemes on purpose (cmos-dashboard)', DASHBOARD_SCHEMES],
    ['the deprecated package beside its successor (aquex.ai)', AQUEX_PRODUCTS],
    ['a file name (Meridian)', MERIDIAN_FILE],
    ['a project slug in a list (Meridian)', MERIDIAN_SLUGS],
  ])('leaves %s', (_case, line) => {
    expect(migrateIdentifiers(line, true)).toBe(line);
  });

  it('moves links into the record folder but keeps the folder pair a note names (aquex.ai agents.md:87)', () => {
    expect(migrateIdentifiers(AQUEX_SPRINT, true)).toBe(
      AQUEX_SPRINT.replace(
        '(cmos/planning/sprint-14-plan.md)',
        '(rbook/planning/sprint-14-plan.md)'
      ).replace(
        '(cmos/planning/sprint-12-content-brief.md)',
        '(rbook/planning/sprint-12-content-brief.md)'
      )
    );
  });
});

describe('old names that still name the old tooling are renamed', () => {
  it.each([
    [
      'the command before its verb',
      '`cmos-mcp ambient off` turns the hooks off here.',
      '`reasonbook ambient off` turns the hooks off here.',
    ],
    [
      'the command after npx',
      'Run `npx -y cmos-mcp init --level builder`.',
      'Run `npx -y reasonbook init --level builder`.',
    ],
    ['the command before a flag', 'cmos-mcp --version', 'reasonbook --version'],
    ['a tool', 'Call `cmos_review()` first.', 'Call `rbook_review()` first.'],
    [
      'the tool glob',
      'Use the shared CMOS MCP tools (`cmos_*`) for project management.',
      'Use the shared CMOS MCP tools (`rbook_*`) for project management.',
    ],
    ['a setting', 'Set CMOS_CONFIG_DIR to a folder.', 'Set RBOOK_CONFIG_DIR to a folder.'],
    [
      'an address',
      'One message to `cmos://derek/forge` per release.',
      'One message to `rbook://derek/forge` per release.',
    ],
    ['the package', 'npm install -g @aquex/cmos-mcp', 'npm install -g @aquex/reasonbook'],
    [
      'paths into the moved record',
      'See cmos/docs/guide.md and cmos/db/cmos.sqlite.',
      'See rbook/docs/guide.md and rbook/db/rbook.sqlite.',
    ],
    [
      'the record folder on a line with no note',
      'Never write application code into `cmos/`.',
      'Never write application code into `rbook/`.',
    ],
  ])('renames %s', (_case, before, after) => {
    expect(migrateIdentifiers(before, true)).toBe(after);
  });

  it('leaves record paths alone until the record folder moves', () => {
    expect(migrateIdentifiers('See cmos/docs/guide.md.', false)).toBe('See cmos/docs/guide.md.');
  });
});

describe('documents a migration plans', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-rules-'));
    fs.mkdirSync(path.join(root, LEGACY.recordDirectory, 'tiers'), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = () => path.join(root, LEGACY.recordDirectory);
  const edited = (file: string) =>
    planDocumentEdits(root, record(), true).edits.find((edit) => edit.file === file);

  it('renames .mcp.json values but never a server key outside mcpServers', () => {
    // Synthesis-Workbench's file: top-level entries, one running the old package from its source.
    const file = path.join(root, '.mcp.json');
    const text = JSON.stringify(
      {
        aquex: { command: 'aquex', args: ['serve', '--stdio'] },
        'cmos-mcp': { command: 'node', args: ['/Users/someone/cmos-mcp/dist/index.js'] },
      },
      null,
      2
    );
    fs.writeFileSync(file, text + '\n');
    expect(edited(file)).toBeUndefined();
  });

  it('moves the standard server entry to rbook and renames its command', () => {
    const file = path.join(root, '.mcp.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { 'cmos-mcp': { command: 'cmos-mcp', args: ['serve'] } } })
    );
    expect(JSON.parse(edited(file)!.after)).toEqual({
      mcpServers: { rbook: { command: 'reasonbook', args: ['serve'] } },
    });
  });

  it("leaves the old package's own source documents, reports them, and still moves its record files", () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: LEGACY.packageName, version: '1.0.1' })
    );
    const agents = path.join(root, 'agents.md');
    fs.writeFileSync(
      agents,
      '- `src/tools/cmos/` - tool implementations\n- `cmos/` - the record\nUse `cmos_review`.\n'
    );
    const guide = path.join(record(), 'tiers', 'build.md');
    fs.writeFileSync(guide, 'Call `cmos_review()` and read cmos/tiers/build.md.\n');
    const plan = planDocumentEdits(root, record(), true);
    expect(plan.edits.map((edit) => edit.file)).toEqual([guide]);
    expect(plan.edits[0].after).toBe('Call `rbook_review()` and read rbook/tiers/build.md.\n');
    expect(plan.left.join('\n')).toContain(`${agents}: left unchanged`);
    expect(plan.left.join('\n')).toMatch(/1 line names the record folder/);
  });
});
