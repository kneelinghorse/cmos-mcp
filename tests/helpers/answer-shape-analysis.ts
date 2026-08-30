// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Symbol-safe TypeScript answer declarations, composition, and property-shape analysis.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createSemanticTypeFingerprinter } from './semantic-type-fingerprint';

const REPO_ROOT = path.resolve(__dirname, '../..');
export const CMOS_SOURCE_ROOT = path.join(REPO_ROOT, 'src', 'tools', 'cmos');

export interface DeclarationInfo {
  readonly identity: string;
  readonly moduleId: string;
  readonly name: string;
  readonly node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
}

export interface ShapeRow {
  readonly key: string;
  readonly snapshot: string;
  readonly runtimeKinds: readonly string[];
}

export interface ShapeAnalysis {
  readonly fileCount: number;
  readonly roots: readonly DeclarationInfo[];
  readonly declarations: readonly DeclarationInfo[];
  readonly compositionRows: readonly string[];
  readonly rows: readonly ShapeRow[];
  readonly duplicateOwnerNames: ReadonlyMap<string, readonly string[]>;
}

function walkTypeScriptFiles(root: string): string[] {
  if (!fs.existsSync(root)) throw new Error(`answer-shape source root does not exist: ${root}`);
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

function readCompilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(path.join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  return {
    ...ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT).options,
    noEmit: true,
  };
}

function isShapeDeclaration(
  node: ts.Node
): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  return ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  const seen = new Set<ts.Symbol>();
  let current = symbol;
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function normalizeText(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return tokens.join(' ');
}

function normalize(node: ts.Node): string {
  return normalizeText(node.getText(node.getSourceFile()));
}

function compositionFingerprint(
  declaration: DeclarationInfo,
  semanticType?: (node: ts.Node) => string
): string {
  const typeParameters = (declaration.node.typeParameters ?? []).map(normalize).join(' | ');
  if (ts.isTypeAliasDeclaration(declaration.node)) {
    const resolved = semanticType ? normalizeText(semanticType(declaration.node.type)) : '';
    return (
      `${declaration.identity}: kind=type; typeParameters=[${typeParameters}]; ` +
      `rhs=${normalize(declaration.node.type)}; resolved=[${resolved}]`
    );
  }
  const heritage = (declaration.node.heritageClauses ?? []).map(normalize).join(' | ');
  const members = declaration.node.members.map(normalize).join(' | ');
  const memberTypes = semanticType
    ? declaration.node.members.map((member) => normalizeText(semanticType(member))).join(' | ')
    : '';
  return (
    `${declaration.identity}: kind=interface; typeParameters=[${typeParameters}]; ` +
    `heritage=[${heritage}]; members=[${members}]; resolvedMembers=[${memberTypes}]`
  );
}

function exportedShapeDeclarations(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  inScope: (declaration: ts.Declaration) => boolean
): Array<ts.InterfaceDeclaration | ts.TypeAliasDeclaration> {
  const roots = new Set<ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  for (const sourceFile of sourceFiles) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const exportedName = exported.getName();
      const symbol = resolveAlias(checker, exported);
      for (const declaration of symbol.declarations ?? []) {
        if (!isShapeDeclaration(declaration) || !inScope(declaration)) continue;
        if (/(Error|Result)$/.test(exportedName) || /(Error|Result)$/.test(declaration.name.text)) {
          roots.add(declaration);
        }
      }
    }
  }
  return [...roots];
}

export function sortedKinds(kinds: Iterable<string>): string[] {
  return [...new Set(kinds)].sort((a, b) => a.localeCompare(b));
}

