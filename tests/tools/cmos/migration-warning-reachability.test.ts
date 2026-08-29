// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Re-derives calls to MigrationResult-compatible exports from schema-migrations.ts.
// ABOUTME: Reachable answers must deliver warnings; carrier-less residuals are named with reasons.

import { describe, expect, it } from '@jest/globals';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const MIGRATIONS_FILE = path.join(SRC_ROOT, 'tools/cmos/schema-migrations.ts');

/**
 * Reproduce with:
 *   npx jest tests/tools/cmos/migration-warning-reachability.test.ts --runInBand --coverage=false
 *
 * Scope is deliberately the exported MigrationResult-compatible helpers declared in
 * schema-migrations.ts and their shipped src/ callers. It is not a claim about every producer
 * in the repository (for example, project-identity.ts also exports a MigrationResult producer).
 * Fresh pre-fix RED: 21 producers / 48 calls / 11 consumed / 30 reachable / 7 carrier-less.
 * Fixed contract: 21 producers / 48 calls / 36 direct answer boundaries / 5 verified forwarding
 * carriers / 7 named carrier-less residuals.
 *
 * Unlike the original owner-level `.warnings` census, this gate correlates each producer read
 * with the exact warning sink carried through the handler's single post-callback return. Four
 * deliberately shared helpers are checked through their result/mutable-sink forwarding chains.
 * The paired real-SQLite gate pins representative post-migration error answers:
 *   npx jest tests/tools/cmos/migration-warning-store-compat.test.ts --runInBand --coverage=false
 */

interface MigrationCallSite {
  readonly file: string;
  readonly line: number;
  readonly producer: string;
  readonly owner: string;
  readonly call: ts.CallExpression;
}

interface ResidualReason {
  readonly key: string;
  readonly reason: string;
}

interface ForwardingCarrier {
  readonly key: string;
  readonly reason: string;
}

const EXPECTED_PRODUCERS = [
  'ensureAgentFeedbackTable',
  'ensureArchivalColumns',
  'ensureAuthorNamespaceColumns',
  'ensureColumnWithCheck',
  'ensureConstraintEvergreen',
  'ensureConstraintReviewTimestamp',
  'ensureConstraintsTable',
  'ensureContentPrunedColumn',
  'ensureDecisionsFts5',
  'ensureFirehoseEventColumns',
  'ensureLearningsTable',
  'ensureMissionTimestamps',
  'ensureNextStepsTable',
  'ensureRenamedColumn',
  'ensureReviewTimestamps',
  'ensureSessionMissionsTable',
  'ensureSprintSummaryView',
  'ensureStrategicDecisionsSchema',
  'ensureVectorStorage',
  'migrateContentHash',
  'migrateStrategicDecisionsV21',
] as const;

/**
 * The only shipped callers with no answer warning carrier to splice into.
 *
 * These are residuals, not exemptions from a reachable-answer rule. Each key includes the
 * enclosing function so the two ensureLearningsTable calls in staleness-detection cannot hide
 * behind one filename/producer pair.
 */
const STRUCTURAL_RESIDUALS: readonly ResidualReason[] = [
  {
    key: 'tools/cmos/fts5-retriever.ts:search:ensureDecisionsFts5',
    reason: 'search() returns RankedResult[] and has no CmosToolResult warning envelope',
  },
  {
    key: 'tools/cmos/fts5-retriever.ts:search:ensureVectorStorage',
    reason: 'search() returns RankedResult[] and has no CmosToolResult warning envelope',
  },
  {
    key: 'tools/cmos/genesis-columns.ts:genesisColumns:ensureFirehoseEventColumns',
    reason: 'GenesisStamp is spliced into SQL writes and carries no warnings channel',
  },
  {
    key: 'tools/cmos/genesis-columns.ts:genesisColumns:ensureAuthorNamespaceColumns',
    reason: 'GenesisStamp is spliced into SQL writes and carries no warnings channel',
  },
  {
    key: 'tools/cmos/staleness-detection.ts:detectAndFlagStaleness:ensureReviewTimestamps',
    reason: 'StalenessResult is shared by read answers and carries no warnings channel',
  },
  {
    key: 'tools/cmos/staleness-detection.ts:detectAndFlagStaleness:ensureLearningsTable',
    reason: 'StalenessResult is shared by read answers and carries no warnings channel',
  },
  {
    key: 'tools/cmos/staleness-detection.ts:getStaleCounts:ensureLearningsTable',
    reason: 'the bare staleness count result carries no warnings channel',
  },
] as const;

