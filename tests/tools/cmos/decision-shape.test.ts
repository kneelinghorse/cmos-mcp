// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — the decision-shaped detector scores by its published families, and stays off:
// ABOUTME: no shipped module calls it, so turning it on is a visible change, not an accident.

import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import {
  decisionShape,
  DECISION_SHAPE_PATTERNS,
  DECISION_SHAPE_THRESHOLD,
} from '../../../src/tools/cmos/decision-shape';

const root = path.resolve(__dirname, '../../..');

/** Static import/export/require/dynamic-import literals across tracked src files, regardless of
 * extension. Computed module names are not resolved; comments and ordinary strings are not calls.
 */
function importsDetector(text: string, file = 'probe.ts'): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      specifier = node.moduleReference.expression;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      specifier = node.arguments[0];
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      /(?:^|\/)decision-shape(?:\.[cm]?[jt]s)?$/.test(specifier.text)
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('decisionShape', () => {
  it('ignores prose mentions but catches every supported module-loading syntax', () => {
    expect(importsDetector('// decision-shaped prose\nconst note = "decision-shape";')).toBe(false);
    for (const code of [
      'import { decisionShape } from "./decision-shape";',
      'export * from "./decision-shape.js";',
      'const detector = require("./decision-shape");',
      'const detector = import("./decision-shape");',
      'import detector = require("./decision-shape");',
    ])
      expect(importsDetector(code)).toBe(true);
  });
  it('flags a message that recommends and settles, and not one that merely compares in passing', () => {
    expect(
      decisionShape(
        "I'd go with SQLite here. Let's go with one file per project rather than one per user."
      )
    ).toMatchObject({ flagged: true, patternIds: ['S1', 'S2', 'S3'] });
    expect(decisionShape('I read the file instead of grepping it.')).toMatchObject({
      score: 1,
      flagged: false,
    });
    expect(decisionShape('Tests pass; the build is green.').score).toBe(0);
  });

  it('publishes four families and a threshold of two', () => {
    expect(DECISION_SHAPE_PATTERNS.map((family) => family.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(DECISION_SHAPE_THRESHOLD).toBe(2);
  });

  it('is called by no shipped module: the feature is off in 3.3.0', () => {
    const importers = execFileSync('git', ['ls-files', '-z', '--', 'src'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean)
      .filter((file) => file !== 'src/tools/cmos/decision-shape.ts')
      .filter((file) => importsDetector(fs.readFileSync(path.join(root, file), 'utf8'), file));
    expect(importers).toEqual([]);
  });
});
