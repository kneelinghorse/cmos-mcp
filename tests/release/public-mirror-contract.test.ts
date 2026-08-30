// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Parser-backed contract for private-evidence tests that are copied into the public mirror.
// ABOUTME: Proves fail-loud routing without duplicating the mirror script's exclusion lists.

import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import {
  isMirrorExcluded,
  parseMirrorExclusions,
  readMirrorExclusions,
  requiresPrivateEvidence,
  type MirrorExclusions,
} from '../helpers/public-mirror';

const REPO_ROOT = path.resolve(__dirname, '../..');
const CONTRACT_FILE = 'tests/release/public-mirror-contract.test.ts';
const HELPER_FILE = 'tests/helpers/public-mirror.ts';
const fixtureRoots: string[] = [];

function mirrorFixture(withPrivateMarker = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-public-mirror-contract-'));
  fixtureRoots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'mirror-to-public.sh'),
    'PRIVATE_PATHS=( private-root )\nDOCS_EXCLUDES=( internal/doc.md )\n'
  );
  if (withPrivateMarker) fs.mkdirSync(path.join(root, 'private-root'), { recursive: true });
  return root;
}

// A revision-only scope is the hardest declaration-time case: the public mirror has neither a
// private path nor the private source commit. The wrapper must register its own skipped body and
// must never call the consumer callback while Jest constructs the tree.
let syntheticMirrorBodyInvoked = false;
const SYNTHETIC_MIRROR_ROOT = mirrorFixture();
const SYNTHETIC_REVISION_SCOPE = requiresPrivateEvidence(
  {
    reason: 'synthetic private revision is absent from this structural public-mirror fixture',
    revisions: { boundary: 'private-boundary-that-does-not-exist' },
  },
  SYNTHETIC_MIRROR_ROOT
);
SYNTHETIC_REVISION_SCOPE.describe('synthetic revision-only public mirror scope', () => {
  syntheticMirrorBodyInvoked = true;
  it('would be unsafe to declare', () => expect('private evidence').toBe('available'));
});