/**
 * Producer owners that intentionally forward through a shared helper before reaching an answer.
 * Each shape has an executable, symbol-aware verifier below; this is not an owner-level allowlist.
 */
const FORWARDING_CARRIERS: readonly ForwardingCarrier[] = [
  {
    key: 'tools/cmos/agent-feedback.ts:recordAgentFeedback:ensureAgentFeedbackTable',
    reason: 'RecordAgentFeedbackResult.warnings is spliced by all three answer callers',
  },
  {
    key: 'tools/cmos/learning-reaffirm.ts:reaffirmLearningsByIds:ensureReviewTimestamps',
    reason: 'the mutable warning sink crosses applyLearningReaffirm into both session answers',
  },
  {
    key: 'tools/cmos/cmos-mission-complete.ts:ensureMissionIdColumn:ensureStrategicDecisionsSchema',
    reason: 'the string[] carrier is spliced directly or through captureDecisions',
  },
  {
    key: 'tools/cmos/cmos-sprint-complete.ts:archiveSprintDecisionsAndLearnings:ensureArchivalColumns',
    reason: 'ArchiveOutcome.warnings is spliced into the sprint-complete answer sink',
  },
  {
    key: 'tools/cmos/cmos-sprint-complete.ts:archiveSprintDecisionsAndLearnings:ensureLearningsTable',
    reason: 'ArchiveOutcome.warnings is spliced into the sprint-complete answer sink',
  },
] as const;

function loadProgram(): ts.Program {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function migrationResultProducerNames(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): ReadonlySet<string> {
  const names = new Set<string>();
  const resultDeclaration = sourceFile.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'MigrationResult'
  );
  if (!resultDeclaration) throw new Error('MigrationResult interface is missing');
  const migrationResultType = checker.getTypeAtLocation(resultDeclaration);

  for (const node of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
    const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const signature = checker.getSignatureFromDeclaration(node);
    const compatible =
      signature &&
      checker.isTypeAssignableTo(checker.getReturnTypeOfSignature(signature), migrationResultType);
    if (exported && compatible) {
      names.add(node.name.text);
    }
  }
  return names;
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    if (current.name) return current.name.getText(current.getSourceFile());
    return '<anonymous>';
  }
  return '<module>';
}

function collectCallSites(program: ts.Program): {
  readonly producerNames: ReadonlySet<string>;
  readonly sites: readonly MigrationCallSite[];
} {
  const checker = program.getTypeChecker();
  const migrations = program.getSourceFile(MIGRATIONS_FILE);
  if (!migrations) throw new Error(`Missing ${MIGRATIONS_FILE}`);
  const producerNames = migrationResultProducerNames(migrations, checker);
  const sites: MigrationCallSite[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    const absolute = path.resolve(sourceFile.fileName);
    if (
      !absolute.startsWith(SRC_ROOT + path.sep) ||
      absolute === MIGRATIONS_FILE ||
      absolute.endsWith('.d.ts')
    ) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        let symbol = checker.getSymbolAtLocation(node.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        const declaration = symbol?.declarations?.find(
          (decl) => path.resolve(decl.getSourceFile().fileName) === MIGRATIONS_FILE
        );
        const producer =
          declaration && ts.isFunctionDeclaration(declaration) ? declaration.name?.text : undefined;
        if (producer && producerNames.has(producer)) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          sites.push({
            file: path.relative(SRC_ROOT, absolute),
            line: location.line + 1,
            producer,
            owner: enclosingFunctionName(node),
            call: node,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { producerNames, sites };
}

function callReadsWarnings(site: MigrationCallSite, checker: ts.TypeChecker): boolean {
  for (let current: ts.Node | undefined = site.call.parent; current; current = current.parent) {
    if (
      ts.isPropertyAccessExpression(current) &&
      current.name.text === 'warnings' &&
      current.expression === site.call
    ) {
      return true;
    }
    if (ts.isFunctionLike(current)) break;
  }

  const declaration = site.call.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const binding = checker.getSymbolAtLocation(declaration.name);
  if (!binding) return false;
  let owner: ts.Node | undefined = declaration.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (!owner) return false;

  let readsWarnings = false;
  const visit = (node: ts.Node): void => {
    if (readsWarnings) return;
    if (node !== owner && ts.isFunctionLike(node)) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'warnings' &&
      ts.isIdentifier(node.expression) &&
      checker.getSymbolAtLocation(node.expression) === binding
    ) {
      readsWarnings = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner, visit);
  return readsWarnings;
}

function resolvedSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function identifierSymbol(
  node: ts.Node | undefined,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  return node && ts.isIdentifier(node) ? resolvedSymbol(node, checker) : undefined;
}

function nodeContains(container: ts.Node, candidate: ts.Node): boolean {
  return candidate.pos >= container.pos && candidate.end <= container.end;
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) && 'body' in current && current.body) {
      return current as ts.FunctionLikeDeclaration;
    }
  }
  return undefined;
}

function directReturns(fn: ts.FunctionLikeDeclaration): readonly ts.ReturnStatement[] {
  if (!fn.body || !ts.isBlock(fn.body)) return [];
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      returns.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return returns;
}

function callNameIs(call: ts.CallExpression, expected: string, checker: ts.TypeChecker): boolean {
  const symbol = resolvedSymbol(call.expression, checker);
  return symbol?.name === expected;
}

function pushReceiverSymbol(
  node: ts.Node,
  stopAt: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== stopAt;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'push' &&
      current.arguments.some((argument) => nodeContains(argument, node))
    ) {
      return identifierSymbol(current.expression.expression, checker);
    }
  }
  return undefined;
}

