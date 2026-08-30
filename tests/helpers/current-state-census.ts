// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Syntax-level currentState emit census and mutation helpers for answer-shape tests.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../..');
export const CMOS_SOURCE_ROOT = path.join(REPO_ROOT, 'src', 'tools', 'cmos');
export const EXPECTED_INTERPOLATION_FILES = [
  'cmos-mission-block.ts',
  'cmos-mission-complete.ts',
  'cmos-mission-defer.ts',
  'cmos-mission-drop.ts',
  'cmos-mission-move.ts',
  'cmos-mission-start.ts',
  'cmos-mission-unblock.ts',
  'cmos-mission-update.ts',
] as const;

export interface SourceText {
  readonly relativePath: string;
  readonly text: string;
}

export interface EmitCensus {
  readonly assignments: number;
  readonly directObjectLiterals: number;
  readonly objectLiteralFiles: readonly string[];
  readonly interpolationFiles: readonly string[];
}

function walkTypeScriptFiles(root: string): string[] {
  if (!fs.existsSync(root)) throw new Error(`currentState source root does not exist: ${root}`);
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files.sort();
}

export function loadSourceTexts(root: string): SourceText[] {
  return walkTypeScriptFiles(root).map((file) => ({
    relativePath: path.relative(root, file).split(path.sep).join('/'),
    text: fs.readFileSync(file, 'utf8'),
  }));
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

export function censusCurrentState(sources: readonly SourceText[]): EmitCensus {
  let assignments = 0;
  let directObjectLiterals = 0;
  const objectLiteralFiles: string[] = [];
  const interpolationFiles: string[] = [];
  for (const source of sources) {
    const sourceFile = ts.createSourceFile(
      source.relativePath,
      source.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === 'currentState') ||
          (ts.isStringLiteral(node.name) && node.name.text === 'currentState'))
      ) {
        assignments += 1;
        if (ts.isObjectLiteralExpression(unwrapParentheses(node.initializer))) {
          directObjectLiterals += 1;
          objectLiteralFiles.push(source.relativePath);
        }
      }
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) {
          const expression = span.expression;
          if (
            ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            expression.expression.text === 'error' &&
            expression.name.text === 'currentState'
          ) {
            interpolationFiles.push(source.relativePath);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return {
    assignments,
    directObjectLiterals,
    objectLiteralFiles: objectLiteralFiles.sort(),
    interpolationFiles: interpolationFiles.sort(),
  };
}

const EMIT_RISK =
  'A second object emit would render `[object Object]` at any of these unguarded formatter ' +
  `sites: ${EXPECTED_INTERPOLATION_FILES.join(', ')}.`;

export function emitCensusFindings(census: EmitCensus): string[] {
  const findings: string[] = [];
  if (census.assignments !== 15) {
    findings.push(
      `Expected 15 direct currentState property assignments; found ${census.assignments}.`
    );
  }
  if (census.directObjectLiterals !== 1) {
    findings.push(
      `Expected exactly 1 direct currentState object-literal emit; found ${census.directObjectLiterals} ` +
        `in [${census.objectLiteralFiles.join(', ')}].`
    );
  }
  if (census.objectLiteralFiles.join('\n') !== 'cmos-session-start.ts') {
    findings.push(
      `The sole direct object emit must remain in cmos-session-start.ts; found [${census.objectLiteralFiles.join(', ')}].`
    );
  }
  if (census.interpolationFiles.join('\n') !== EXPECTED_INTERPOLATION_FILES.join('\n')) {
    findings.push(
      `Expected the 8 known unguarded interpolation files; found [${census.interpolationFiles.join(', ')}].`
    );
  }
  return findings.map((finding) => `${finding} ${EMIT_RISK}`);
}

export function replaceExactlyOnce(source: SourceText, before: string, after: string): SourceText {
  const first = source.text.indexOf(before);
  if (first < 0 || first !== source.text.lastIndexOf(before)) {
    throw new Error(
      `Deliberate-fire fixture expected exactly one ${JSON.stringify(before)} in ${source.relativePath}`
    );
  }
  return {
    relativePath: source.relativePath,
    text: `${source.text.slice(0, first)}${after}${source.text.slice(first + before.length)}`,
  };
}