function runtimeKinds(checker: ts.TypeChecker, type: ts.Type): string[] {
  if (type.isUnion()) return sortedKinds(type.types.flatMap((part) => runtimeKinds(checker, part)));
  if (type.isIntersection()) {
    const parts = sortedKinds(type.types.flatMap((part) => runtimeKinds(checker, part)));
    const nonObject = parts.filter((part) => part !== 'object');
    return nonObject.length > 0 ? nonObject : ['object'];
  }
  const flags = type.flags;
  if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return ['ANY'];
  if ((flags & ts.TypeFlags.TypeParameter) !== 0) return ['GENERIC'];
  if ((flags & ts.TypeFlags.StringLike) !== 0) return ['string'];
  if ((flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0) return ['number'];
  if ((flags & ts.TypeFlags.BooleanLike) !== 0) return ['boolean'];
  if ((flags & ts.TypeFlags.Null) !== 0) return ['null'];
  if ((flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0) {
    return ['undefined'];
  }
  if ((flags & ts.TypeFlags.Object) !== 0) {
    if (checker.isTupleType(type)) return ['array'];
    if (checker.isArrayType(type)) {
      const args = checker.getTypeArguments(type as ts.TypeReference);
      const inner = args.length === 1 ? runtimeKinds(checker, args[0]) : ['UNRESOLVED'];
      return [`array<${inner.join(' | ')}>`];
    }
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return ['function'];
    return ['object'];
  }
  return [`UNRESOLVED:${checker.typeToString(type)}`];
}

export function analyzeAnswerShapes(sourceRoot = CMOS_SOURCE_ROOT): ShapeAnalysis {
  const files = walkTypeScriptFiles(sourceRoot);
  const sourceProgramRoot = path.resolve(sourceRoot, '../..');
  const program = ts.createProgram({ rootNames: files, options: readCompilerOptions() });
  const checker = program.getTypeChecker();
  const semanticType = createSemanticTypeFingerprinter(checker, sourceProgramRoot);
  const all = new Map<string, DeclarationInfo>();
  const moduleIdFor = (sourceFile: ts.SourceFile): string => {
    const relative = path
      .relative(sourceProgramRoot, sourceFile.fileName)
      .split(path.sep)
      .join('/');
    return `src/${relative}`;
  };
  const isInSourceProgram = (sourceFile: ts.SourceFile): boolean => {
    const relative = path.relative(sourceProgramRoot, sourceFile.fileName);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const programSourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile && isInSourceProgram(sourceFile));

  for (const sourceFile of programSourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!isShapeDeclaration(statement)) continue;
      const moduleId = moduleIdFor(sourceFile);
      const identity = `${moduleId}#${statement.name.text}`;
      if (all.has(identity)) throw new Error(`Duplicate answer-shape identity: ${identity}`);
      all.set(identity, { identity, moduleId, name: statement.name.text, node: statement });
    }
  }

  const inScope = (declaration: ts.Declaration): boolean =>
    isInSourceProgram(declaration.getSourceFile());
  const infoFor = (
    declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration
  ): DeclarationInfo | undefined =>
    all.get(`${moduleIdFor(declaration.getSourceFile())}#${declaration.name.text}`);
  const declarationsFor = (rawSymbol: ts.Symbol): DeclarationInfo[] =>
    (resolveAlias(checker, rawSymbol).declarations ?? [])
      .filter((declaration) => isShapeDeclaration(declaration) && inScope(declaration))
      .map((declaration) =>
        infoFor(declaration as ts.InterfaceDeclaration | ts.TypeAliasDeclaration)
      )
      .filter((info): info is DeclarationInfo => !!info);
  const toolSourceFiles = files.map((file) => program.getSourceFile(file)!);
  const roots = exportedShapeDeclarations(checker, toolSourceFiles, inScope)
    .map(infoFor)
    .filter((info): info is DeclarationInfo => !!info)
    .sort((a, b) => a.identity.localeCompare(b.identity));

  const closure = new Map<string, DeclarationInfo>();
  const queue = [...roots];
  while (queue.length > 0) {
    const declaration = queue.shift()!;
    if (closure.has(declaration.identity)) continue;
    closure.set(declaration.identity, declaration);
    const enqueue = (node: ts.Node): void => {
      const reference = ts.isTypeReferenceNode(node)
        ? node.typeName
        : ts.isExpressionWithTypeArguments(node)
          ? node.expression
          : ts.isImportTypeNode(node) && node.qualifier
            ? node.qualifier
            : null;
      const symbol = reference && checker.getSymbolAtLocation(reference);
      if (symbol) queue.push(...declarationsFor(symbol));
      ts.forEachChild(node, enqueue);
    };
    for (const typeParameter of declaration.node.typeParameters ?? []) enqueue(typeParameter);
    if (ts.isInterfaceDeclaration(declaration.node)) {
      for (const heritage of declaration.node.heritageClauses ?? []) enqueue(heritage);
      for (const member of declaration.node.members) enqueue(member);
    } else enqueue(declaration.node.type);
  }

  const declarations = [...closure.values()].sort((a, b) => a.identity.localeCompare(b.identity));
  const modulesByName = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    const modules = modulesByName.get(declaration.name) ?? new Set<string>();
    modules.add(declaration.moduleId);
    modulesByName.set(declaration.name, modules);
  }
  const duplicateOwnerNames = new Map<string, readonly string[]>(
    [...modulesByName]
      .filter(([, modules]) => modules.size > 1)
      .map(([name, modules]) => [name, [...modules].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b))
  );

  const rows: ShapeRow[] = [];
  for (const declaration of declarations) {
    const owner = duplicateOwnerNames.has(declaration.name)
      ? `${declaration.name}@${declaration.moduleId}`
      : declaration.name;
    const members = ts.isInterfaceDeclaration(declaration.node)
      ? declaration.node.members
      : ts.isTypeLiteralNode(declaration.node.type)
        ? declaration.node.type.members
        : [];
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const property = normalize(member.name);
      const key = `${owner}.${property}`;
      const resolved = runtimeKinds(checker, checker.getTypeFromTypeNode(member.type));
      rows.push({
        key,
        runtimeKinds: resolved,
        snapshot: `${key}${member.questionToken ? '?' : ''}: declared=${normalize(member.type)}; runtime=${resolved.join(' | ')}`,
      });
    }
  }
  rows.sort((a, b) => a.snapshot.localeCompare(b.snapshot));
  return {
    fileCount: files.length,
    roots,
    declarations,
    compositionRows: declarations
      .map((declaration) => compositionFingerprint(declaration, semanticType))
      .sort(),
    rows,
    duplicateOwnerNames,
  };
}