/** Resolve the array that receives a call's warnings or warning-bearing result. */
function warningSinkForCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  const owner = enclosingFunction(call);
  if (!owner) return undefined;

  // warnings.push(...producer().warnings) and warnings.push(...helper())
  const directPush = pushReceiverSymbol(call, owner, checker);
  if (directPush) return directPush;

  // const warnings = [...producer().warnings]
  for (
    let current: ts.Node | undefined = call.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isVariableDeclaration(current) &&
      current.initializer &&
      nodeContains(current.initializer, call) &&
      ts.isIdentifier(current.name)
    ) {
      const declarationSymbol = resolvedSymbol(current.name, checker);
      const readsCallWarnings = (() => {
        let found = false;
        const visit = (node: ts.Node): void => {
          if (
            ts.isPropertyAccessExpression(node) &&
            node.name.text === 'warnings' &&
            node.expression === call
          ) {
            found = true;
            return;
          }
          if (!found) ts.forEachChild(node, visit);
        };
        visit(current.initializer);
        return found;
      })();
      if (readsCallWarnings) return declarationSymbol;
      break;
    }
  }

  // const migration = producer(); warnings.push(...migration.warnings)
  // const outcome = helper(); warnings.push(...outcome.warnings)
  let resultDeclaration: ts.VariableDeclaration | undefined;
  for (
    let current: ts.Node | undefined = call.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isVariableDeclaration(current) &&
      current.initializer &&
      nodeContains(current.initializer, call) &&
      ts.isIdentifier(current.name)
    ) {
      resultDeclaration = current;
      break;
    }
  }
  if (!resultDeclaration || !ts.isIdentifier(resultDeclaration.name) || !owner.body) {
    return undefined;
  }
  const resultSymbol = resolvedSymbol(resultDeclaration.name, checker);
  if (!resultSymbol) return undefined;

  let sink: ts.Symbol | undefined;
  const visit = (node: ts.Node): void => {
    if (sink || (node !== owner.body && ts.isFunctionLike(node))) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'warnings' &&
      identifierSymbol(node.expression, checker) === resultSymbol
    ) {
      sink = pushReceiverSymbol(node, owner, checker);
      if (sink) return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner.body, visit);
  return sink;
}

function isAttachReturn(
  statement: ts.ReturnStatement,
  resultSymbol: ts.Symbol,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  const expression = statement.expression;
  return Boolean(
    expression &&
    ts.isCallExpression(expression) &&
    callNameIs(expression, 'attachWarnings', checker) &&
    identifierSymbol(expression.arguments[0], checker) === resultSymbol &&
    identifierSymbol(expression.arguments[1], checker) === warningSink
  );
}

/**
 * Prove that `node` runs inside the initializer for a single result variable and every direct
 * return after that initializer is the exact `attachWarnings(result, warningSink)` boundary.
 * Pre-initializer validation returns are intentionally outside this contract because no migration
 * has run yet and their historical warning-free answer shape must remain unchanged.
 */