afterAll(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

type Finding = Readonly<{ file: string; line: number; kind: string }>;
type FileAudit = Readonly<{
  routed: boolean;
  hasPaths: boolean;
  hasRevisions: boolean;
  findings: readonly Finding[];
}>;

const PATH_SINKS = new Set([
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'open',
  'openSync',
  'existsSync',
  'access',
  'accessSync',
  'createReadStream',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
]);

function nameOf(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function property(
  object: ts.ObjectLiteralExpression,
  key: string
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && nameOf(candidate.name as ts.Expression) === key
  );
}

function literals(object: ts.ObjectLiteralExpression): string[] {
  return object.properties.map((entry) => {
    if (!ts.isPropertyAssignment(entry) || !ts.isStringLiteralLike(entry.initializer)) {
      throw new Error('Private-evidence maps must contain only named string literals');
    }
    return entry.initializer.text;
  });
}

type Trace = Readonly<{
  parts: readonly string[];
  routedPath: boolean;
  routedRevision: boolean;
  pathOwners: readonly string[];
  revisionOwners: readonly string[];
  repoAnchor: boolean;
  unknownRoot: boolean;
}>;
const EMPTY_TRACE: Trace = {
  parts: [],
  routedPath: false,
  routedRevision: false,
  pathOwners: [],
  revisionOwners: [],
  repoAnchor: false,
  unknownRoot: false,
};

function combine(traces: readonly Trace[]): Trace {
  return {
    parts: traces.flatMap((trace) => trace.parts),
    routedPath: traces.some((trace) => trace.routedPath),
    routedRevision: traces.some((trace) => trace.routedRevision),
    pathOwners: [...new Set(traces.flatMap((trace) => trace.pathOwners))],
    revisionOwners: [...new Set(traces.flatMap((trace) => trace.revisionOwners))],
    repoAnchor: traces.some((trace) => trace.repoAnchor),
    unknownRoot: traces.some((trace) => trace.unknownRoot),
  };
}

function expressionTrace(
  expression: ts.Expression,
  declarations: ReadonlyMap<string, ts.Expression>,
  evidenceVariables: ReadonlySet<string>,
  seen = new Set<string>()
): Trace {
  if (ts.isStringLiteralLike(expression)) return { ...EMPTY_TRACE, parts: [expression.text] };
  if (ts.isIdentifier(expression)) {
    if (expression.text === '__dirname') return EMPTY_TRACE;
    for (let parent: ts.Node | undefined = expression.parent; parent; parent = parent.parent) {
      if (
        ts.isFunctionLike(parent) &&
        parent.parameters.some(
          (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === expression.text
        )
      )
        return { ...EMPTY_TRACE, unknownRoot: true };
    }
    const rootName = /^(?:REPO_ROOT|ROOT|projectRoot)$/.test(expression.text);
    const initializer = declarations.get(expression.text);
    const carriesEvidence =
      initializer &&
      [...evidenceVariables].some(
        (owner) =>
          initializer.getText().includes(`${owner}.paths`) ||
          initializer.getText().includes(`${owner}.revisions`)
      );
    if (!rootName && !/^[A-Z][A-Z0-9_]*$/.test(expression.text) && !carriesEvidence) {
      return { ...EMPTY_TRACE, unknownRoot: true };
    }
    if (!initializer || seen.has(expression.text)) return { ...EMPTY_TRACE, unknownRoot: true };
    if (rootName && /__dirname/.test(initializer.getText())) {
      return { ...EMPTY_TRACE, repoAnchor: true };
    }
    const nextSeen = new Set(seen).add(expression.text);
    const traced = expressionTrace(initializer, declarations, evidenceVariables, nextSeen);
    return traced;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = expression.expression;
    if (ts.isPropertyAccessExpression(owner) && ts.isIdentifier(owner.expression)) {
      if (evidenceVariables.has(owner.expression.text) && owner.name.text === 'paths') {
        return {
          ...EMPTY_TRACE,
          routedPath: true,
          pathOwners: [owner.expression.text],
        };
      }
      if (evidenceVariables.has(owner.expression.text) && owner.name.text === 'revisions') {
        return {
          ...EMPTY_TRACE,
          routedRevision: true,
          revisionOwners: [owner.expression.text],
        };
      }
    }
    return expressionTrace(owner, declarations, evidenceVariables, seen);
  }
  if (ts.isTemplateExpression(expression)) {
    return combine([
      { ...EMPTY_TRACE, parts: [expression.head.text] },
      ...expression.templateSpans.flatMap((span) => [
        expressionTrace(span.expression, declarations, evidenceVariables, seen),
        { ...EMPTY_TRACE, parts: [span.literal.text] },
      ]),
    ]);
  }
  if (ts.isBinaryExpression(expression)) {
    return combine([
      expressionTrace(expression.left, declarations, evidenceVariables, seen),
      expressionTrace(expression.right, declarations, evidenceVariables, seen),
    ]);
  }
  if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return expressionTrace(expression.expression, declarations, evidenceVariables, seen);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return combine(
      expression.elements.map((item) =>
        expressionTrace(item, declarations, evidenceVariables, seen)
      )
    );
  }
  if (ts.isCallExpression(expression)) {
    const traced = combine(
      expression.arguments.map((item) =>
        expressionTrace(item, declarations, evidenceVariables, seen)
      )
    );
    return ['join', 'resolve'].includes(nameOf(expression.expression) ?? '')
      ? traced
      : { ...traced, unknownRoot: true };
  }
  return EMPTY_TRACE;
}

function tracesExcludedPath(trace: Trace, exclusions: MirrorExclusions): boolean {
  if (trace.routedPath) return false;
  if (!trace.repoAnchor && trace.unknownRoot) return false;
  const joined = path.posix.normalize(trace.parts.join('/').replace(/\/{2,}/g, '/'));
  return isMirrorExcluded(joined, exclusions);
}

function containsParameter(expression: ts.Node, parameter: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === parameter) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function auditSource(file: string, sourceText: string, exclusions: MirrorExclusions): FileAudit {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declarations = new Map<string, ts.Expression>();
  const evidenceVariables = new Set<string>();
  const findings: Finding[] = [];
  const add = (node: ts.Node, kind: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.push({ file, line, kind });
  };
  let hasPaths = false;
  let hasRevisions = false;

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer);
      if (
        ts.isCallExpression(node.initializer) &&
        nameOf(node.initializer.expression) === 'requiresPrivateEvidence'
      ) {
        evidenceVariables.add(node.name.text);
        const config = node.initializer.arguments[0];
        if (!config || !ts.isObjectLiteralExpression(config)) add(node, 'dynamic helper config');
        else {
          for (const [key, mark] of [
            ['paths', 'path'] as const,
            ['revisions', 'revision'] as const,
          ]) {
            const entry = property(config, key);
            if (!entry) continue;
            if (!ts.isObjectLiteralExpression(entry.initializer)) add(entry, `dynamic ${mark} map`);
            else {
              const values = literals(entry.initializer);
              if (key === 'paths') {
                hasPaths = true;
                for (const value of values)
                  if (!isMirrorExcluded(value, exclusions))
                    add(entry, `unexcluded declared path: ${value}`);
              } else hasRevisions = true;
            }
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const wrapperSinks = new Map<string, Set<number>>();
  const revisionWrapperSinks = new Map<string, Set<number>>();
  const namedFunctions = new Set<string>();
  const summarizeFunction = (
    name: string,
    parameters: readonly ts.ParameterDeclaration[],
    body: ts.Node
  ): void => {
    const indices = new Set<number>();
    const revisionIndices = new Set<number>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && PATH_SINKS.has(nameOf(node.expression) ?? '')) {
        parameters.forEach((parameter, index) => {
          if (
            ts.isIdentifier(parameter.name) &&
            node.arguments[0] &&
            containsParameter(node.arguments[0], parameter.name.text)
          )
            indices.add(index);
        });
      }
      if (ts.isNewExpression(node) && nameOf(node.expression) === 'Database') {
        parameters.forEach((parameter, index) => {
          if (
            ts.isIdentifier(parameter.name) &&
            node.arguments?.[0] &&
            containsParameter(node.arguments[0], parameter.name.text)
          )
            indices.add(index);
        });
      }
      if (
        ts.isCallExpression(node) &&
        (nameOf(node.expression) === 'execFileSync' || nameOf(node.expression) === 'spawnSync') &&
        node.arguments[0]?.getText(source).replace(/["']/g, '') === 'git' &&
        node.arguments[1]
      ) {
        parameters.forEach((parameter, index) => {
          if (
            ts.isIdentifier(parameter.name) &&
            containsParameter(node.arguments[1], parameter.name.text)
          )
            revisionIndices.add(index);
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    if (indices.size > 0) wrapperSinks.set(name, indices);
    if (revisionIndices.size > 0) revisionWrapperSinks.set(name, revisionIndices);
    namedFunctions.add(name);
  };
  source.forEachChild(function visit(node): void {
    if (ts.isFunctionDeclaration(node) && node.name && node.body)
      summarizeFunction(node.name.text, node.parameters, node.body);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      summarizeFunction(node.name.text, node.initializer.parameters, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  });

  let routedDescribe = false;
  const routedDescribeOwner = (callee: ts.Expression): string | undefined => {
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      evidenceVariables.has(callee.expression.text) &&
      callee.name.text === 'describe'
    )
      return callee.expression.text;
    if (!ts.isIdentifier(callee)) return undefined;
    const alias = declarations.get(callee.text);
    return alias &&
      alias &&
      ts.isPropertyAccessExpression(alias) &&
      ts.isIdentifier(alias.expression) &&
      evidenceVariables.has(alias.expression.text) &&
      alias.name.text === 'describe'
      ? alias.expression.text
      : undefined;
  };
  const safeRoots = new Map<string, ts.Node[]>();
  const callSites = new Map<string, ts.CallExpression[]>();
  source.forEachChild(function visit(node): void {
    if (ts.isCallExpression(node)) {
      const calleeName = nameOf(node.expression);
      if (calleeName && namedFunctions.has(calleeName)) {
        const sites = callSites.get(calleeName) ?? [];
        sites.push(node);
        callSites.set(calleeName, sites);
      }
      const owner = routedDescribeOwner(node.expression);
      const callback = node.arguments.find(
        (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
      );
      if (owner && callback) {
        const roots = safeRoots.get(owner) ?? [];
        roots.push(callback);
        safeRoots.set(owner, roots);
      }
    }
    ts.forEachChild(node, visit);
  });
  const containingFunction = (start: ts.Node): string | undefined => {
    for (let node: ts.Node | undefined = start.parent; node; node = node.parent) {
      if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
      if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)
      )
        return node.parent.name.text;
    }
    return undefined;
  };
  const isInside = (node: ts.Node, root: ts.Node): boolean =>
    node.getStart(source) >= root.getStart(source) && node.getEnd() <= root.getEnd();
  const isProtected = (owner: string, node: ts.Node, visiting = new Set<string>()): boolean => {
    if ((safeRoots.get(owner) ?? []).some((root) => isInside(node, root))) return true;
    const functionName = containingFunction(node);
    if (!functionName || visiting.has(functionName)) return false;
    const sites = callSites.get(functionName) ?? [];
    if (sites.length === 0) return false;
    const next = new Set(visiting).add(functionName);
    return sites.every((site) => isProtected(owner, site, next));
  };
  const isNegativeExistenceOracle = (node: ts.CallExpression): boolean => {
    if (!['existsSync', 'access', 'accessSync'].includes(nameOf(node.expression) ?? ''))
      return false;
    let statement: ts.Node = node;
    while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
    const text = statement.getText(source);
    return (
      /expect\s*\(/.test(text) &&
      /\.(?:toBe\(false\)|not\.toBe\(true\)|toThrow(?:Error)?\()/.test(text)
    );
  };
  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (routedDescribeOwner(callee)) routedDescribe = true;
      const sinkIndices = PATH_SINKS.has(nameOf(callee) ?? '')
        ? new Set([0])
        : wrapperSinks.get(nameOf(callee) ?? '');
      for (const index of sinkIndices ?? []) {
        const argument = node.arguments[index];
        if (!argument) continue;
        const trace = expressionTrace(argument, declarations, evidenceVariables);
        if (trace.routedPath && trace.pathOwners.some((owner) => !isProtected(owner, node)))
          add(argument, 'routed private path sink outside its private scope');
        else if (tracesExcludedPath(trace, exclusions) && !isNegativeExistenceOracle(node))
          add(argument, 'unrouted excluded-path sink');
      }
      for (const index of revisionWrapperSinks.get(nameOf(callee) ?? '') ?? []) {
        const argument = node.arguments[index];
        if (!argument) continue;
        const trace = expressionTrace(argument, declarations, evidenceVariables);
        if (trace.routedRevision && trace.revisionOwners.some((owner) => !isProtected(owner, node)))
          add(argument, 'routed private revision sink outside its private scope');
      }
      const gitArgs = node.arguments[1];
      if (
        (nameOf(callee) === 'execFileSync' || nameOf(callee) === 'spawnSync') &&
        node.arguments[0]?.getText(source).replace(/["']/g, '') === 'git' &&
        gitArgs
      ) {
        const trace = expressionTrace(gitArgs, declarations, evidenceVariables);
        if (trace.routedRevision && trace.revisionOwners.some((owner) => !isProtected(owner, node)))
          add(gitArgs, 'routed private revision sink outside its private scope');
        else if (
          !trace.routedRevision &&
          /(?:^|[^0-9a-f])[0-9a-f]{7,40}(?=[^0-9a-f]|$)/i.test(trace.parts.join(''))
        )
          add(gitArgs, 'unrouted fixed git revision');
      }
    }
    if (ts.isNewExpression(node) && nameOf(node.expression) === 'Database' && node.arguments?.[0]) {
      const trace = expressionTrace(node.arguments[0], declarations, evidenceVariables);
      if (trace.routedPath && trace.pathOwners.some((owner) => !isProtected(owner, node)))
        add(node.arguments[0], 'routed private path sink outside its private scope');
      else if (tracesExcludedPath(trace, exclusions))
        add(node.arguments[0], 'unrouted excluded-path Database');
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      node.right.getText(source) === '0' &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'length' &&
      ts.isIdentifier(node.left.expression)
    ) {
      const initializer = declarations.get(node.left.expression.text);
      if (
        initializer &&
        ts.isCallExpression(initializer) &&
        nameOf(initializer.expression) === 'filter' &&
        /existsSync/.test(initializer.getText(source))
      )
        add(node, 'local structural-mirror classifier');
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  if (evidenceVariables.size > 0 && !routedDescribe)
    add(source, 'private evidence declared without routed describe');
  return { routed: evidenceVariables.size > 0, hasPaths, hasRevisions, findings };
}

function trackedTestFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', 'tests'], { cwd: REPO_ROOT })
    .toString()
    .split('\0')
    .filter(
      (file) =>
        /\.(?:test|e2e|fire)\.ts$/.test(file) && ![CONTRACT_FILE, HELPER_FILE].includes(file)
    );
}

const KNOWN_STATIC_FALSE_NEGATIVES = [
  {
    profile: 'indirect production-side CWD read',
    exemplar: 'tests/index.runtime.test.ts',
    reason:
      'The bounded AST pass sees test-side filesystem and git sinks, but a called production resolver can derive cmos/ from process.cwd() before a mocked handler runs. The four index.runtime error-path cases use seeded explicit project roots, and the faithful public-mirror full-suite run remains the behavioral backstop.',
  },
  {
    profile: 'repository checkout assumed outside tmpdir',
    exemplar: 'tests/tools/cmos/real-store-guard.test.ts',
    reason:
      'The static pass cannot infer that public verification stages the repository beneath os.tmpdir(), which changes a repo-relative isolation sentinel from forbidden to allowed. The guard tests use a deterministic root-level non-tmpdir sentinel, and the faithful public-mirror full-suite run remains the behavioral backstop.',
  },
] as const;

describe('public mirror exclusion parser and helper', () => {
  it('parses literal arrays and rejects executable, duplicate, or non-normal shell input', () => {
    expect(
      parseMirrorExclusions("PRIVATE_PATHS=( alpha 'nested/path' )\nDOCS_EXCLUDES=( docs/one.md )")
        .all
    ).toEqual(['alpha', 'nested/path', 'docs/one.md']);
    for (const source of [
      'PRIVATE_PATHS=( alpha alpha )\nDOCS_EXCLUDES=( docs/x )',
      'PRIVATE_PATHS=( ../escape )\nDOCS_EXCLUDES=( docs/x )',
      'PRIVATE_PATHS=( alpha )\nPRIVATE_PATHS=( beta )\nDOCS_EXCLUDES=( docs/x )',
      'PRIVATE_PATHS=( alpha )\nDOCS_EXCLUDES=( alpha )',
    ])
      expect(() => parseMirrorExclusions(source)).toThrow();

    const sentinel = path.join(mirrorFixture(), 'parser-must-not-execute');
    expect(() =>
      parseMirrorExclusions(`PRIVATE_PATHS=( $(touch ${sentinel}) )\nDOCS_EXCLUDES=( docs/x )`)
    ).toThrow();
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('skips loudly only in a structural mirror and never invokes a revision-only callback', () => {
    expect(SYNTHETIC_REVISION_SCOPE.isPublicMirror).toBe(true);
    expect(syntheticMirrorBodyInvoked).toBe(false);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const mirror = requiresPrivateEvidence(
      { reason: 'printed path reason', paths: { proof: 'private-root/proof.txt' } },
      mirrorFixture()
    );
    expect(mirror.isPublicMirror).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/printed path reason.*Missing:/));
    log.mockRestore();
  });

  it('throws on private absence and every unsafe requested-path spelling', () => {
    const privateRoot = mirrorFixture(true);
    expect(() =>
      requiresPrivateEvidence(
        { reason: 'must fail', paths: { proof: 'private-root/missing.txt' } },
        privateRoot
      )
    ).toThrow(/missing outside the structural public mirror/);
    for (const proof of [
      '../escape',
      'private-root/../escape',
      'private-root//escape',
      '/private-root/escape',
    ]) {
      expect(() =>
        requiresPrivateEvidence({ reason: 'must fail', paths: { proof } }, privateRoot)
      ).toThrow(/safe relative path/);
    }
  });
});

describe('public mirror routed-test class gate', () => {
  const exclusions = readMirrorExclusions(REPO_ROOT);

  it('derives both exclusion classes and pins the README/script mirror contract', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/mirror-to-public.sh'), 'utf8');
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    expect(exclusions.privatePaths.length).toBeGreaterThan(0);
    expect(exclusions.docsExcludes.length).toBeGreaterThan(0);
    expect(isMirrorExcluded('.github/workflows/publish.yml', exclusions)).toBe(true);
    expect(isMirrorExcluded('tests', exclusions)).toBe(false);
    expect(script).toMatch(/git archive --format=tar HEAD/);
    expect(script).toMatch(/for p in "\$\{PRIVATE_PATHS\[@\]\}";.*RSYNC_EXCLUDES/s);
    expect(script).toMatch(/for d in "\$\{DOCS_EXCLUDES\[@\]\}";.*RSYNC_EXCLUDES/s);
    expect(script).toMatch(/"\$\{PRIVATE_PATHS\[@\]\}" "\$\{DOCS_EXCLUDES\[@\]\}"; do rm -rf/);
    expect(readme).toContain(
      'This public repository is a code mirror;\nrelease validation and npm publishing run from the private source.'
    );
  });

  it('fires on raw paths, same-file wrappers, fixed revisions, and local mirror classifiers', () => {
    const fake = parseMirrorExclusions(
      'PRIVATE_PATHS=( private-root )\nDOCS_EXCLUDES=( internal/doc.md )'
    );
    const raw = auditSource(
      'raw.test.ts',
      `
      const REPO_ROOT = path.resolve(__dirname, '..');
      function readPrivate(p: string) { return fs.readFileSync(path.join(REPO_ROOT, p), 'utf8'); }
      readPrivate('private-root/secret.txt');
      execFileSync('git', ['show', 'abcdef1:file']);
      const present = ['private-root'].filter((p) => fs.existsSync(p));
      const mirror = present.length === 0;
    `,
      fake
    );
    expect(raw.findings.map((finding) => finding.kind).sort()).toEqual([
      'local structural-mirror classifier',
      'unrouted excluded-path sink',
      'unrouted fixed git revision',
    ]);

    const routed = auditSource(
      'routed.test.ts',
      `
      const PRIVATE = requiresPrivateEvidence({ reason: 'why', paths: { proof: 'private-root/secret.txt' }, revisions: { start: 'abcdef1' } });
      const describePrivate = PRIVATE.describe;
      describePrivate('proof', () => {
        fs.readFileSync(PRIVATE.paths.proof, 'utf8');
        execFileSync('git', ['show', PRIVATE.revisions.start]);
      });
      const tmpRoot = makeTemp(); new Database(path.join(tmpRoot, 'private-root', 'scratch.sqlite'));
    `,
      fake
    );
    expect(routed).toMatchObject({
      routed: true,
      hasPaths: true,
      hasRevisions: true,
      findings: [],
    });

    const scopeBypasses = auditSource(
      'scope-bypasses.test.ts',
      `
        const REPO_ROOT = path.resolve(__dirname, '..');
        const PRIVATE = requiresPrivateEvidence({ reason: 'why', paths: { proof: 'private-root/secret.txt' }, revisions: { start: 'abcdef1' } });
        function load() { return fs.readFileSync(PRIVATE.paths.proof, 'utf8'); }
        function silentReturn() { if (!fs.existsSync(path.join(REPO_ROOT, 'private-root', 'missing'))) return; }
        load(); silentReturn();
        it('unguarded path', () => fs.readFileSync(PRIVATE.paths.proof, 'utf8'));
        it('unguarded revision', () => execFileSync('git', ['show', PRIVATE.revisions.start]));
        PRIVATE.describe('proof', () => undefined);
      `,
      fake
    );
    expect(scopeBypasses.findings.map((finding) => finding.kind).sort()).toEqual([
      'routed private path sink outside its private scope',
      'routed private path sink outside its private scope',
      'routed private revision sink outside its private scope',
      'unrouted excluded-path sink',
    ]);

    const negativeOracle = auditSource(
      'negative-oracle.test.ts',
      `const REPO_ROOT = path.resolve(__dirname, '..'); expect(fs.existsSync(path.join(REPO_ROOT, 'private-root', 'phantom'))).toBe(false);`,
      fake
    );
    expect(negativeOracle.findings).toEqual([]);
  });

  it('has exactly 18 routed files across default/E2E and two private-history consumers', () => {
    const files = trackedTestFiles();
    const audits = files.map(
      (file) =>
        [
          file,
          auditSource(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'), exclusions),
        ] as const
    );
    const routed = audits.filter(([, audit]) => audit.routed);
    const pathFiles = routed.filter(([, audit]) => audit.hasPaths);
    const revisionFiles = routed.filter(([, audit]) => audit.hasRevisions);
    expect(files.length).toBeGreaterThan(225);
    expect({
      all: routed.length,
      default: routed.filter(([file]) => file.endsWith('.test.ts')).length,
      e2e: routed.filter(([file]) => file.endsWith('.e2e.ts')).length,
      paths: pathFiles.length,
      revisions: revisionFiles.length,
      // s89-m08: 17 -> 18 (default 13 -> 14, paths 16 -> 17).
      // tests/tools/cmos/suggestion-oracle.test.ts is a new private-evidence consumer: its axis
      // matrix and wrong-typed sweep both derive suite-private copies of cmos/db/cmos.sqlite.
      // It routes through this helper rather than guarding itself, so `findings` below stays empty.
    }).toEqual({ all: 18, default: 14, e2e: 4, paths: 17, revisions: 2 });
    expect(audits.flatMap(([, audit]) => audit.findings)).toEqual([]);
  });

  it('declares both static blind spots and pins their public-safe rewrites', () => {
    const indexProfile = KNOWN_STATIC_FALSE_NEGATIVES[0];
    const guardProfile = KNOWN_STATIC_FALSE_NEGATIVES[1];
    const indexSource = fs.readFileSync(path.join(REPO_ROOT, indexProfile.exemplar), 'utf8');
    const guardSource = fs.readFileSync(path.join(REPO_ROOT, guardProfile.exemplar), 'utf8');
    expect(KNOWN_STATIC_FALSE_NEGATIVES).toHaveLength(2);
    expect(indexProfile.profile).toBe('indirect production-side CWD read');
    expect(indexProfile.reason).toMatch(/process\.cwd\(\).*four index\.runtime.*full-suite run/i);
    expect(indexSource).toContain("createSeededCmosProject({}, 'cmos-index-write-error-')");
    expect(indexSource).toContain("createSeededCmosProject({}, 'cmos-index-disclosure-error-')");
    expect(indexSource).toContain("createSeededCmosProject({}, 'cmos-index-parallel-a-')");
    expect(indexSource).toContain("createSeededCmosProject({}, 'cmos-index-parallel-b-')");
    expect(guardProfile.profile).toBe('repository checkout assumed outside tmpdir');
    expect(guardProfile.reason).toMatch(/beneath os\.tmpdir\(\).*root-level non-tmpdir/i);
    expect(guardSource).toContain('path.parse(os.tmpdir()).root');
    expect(guardSource).toContain('const NON_TMP_STORE =');
    expect(guardSource).not.toContain('const REPO_ROOT =');
  });
});