export function compositionFingerprintsForSource(
  text: string,
  moduleId = 'src/tools/cmos/fixture.ts'
): string[] {
  const sourceFile = ts.createSourceFile(moduleId, text, ts.ScriptTarget.Latest, true);
  return sourceFile.statements
    .filter(isShapeDeclaration)
    .map((node) =>
      compositionFingerprint({
        identity: `${moduleId}#${node.name.text}`,
        moduleId,
        name: node.name.text,
        node,
      })
    )
    .sort();
}

export function exportedShapeNamesForSource(text: string): string[] {
  const fileName = path.resolve('/answer-shape-export-fixture.ts');
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  };
  const sourceFile = ts.createSourceFile(fileName, text, options.target!, true);
  const host = ts.createCompilerHost(options, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (file) => path.resolve(file) === fileName || ts.sys.fileExists(file);
  host.readFile = (file) => (path.resolve(file) === fileName ? text : ts.sys.readFile(file));
  host.getSourceFile = (file, language, onError, fresh) =>
    path.resolve(file) === fileName
      ? sourceFile
      : baseGetSourceFile(file, language, onError, fresh);
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const checker = program.getTypeChecker();
  return exportedShapeDeclarations(
    checker,
    [program.getSourceFile(fileName)!],
    (declaration) => path.resolve(declaration.getSourceFile().fileName) === fileName
  )
    .map((declaration) => declaration.name.text)
    .sort();
}

export function containsNestedKind(kinds: readonly string[], wanted: 'ANY' | 'GENERIC'): boolean {
  return kinds.some((kind) => kind.includes(wanted));
}

export function jsonKind(kind: string): string | null {
  if (kind.startsWith('array')) return 'array';
  return ['string', 'number', 'boolean', 'object'].includes(kind) ? kind : null;
}