function reachesAttachBoundary(
  node: ts.Node,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isVariableDeclaration(current) || !ts.isIdentifier(current.name)) continue;
    const resultSymbol = resolvedSymbol(current.name, checker);
    const fn = enclosingFunction(current);
    if (!resultSymbol || !fn) continue;
    const postInitializerReturns = directReturns(fn).filter(
      (statement) => statement.getStart() > current.end
    );
    if (
      postInitializerReturns.length === 1 &&
      isAttachReturn(postInitializerReturns[0], resultSymbol, warningSink, checker)
    ) {
      return true;
    }
  }
  return false;
}

function returnObjectCarriesWarnings(
  statement: ts.ReturnStatement,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  const expression = statement.expression;
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'warnings') {
      return checker.getShorthandAssignmentValueSymbol(property) === warningSink;
    }
    return (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === 'warnings' &&
      identifierSymbol(property.initializer, checker) === warningSink
    );
  });
}

function callbackReturnsSuccessWithSink(
  node: ts.Node,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  const callback = enclosingFunction(node);
  if (!callback) return false;
  const postCallReturns = directReturns(callback).filter(
    (statement) => statement.getStart() > node.end
  );
  if (
    postCallReturns.length === 0 ||
    !postCallReturns.every((statement) => {
      const expression = statement.expression;
      return Boolean(
        expression &&
        ts.isCallExpression(expression) &&
        callNameIs(expression, 'createSuccess', checker) &&
        expression.arguments.some((argument) => identifierSymbol(argument, checker) === warningSink)
      );
    })
  ) {
    return false;
  }

  for (let current: ts.Node | undefined = callback.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      current.arguments.some((argument) => argument === callback)
    ) {
      for (let parent: ts.Node | undefined = current.parent; parent; parent = parent.parent) {
        if (ts.isReturnStatement(parent) && nodeContains(parent.expression ?? parent, current)) {
          return true;
        }
        if (ts.isFunctionLike(parent)) break;
      }
      return false;
    }
  }
  return false;
}

function sourceFunctionByName(
  program: ts.Program,
  relativeFile: string,
  name: string
): ts.FunctionDeclaration {
  const source = program.getSourceFile(path.join(SRC_ROOT, relativeFile));
  if (!source) throw new Error(`Missing ${relativeFile}`);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  if (!found) throw new Error(`Missing ${relativeFile}:${name}`);
  return found;
}

function callsToFunction(
  program: ts.Program,
  declaration: ts.FunctionDeclaration,
  checker: ts.TypeChecker
): readonly ts.CallExpression[] {
  const target = declaration.name && resolvedSymbol(declaration.name, checker);
  if (!target) throw new Error(`Missing symbol for ${declaration.name?.text ?? '<anonymous>'}`);
  const calls: ts.CallExpression[] = [];
  for (const source of program.getSourceFiles()) {
    const absolute = path.resolve(source.fileName);
    if (!absolute.startsWith(SRC_ROOT + path.sep) || absolute.endsWith('.d.ts')) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && resolvedSymbol(node.expression, checker) === target) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  return calls;
}

/** Trace a helper's mutable warning parameter through every shipped caller to an answer sink. */
function mutableSinkReachesAnswers(
  node: ts.Node,
  warningSink: ts.Symbol,
  program: ts.Program,
  checker: ts.TypeChecker,
  visited: ReadonlySet<ts.Symbol> = new Set()
): boolean {
  if (
    reachesAttachBoundary(node, warningSink, checker) ||
    callbackReturnsSuccessWithSink(node, warningSink, checker)
  ) {
    return true;
  }

  const declaration = warningSink.valueDeclaration;
  if (!declaration || !ts.isParameter(declaration)) return false;
  const owner = enclosingFunction(declaration);
  if (!owner || !owner.name || !ts.isIdentifier(owner.name)) return false;
  const ownerSymbol = resolvedSymbol(owner.name, checker);
  if (!ownerSymbol || visited.has(ownerSymbol)) return false;
  const parameterIndex = owner.parameters.indexOf(declaration);
  if (parameterIndex < 0 || !ts.isFunctionDeclaration(owner)) return false;

  const nextVisited = new Set(visited);
  nextVisited.add(ownerSymbol);
  const callers = callsToFunction(program, owner, checker);
  return (
    callers.length > 0 &&
    callers.every((call) => {
      const callerSink = identifierSymbol(call.arguments[parameterIndex], checker);
      return Boolean(
        callerSink && mutableSinkReachesAnswers(call, callerSink, program, checker, nextVisited)
      );
    })
  );
}

