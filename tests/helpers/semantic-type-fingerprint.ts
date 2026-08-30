// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Cycle-safe semantic literal fingerprints for TypeScript answer declarations.

import * as path from 'path';
import * as ts from 'typescript';

export function createSemanticTypeFingerprinter(
  checker: ts.TypeChecker,
  sourceProgramRoot: string
): (node: ts.Node) => string {
  const cache = new Map<ts.Type, string>();
  const active = new Set<ts.Type>();
  const canonicalRoot = sourceProgramRoot.split(path.sep).join('/');

  const fingerprint = (type: ts.Type, context: ts.Node): string => {
    const cached = cache.get(type);
    if (cached) return cached;
    if (active.has(type)) return `recursive:${checker.typeToString(type, context)}`;
    active.add(type);
    let result: string;
    if (type.isUnion()) {
      result = `union<${[...new Set(type.types.map((part) => fingerprint(part, context)))]
        .sort()
        .join(' | ')}>`;
    } else if (type.isIntersection()) {
      result = `intersection<${[...new Set(type.types.map((part) => fingerprint(part, context)))]
        .sort()
        .join(' | ')}>`;
    } else {
      const flags = type.flags;
      if ((flags & ts.TypeFlags.StringLiteral) !== 0) {
        result = `string:${JSON.stringify((type as ts.StringLiteralType).value)}`;
      } else if ((flags & ts.TypeFlags.NumberLiteral) !== 0) {
        result = `number:${String((type as ts.NumberLiteralType).value)}`;
      } else if ((flags & ts.TypeFlags.BooleanLiteral) !== 0) {
        result = `boolean:${checker.typeToString(type)}`;
      } else if ((flags & ts.TypeFlags.StringLike) !== 0) result = 'string';
      else if ((flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0)
        result = 'number';
      else if ((flags & ts.TypeFlags.BooleanLike) !== 0) result = 'boolean';
      else if ((flags & ts.TypeFlags.Null) !== 0) result = 'null';
      else if ((flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0) {
        result = 'undefined';
      } else if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) result = 'ANY';
      else if ((flags & ts.TypeFlags.TypeParameter) !== 0) {
        result = `GENERIC:${checker.typeToString(type)}`;
      } else if ((flags & ts.TypeFlags.Object) !== 0 && checker.isTupleType(type)) {
        result = `tuple<${checker
          .getTypeArguments(type as ts.TypeReference)
          .map((part) => fingerprint(part, context))
          .join(' | ')}>`;
      } else if ((flags & ts.TypeFlags.Object) !== 0 && checker.isArrayType(type)) {
        const args = checker.getTypeArguments(type as ts.TypeReference);
        result = `array<${args.length === 1 ? fingerprint(args[0], context) : 'UNRESOLVED'}>`;
      } else {
        result = checker.typeToString(type, context, ts.TypeFormatFlags.NoTruncation);
      }
    }
    active.delete(type);
    result = result.split(canonicalRoot).join('src');
    cache.set(type, result);
    return result;
  };

  return (node) => fingerprint(checker.getTypeAtLocation(node), node);
}
