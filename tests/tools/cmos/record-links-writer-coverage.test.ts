// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Every executable decision/learning INSERT must keep an explicit citation-write owner.
// ABOUTME: AST discovery excludes documentation, while mutation controls expose new or bypassed writers.

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../../src');
const owners: Record<string, { sites: number; guard: string; caller: string }> = {
  'tools/cmos/decision-write.ts': {
    sites: 1,
    guard: 'requireRecordLinks(',
    caller: 'record/capture own the synchronous transaction',
  },
  'tools/cmos/cmos-session-capture.ts': {
    sites: 1,
    guard: 'requireRecordLinks(',
    caller: 'capture owns authoritative append plus learning and links',
  },
  'tools/cmos/cmos-session-complete.ts': {
    sites: 1,
    guard: 'requireRecordLinks(',
    caller: 'close owns its decision batch before lifecycle writes',
  },
  'tools/cmos/cmos-mission-complete.ts': {
    sites: 1,
    guard: 'requireRecordLinks(',
    caller: 'each optional mission row owns a transaction',
  },
  'tools/cmos/sync-merge.ts': {
    sites: 2,
    guard: 'requireRecordLinks(',
    caller: 'standalone helper owns a transaction; pull/bootstrap own batch repair',
  },
};

// Scope: executable SQL literals/templates throughout src TypeScript. The raw seven-match
// sweep includes genesis-columns.ts's SQL documentation example, which the AST excludes.
// Complement: SQL assembled wholly at runtime, other-language scripts and test fixtures are
// not governed here; their pre-edit inventory/classification lives in the m06 sweep and map.
function sources(dir = root): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const item of sources(full)) result.set(...item);
    else if (entry.name.endsWith('.ts'))
      result.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
  }
  return result;
}

function sites(source: string): number {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:strategic_decisions|learnings)\b/i.test(node.getText(ast))
    )
      count++;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return count;
}

function violations(files: Map<string, string>): string[] {
  const failures: string[] = [];
  for (const [file, source] of files) {
    const count = sites(source);
    if (!count) continue;
    const owner = owners[file];
    if (!owner || count !== owner.sites) failures.push(`${file}: unclassified INSERT`);
    else if (!source.includes(owner.guard)) failures.push(`${file}: missing required links`);
  }
  for (const entry of [
    'cmos-decisions-record',
    'cmos-decisions-update',
    'cmos-session-capture',
    'cmos-session-complete',
    'cmos-mission-complete',
  ]) {
    const source = files.get(`tools/cmos/${entry}.ts`) ?? '';
    if (!source.includes('prepareRecordLinkWrite(') || !source.includes('.transaction('))
      failures.push(`${entry}: missing required unit`);
  }
  for (const entry of ['sync-pull', 'sync-bootstrap']) {
    const source = files.get(`tools/cmos/${entry}.ts`) ?? '';
    if (
      !source.includes('ensureRecordLinks(') ||
      !source.includes('repairRecordLinksBatch(') ||
      !source.includes('.transaction(')
    )
      failures.push(`${entry}: missing batch ownership`);
  }
  return failures;
}

it('derives all six executable INSERT sites and requires their writer ownership', () => {
  const files = sources();
  expect([...files.values()].reduce((count, source) => count + sites(source), 0)).toBe(6);
  expect(violations(files)).toEqual([]);
});

it('rejects an added writer, duplicate INSERT and removed required repair', () => {
  const files = sources();
  const sql = 'const sql = `INSERT INTO learnings(content) VALUES (?)`;';
  files.set('uncovered.ts', sql);
  expect(violations(files)).toContain('uncovered.ts: unclassified INSERT');
  const source = files.get('tools/cmos/decision-write.ts')!;
  files.set('tools/cmos/decision-write.ts', source + '\n' + sql);
  expect(violations(files)).toContain('tools/cmos/decision-write.ts: unclassified INSERT');
  files.set(
    'tools/cmos/decision-write.ts',
    source.replace('requireRecordLinks(', 'bypassedRepair(')
  );
  expect(violations(files)).toContain('tools/cmos/decision-write.ts: missing required links');
  const pull = files.get('tools/cmos/sync-pull.ts')!;
  files.set('tools/cmos/sync-pull.ts', pull.replace('repairRecordLinksBatch(', 'bypassedBatch('));
  expect(violations(files)).toContain('sync-pull: missing batch ownership');
});