function helperReturnCarrierIsComplete(
  site: MigrationCallSite,
  warningSink: ts.Symbol,
  checker: ts.TypeChecker
): boolean {
  const owner = enclosingFunction(site.call);
  if (!owner) return false;
  const postMigrationReturns = directReturns(owner).filter(
    (statement) => statement.getStart() > site.call.end
  );
  return (
    postMigrationReturns.length > 0 &&
    postMigrationReturns.every((statement) =>
      returnObjectCarriesWarnings(statement, warningSink, checker)
    )
  );
}

function verifyAgentFeedbackCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const localSink = warningSinkForCall(site.call, checker);
  if (!localSink || !helperReturnCarrierIsComplete(site, localSink, checker)) return false;
  const helper = sourceFunctionByName(
    program,
    'tools/cmos/agent-feedback.ts',
    'recordAgentFeedback'
  );
  const calls = callsToFunction(program, helper, checker);
  return (
    calls.length === 3 &&
    calls.every((call) => {
      const callerSink = warningSinkForCall(call, checker);
      return Boolean(
        callerSink &&
        (reachesAttachBoundary(call, callerSink, checker) ||
          callbackReturnsSuccessWithSink(call, callerSink, checker))
      );
    })
  );
}

function verifyLearningReaffirmCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const owner = enclosingFunction(site.call);
  if (!owner || owner.parameters.length < 4) return false;
  const sink = identifierSymbol(owner.parameters[3].name, checker);
  if (!sink || !owner.body) return false;
  let pushesIntoSink = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      identifierSymbol(node.expression.expression, checker) === sink
    ) {
      pushesIntoSink = true;
      return;
    }
    if (!pushesIntoSink) ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner.body, visit);
  if (!pushesIntoSink || !ts.isFunctionDeclaration(owner)) return false;

  const directCalls = callsToFunction(program, owner, checker);
  if (directCalls.length !== 2) return false;
  const apply = sourceFunctionByName(
    program,
    'tools/cmos/learning-reaffirm.ts',
    'applyLearningReaffirm'
  );
  const applySink = identifierSymbol(apply.parameters[2]?.name, checker);
  if (
    !applySink ||
    !directCalls.every((call) => identifierSymbol(call.arguments[3], checker) === applySink)
  ) {
    return false;
  }
  return mutableSinkReachesAnswers(apply, applySink, program, checker);
}

function verifyMissionIdCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const owner = enclosingFunction(site.call);
  if (!owner || !ts.isFunctionDeclaration(owner)) return false;
  const returnStatement = site.call.parent.parent;
  if (
    !ts.isBinaryExpression(returnStatement) &&
    !(ts.isReturnStatement(returnStatement) || ts.isReturnStatement(returnStatement.parent))
  ) {
    return false;
  }
  const calls = callsToFunction(program, owner, checker);
  return (
    calls.length === 3 &&
    calls.every((call) => {
      const callerSink = warningSinkForCall(call, checker);
      return Boolean(callerSink && mutableSinkReachesAnswers(call, callerSink, program, checker));
    })
  );
}

function verifyArchiveCarrier(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  const localSink = warningSinkForCall(site.call, checker);
  if (!localSink || !helperReturnCarrierIsComplete(site, localSink, checker)) return false;
  const helper = sourceFunctionByName(
    program,
    'tools/cmos/cmos-sprint-complete.ts',
    'archiveSprintDecisionsAndLearnings'
  );
  const calls = callsToFunction(program, helper, checker);
  if (calls.length !== 1) return false;
  const callerSink = warningSinkForCall(calls[0], checker);
  return Boolean(callerSink && mutableSinkReachesAnswers(calls[0], callerSink, program, checker));
}

function forwardingCarrierIsVerified(
  site: MigrationCallSite,
  program: ts.Program,
  checker: ts.TypeChecker
): boolean {
  switch (siteKey(site)) {
    case 'tools/cmos/agent-feedback.ts:recordAgentFeedback:ensureAgentFeedbackTable':
      return verifyAgentFeedbackCarrier(site, program, checker);
    case 'tools/cmos/learning-reaffirm.ts:reaffirmLearningsByIds:ensureReviewTimestamps':
      return verifyLearningReaffirmCarrier(site, program, checker);
    case 'tools/cmos/cmos-mission-complete.ts:ensureMissionIdColumn:ensureStrategicDecisionsSchema':
      return verifyMissionIdCarrier(site, program, checker);
    case 'tools/cmos/cmos-sprint-complete.ts:archiveSprintDecisionsAndLearnings:ensureArchivalColumns':
    case 'tools/cmos/cmos-sprint-complete.ts:archiveSprintDecisionsAndLearnings:ensureLearningsTable':
      return verifyArchiveCarrier(site, program, checker);
    default:
      return false;
  }
}

