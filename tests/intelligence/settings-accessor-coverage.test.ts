// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A settings accessor only provides compatibility when every direct product-setting read uses it.
// ABOUTME: AST scans ignore comments and writes; mutation fixtures prove both names and constant reads fire.
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

function bypasses(text: string): number[] {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const constants = new Map<string, string>();
  function collect(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      constants.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collect);
  }
  collect(source);
  const hits: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = node.expression.getText(source);
      if (['process.env', 'env', 'io.env', 'processEnv'].includes(receiver)) {
        const key = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : ts.isStringLiteral(node.argumentExpression)
            ? node.argumentExpression.text
            : (constants.get(node.argumentExpression.getText(source)) ??
              node.argumentExpression.getText(source));
        const parent = node.parent;
        const write =
          ts.isDeleteExpression(parent) ||
          (ts.isBinaryExpression(parent) &&
            parent.left === node &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
        if (!write && /^(?:CMOS|RBOOK)_/.test(key))
          hits.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return hits;
}

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(name) : /\.(?:ts|js|mjs|cjs)$/.test(name) ? [name] : [];
  });
}

test('both spelling families and local/imported setting constants trigger the accessor gate', () => {
  expect(
    bypasses(`const ROLE = 'RBOOK_AGENT_ROLE';
    process.env.RBOOK_AMBIENT;
    env['CMOS_CONFIG_DIR'];
    processEnv[ROLE];
    process.env[CMOS_DASHBOARD_API_KEY_ENV];
    // process.env.CMOS_DEBUG is prose, not a read.
    process.env.RBOOK_AMBIENT = 'off';
    delete env.CMOS_CONFIG_DIR;`)
  ).toEqual([2, 3, 4, 5]);
});

test('source and pre-package plugin direct settings reads go through compatibility', () => {
  // Scope: these named receivers and literal/local/imported CMOS_/RBOOK_ constant keys in tracked
  // source-shaped files. Dynamic names, aliases, destructuring and strings built from pieces are
  // the complement; this is not a complete dataflow proof. Generic dotenv reads are intentionally
  // outside the predicate, since their keys need not be product settings at all.
  const hits = ['src', 'plugins']
    .flatMap(sources)
    .filter((file) => !/legacy-compat\.(?:ts|mjs)$/.test(file))
    .flatMap((file) => bypasses(fs.readFileSync(file, 'utf8')).map((line) => `${file}:${line}`));
  expect(hits).toEqual([]);
});
