// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Plans the naming pass and checks its residuals using the same counted protection rules.
// ABOUTME: Keeps frozen records separate from current module paths and refuses unreviewed command names.
const crypto = require('crypto');

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const OLD = /cmos/gi;
const AMBIGUOUS = /cmos-mcp|cmos\.aquex\.ai/gi;
const FORBIDDEN =
  /rbook-mcp|rbook@|\/rbook:(?!\\\/\\\/)|rbook-chat|rbook\.aquex|plugins\/rbook|formerly Reasonbook|deprecate\s+@aquex\/reasonbook|REASONBOOK_|[A-Za-z0-9_$]Reasonbook|Reasonbook[A-Za-z0-9_$]/g;
const SENTINEL = '\uE000RBOOK_PROTECTED_';

function glob(pattern) {
  let text = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*') {
      if (pattern[i + 1] === '*') {
        text += '.*';
        i++;
      } else text += '[^/]*';
    } else text += pattern[i].replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
  }
  return new RegExp(`^${text}$`);
}
function renamePath(file) {
  if (file.startsWith('cmos/')) return file;
  return file
    .replace(/plugins\/cmos-chat(?=\/|$)/g, 'plugins/reasonbook-chat')
    .replace(/plugins\/cmos(?=\/|$)/g, 'plugins/reasonbook')
    .replace(/CMOS/g, 'RBOOK')
    .replace(/Cmos/g, 'Rbook')
    .replace(/cmos/g, 'rbook');
}
function matches(rule, file) {
  return rule.paths.some(
    (pattern) => glob(pattern).test(file) || glob(renamePath(pattern)).test(file)
  );
}
function regex(rule) {
  return new RegExp(rule.pattern, [...new Set(`${rule.flags ?? ''}g`)].join(''));
}
function validate(manifest) {
  if (manifest.schemaVersion !== 1) throw new Error('unknown rename protection schema');
  const ids = new Set();
  for (const mapping of manifest.pathMappings ?? []) {
    if (!mapping.source || !mapping.target || !mapping.reason || mapping.source === mapping.target)
      throw new Error('invalid or unexplained path mapping');
  }
  for (const rule of [...manifest.protections, ...manifest.replacements, ...manifest.reviews]) {
    if (
      !rule.id ||
      ids.has(rule.id) ||
      !rule.reason ||
      !Array.isArray(rule.paths) ||
      !rule.paths.length
    )
      throw new Error('invalid, duplicate or unexplained rename rule');
    ids.add(rule.id);
    if (rule.mode && !['file', 'compatibility', 'ledger', 'changelog'].includes(rule.mode))
      throw new Error(`unknown protection mode: ${rule.id}`);
    if (!rule.mode) {
      if (!rule.pattern || regex(rule).test(''))
        throw new Error(`empty-match rename pattern: ${rule.id}`);
    }
  }
}
function countRule(files, rule) {
  return files
    .filter((file) => matches(rule, file.path))
    .reduce((sum, file) => sum + (rule.mode ? 1 : [...file.text.matchAll(regex(rule))].length), 0);
}
function publicFiles(files, manifest) {
  return files.filter(
    (file) => !(manifest.publicExcludes ?? []).some((pattern) => glob(pattern).test(file.path))
  );
}
function captureCounts(files, manifest) {
  validate(manifest);
  const result = JSON.parse(JSON.stringify(manifest));
  for (const rule of [...result.protections, ...result.replacements]) {
    rule.expectedCount = countRule(files, rule);
    rule.expectedPublicCount = countRule(publicFiles(files, manifest), rule);
  }
  for (const mapping of result.pathMappings ?? []) {
    mapping.expectedCount = files.filter(
      (file) => file.path === mapping.source || file.path === mapping.target
    ).length;
  }
  return result;
}
function countIssues(files, rules, publicOnly = false) {
  return rules.flatMap((rule) => {
    const actual = countRule(files, rule);
    const expected = publicOnly ? rule.expectedPublicCount : rule.expectedCount;
    if (!Number.isSafeInteger(expected) || expected < 0)
      return [`${rule.id}: missing/invalid expectedCount (capture counts before applying)`];
    return actual === expected
      ? []
      : [`${rule.id}: protected/reviewed count ${actual}, expected ${expected}`];
  });
}
function protections(text, file, manifest) {
  if (text.includes(SENTINEL)) throw new Error(`reserved rename sentinel occurs in ${file}`);
  const kept = [];
  for (const rule of manifest.protections.filter((entry) => !entry.mode && matches(entry, file))) {
    text = text.replace(regex(rule), (value) => {
      const token = `${SENTINEL}${kept.length}\uE001`;
      kept.push([token, value]);
      return token;
    });
  }
  return {
    text,
    restore: (result) => {
      for (const [token, value] of kept.reverse()) result = result.split(token).join(value);
      return result;
    },
  };
}
function currentModulePaths(text) {
  const rewrite = (value) =>
    value
      .replace(/plugins\/cmos-chat\b/g, 'plugins/reasonbook-chat')
      .replace(/plugins\/cmos\b/g, 'plugins/reasonbook')
      .replace(/CMOS/g, 'RBOOK')
      .replace(/Cmos/g, 'Rbook')
      .replace(/cmos/g, 'rbook');
  // Identifier nodes must follow exported names; literal old values and comments are the fixture.
  const ts = require('typescript');
  const source = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    const storedProperty =
      ts.isIdentifier(node) &&
      (((ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) &&
        node.parent.name === node) ||
        (ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node &&
          /^CMOS_/.test(node.text)) ||
        ((ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent)) &&
          ['cmos_address', 'cmosAddress', 'cmosDirectory'].includes(node.text)));
    if (ts.isIdentifier(node) && /cmos/i.test(node.text) && !storedProperty)
      edits.push([node.getStart(source), node.end, rewrite(node.text)]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, start) + value + text.slice(end);
  return text
    .replace(
      /((?:\bfrom\s*|\bimport\s*|\brequire(?:\.resolve)?\s*\(\s*|\bimport\s*\(\s*)['"])([^'"\n]+)(['"])/g,
      (_all, start, value, end) => start + (value.startsWith('.') ? rewrite(value) : value) + end
    )
    .replace(
      /(\bpath\.(?:resolve|join)\(__dirname,\s*['"](?:\.\.\/)+)cmos-seed(?=['"/])/g,
      '$1rbook-seed'
    )
    .replace(/plugins\/cmos(?:-chat)?\/(?:hooks|server|codex\.mcp\.json|mcp\.json)/g, rewrite);
}
function changelogParts(text) {
  const match = /^##\s+\[?(?:3\.5\.0|3\.[0-4]\.\d+|[12]\.\d+\.\d+)\b/m.exec(text);
  if (!match) throw new Error('changelog protection requires the 3.5.0-or-earlier boundary');
  return [text.slice(0, match.index), text.slice(match.index)];
}
function ledgerCurrent(text, transform = (value) => value) {
  const data = JSON.parse(text);
  if (data.universe) data.universe = visit(data.universe);
  for (const arm of data.arms ?? []) {
    for (const field of ['witnesses', 'residual']) if (arm[field]) arm[field] = visit(arm[field]);
  }
  function visit(value) {
    if (typeof value === 'string') return transform(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)]));
    return value;
  }
  return data;
}
function activeText(file, manifest) {
  const mode = manifest.protections.find((entry) => entry.mode && matches(entry, file.path))?.mode;
  if (mode === 'file') return '';
  if (mode === 'compatibility')
    return currentModulePaths(file.text) === file.text ? '' : 'cmos: stale current module path';
  if (mode === 'ledger') {
    const data = ledgerCurrent(file.text);
    return JSON.stringify({
      universe: data.universe,
      arms: (data.arms ?? []).map(({ witnesses, residual }) => ({ witnesses, residual })),
    });
  }
  if (mode === 'changelog') return changelogParts(file.text)[0];
  return file.text;
}
function transformText(text, file, manifest, issues, reviews) {
  const protectedText = protections(text, file, manifest);
  let output = protectedText.text;
  for (const rule of manifest.replacements.filter((entry) => matches(entry, file)))
    output = output.replace(regex(rule), rule.replacement);
  output = output
    .replace(/@aquex\/cmos-mcp\b/g, '@aquex/reasonbook')
    .replace(/CMOS-MCP\b/g, 'Reasonbook');
  for (const match of output.matchAll(AMBIGUOUS)) {
    const line = output.slice(0, match.index).split('\n').length;
    const item = {
      path: file,
      line,
      token: match[0],
      reason:
        'ambiguous command/config/host/project spelling; add a reviewed replacement or protection',
    };
    reviews.push(item);
    issues.push(`ambiguous ${match[0]} at ${file}:${line}`);
  }
  // Mask unresolved cases so the dry-run never proposes the knowingly wrong rbook-mcp form.
  const unknown = [];
  output = output.replace(AMBIGUOUS, (value) => {
    const token = `\uE002AMBIGUOUS_${unknown.length}\uE003`;
    unknown.push([token, value]);
    return token;
  });
  output = output
    .replace(/,[ \t]*formerly CMOS,?|[ \t]*\(formerly CMOS\)/g, '')
    .replace(/(['"])plugins\1(\s*,\s*)(['"])cmos(-chat)?\3/g, '$1plugins$1$2$3reasonbook$4$3')
    .replace(/plugins\/cmos-chat\b/g, 'plugins/reasonbook-chat')
    .replace(/plugins\/cmos\b/g, 'plugins/reasonbook')
    .replace(/\/cmos:/g, '/reasonbook:')
    .replace(/\bcmos-chat\b/g, 'reasonbook-chat')
    .replace(/CMOS(?=[A-Z0-9_])/g, 'RBOOK')
    .replace(/\bCMOS\b/g, 'Reasonbook')
    .replace(/Cmos/g, 'Rbook')
    .replace(/cmos/g, 'rbook');
  for (const [token, value] of unknown) output = output.split(token).join(value);
  return protectedText.restore(output);
}
function checkRename(files, manifest, options = {}) {
  validate(manifest);
  if (options.publicOnly) files = publicFiles(files, manifest);
  const issues = countIssues(files, manifest.protections, options.publicOnly);
  for (const mapping of manifest.pathMappings ?? []) {
    const actual = files.filter(
      (file) => file.path === mapping.source || file.path === mapping.target
    ).length;
    if (actual !== mapping.expectedCount)
      issues.push(
        `path mapping count: ${mapping.source} (${actual}, expected ${mapping.expectedCount})`
      );
  }
  const residuals = [],
    reviews = [];
  for (const file of files) {
    const mode = manifest.protections.find(
      (entry) => entry.mode && matches(entry, file.path)
    )?.mode;
    const pathAllowed =
      file.path.startsWith('cmos/') ||
      (mode === 'file' &&
        manifest.protections.some((r) => r.allowOldPath && matches(r, file.path)));
    if (/cmos/i.test(file.path) && !pathAllowed) issues.push(`residual path: ${file.path}`);
    if (/rbook-mcp|rbook-chat|plugins\/rbook/.test(file.path))
      issues.push(`malformed renamed path: ${file.path}`);
    const text = protections(activeText(file, manifest), file.path, manifest).text;
    for (const [index, line] of text.split('\n').entries()) {
      if (OLD.test(line)) {
        residuals.push({ path: file.path, line: index + 1 });
        issues.push(`old-name residual: ${file.path}:${index + 1}`);
      }
      OLD.lastIndex = 0;
      // A regex word-boundary escape is not the leading 'b' of a source identifier.
      if (FORBIDDEN.test(line.replace(/\\bReasonbook\\b/g, 'Reasonbook')))
        issues.push(`malformed renamed output: ${file.path}:${index + 1}`);
      FORBIDDEN.lastIndex = 0;
      if (
        /\b(?:former|formerly)\b.*(?:Reasonbook|reasonbook|rbook)|(?:Reasonbook|reasonbook|rbook).*\b(?:former|formerly)\b/i.test(
          line
        ) ||
        /@aquex\/reasonbook.*@aquex\/reasonbook/.test(line) ||
        /\brbook\s+(?:keeps|is|provides|helps|stores|runs|lets)\b/.test(line)
      )
        reviews.push({
          path: file.path,
          line: index + 1,
          reason: 'review transition wording or short-name product prose',
        });
    }
  }
  return { ok: issues.length === 0, scannedFileCount: files.length, issues, residuals, reviews };
}
function planRename(files, manifest) {
  validate(manifest);
  const issues = countIssues(files, [...manifest.protections, ...manifest.replacements]);
  const reviews = [];
  const proposed = files.map((file) => {
    const mode = manifest.protections.find(
      (entry) => entry.mode && matches(entry, file.path)
    )?.mode;
    const transform = (text) => transformText(text, file.path, manifest, issues, reviews);
    let text = file.text;
    if (mode === 'compatibility') text = currentModulePaths(text);
    else if (mode === 'ledger')
      text = JSON.stringify(ledgerCurrent(text, transform), null, 2) + '\n';
    else if (mode === 'changelog') {
      const [active, history] = changelogParts(text);
      text = transform(active) + history;
    } else if (mode !== 'file') text = transform(text);
    for (const rule of manifest.reviews.filter((entry) => matches(entry, file.path))) {
      for (const match of text.matchAll(regex(rule))) {
        reviews.push({
          path: file.path,
          line: text.slice(0, match.index).split('\n').length,
          reason: rule.reason,
        });
        issues.push(`manual review ${rule.id}: ${file.path}`);
      }
    }
    const keepPath =
      mode === 'file' &&
      manifest.protections.some((entry) => entry.allowOldPath && matches(entry, file.path));
    const mapped = manifest.pathMappings?.find((mapping) => mapping.source === file.path)?.target;
    return { ...file, path: mapped ?? (keepPath ? file.path : renamePath(file.path)), text };
  });
  const targets = new Set();
  for (const file of proposed) {
    if (targets.has(file.path)) issues.push(`target path collision: ${file.path}`);
    targets.add(file.path);
  }
  const after = checkRename(proposed, manifest);
  issues.push(...after.issues);
  reviews.push(...after.reviews);
  const changes = files.flatMap((source, index) => {
    const target = proposed[index];
    return source.path === target.path && source.text === target.text
      ? []
      : [
          {
            source: source.path,
            target: target.path,
            mode: source.mode,
            before: source.text,
            after: target.text,
            beforeHash: hash(source.text),
            afterHash: hash(target.text),
          },
        ];
  });
  return {
    ok: issues.length === 0,
    inputHash: hash(
      JSON.stringify({
        files: files.map((file) => ({ path: file.path, mode: file.mode, hash: hash(file.text) })),
        manifest,
      })
    ),
    issues: [...new Set(issues)],
    reviews,
    files: proposed,
    changes,
    after,
  };
}
module.exports = { hash, renamePath, currentModulePaths, captureCounts, planRename, checkRename };