function siteKey(site: MigrationCallSite): string {
  return `${site.file}:${site.owner}:${site.producer}`;
}

describe('s88-m09 MigrationResult warning reachability census', () => {
  const program = loadProgram();
  const checker = program.getTypeChecker();
  const census = collectCallSites(program);
  const consumed = census.sites.filter((site) => callReadsWarnings(site, checker));
  const unconsumed = census.sites.filter((site) => !callReadsWarnings(site, checker));
  const expectedForwarders = new Map(
    FORWARDING_CARRIERS.map((carrier) => [carrier.key, carrier.reason])
  );
  const forwarded = consumed.filter((site) => expectedForwarders.has(siteKey(site)));
  const directlyBounded = consumed.filter((site) => {
    const sink = warningSinkForCall(site.call, checker);
    return Boolean(sink && reachesAttachBoundary(site.call, sink, checker));
  });

  it('re-derives the current producer and shipped-call denominators', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[migration-warning-census] producers=${census.producerNames.size} ` +
        `srcCalls=${census.sites.length} directBoundaries=${directlyBounded.length} ` +
        `forwarded=${forwarded.length} residual=${unconsumed.length}`
    );
    expect([...census.producerNames].sort()).toEqual([...EXPECTED_PRODUCERS].sort());
    expect(census.sites.length).toBe(48);
  });

  it('carries every reachable producer through its exact answer boundary', () => {
    const directKeys = new Set(directlyBounded.map(siteKey));
    const unsafe = consumed.filter(
      (site) => !directKeys.has(siteKey(site)) && !expectedForwarders.has(siteKey(site))
    );
    const invalidForwarders = forwarded.filter(
      (site) => !forwardingCarrierIsVerified(site, program, checker)
    );

    expect(
      unsafe.map((site) => `${siteKey(site)}:${site.line} has no post-migration answer boundary`)
    ).toEqual([]);
    expect(
      invalidForwarders.map(
        (site) =>
          `${siteKey(site)}:${site.line} broke its verified forwarding chain — ${expectedForwarders.get(siteKey(site))}`
      )
    ).toEqual([]);
    expect(directlyBounded).toHaveLength(36);
    expect(forwarded.map(siteKey).sort()).toEqual([...expectedForwarders.keys()].sort());
  });

  it('does not mistake an owner-level warnings read for an answer boundary', () => {
    const forwardingOwner = consumed.find(
      (site) =>
        siteKey(site) ===
        'tools/cmos/agent-feedback.ts:recordAgentFeedback:ensureAgentFeedbackTable'
    );
    expect(forwardingOwner).toBeDefined();
    expect(callReadsWarnings(forwardingOwner!, checker)).toBe(true);
    const localSink = warningSinkForCall(forwardingOwner!.call, checker);
    expect(localSink).toBeDefined();
    expect(reachesAttachBoundary(forwardingOwner!.call, localSink!, checker)).toBe(false);
    expect(forwardingCarrierIsVerified(forwardingOwner!, program, checker)).toBe(true);
  });

  it('leaves only named, structurally carrier-less residuals', () => {
    const expected = new Map(
      STRUCTURAL_RESIDUALS.map((residual) => [residual.key, residual.reason])
    );
    const actual = unconsumed.map((site) => ({
      key: siteKey(site),
      line: site.line,
      reason: expected.get(siteKey(site)) ?? 'REACHABLE ANSWER DROPS THIS WARNING',
    }));
    // eslint-disable-next-line no-console
    console.log(
      `[migration-warning-census] residuals:\n${actual
        .map((row) => `- ${row.key}:${row.line} — ${row.reason}`)
        .join('\n')}`
    );

    expect(actual.map((row) => row.key).sort()).toEqual([...expected.keys()].sort());
    expect(consumed).toHaveLength(41);
    expect(unconsumed).toHaveLength(STRUCTURAL_RESIDUALS.length);
  });
});
