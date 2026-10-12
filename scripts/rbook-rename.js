#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Dry-run-first source rename; one protection list drives planning and the public residual gate.
// ABOUTME: Application requires the reviewed HEAD and refuses source drift or any destination collision.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { TextDecoder } = require('util');
const { hash, captureCounts, planRename, checkRename } = require('./lib/rbook-rename');

function readInputs(root) {
  const entries = execFileSync('git', ['ls-files', '-z', '--stage'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const files = [],
    excluded = [];
  for (const entry of entries) {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[2] !== '0') throw new Error('invalid or unmerged Git index entry');
    const [, mode, , name] = match;
    if (!['100644', '100755'].includes(mode)) {
      excluded.push({ path: name, reason: `nonregular mode ${mode}` });
      continue;
    }
    const absolute = safeFile(root, name);
    if (!fs.existsSync(absolute))
      throw new Error(`tracked path missing: ${name}; stage completed renames before --check`);
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) {
      excluded.push({ path: name, reason: 'binary NUL' });
      continue;
    }
    try {
      files.push({
        path: name,
        mode,
        text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      });
    } catch {
      excluded.push({ path: name, reason: 'invalid UTF-8' });
    }
  }
  return { files, excluded };
}
function safeFile(root, name) {
  if (
    path.isAbsolute(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..') ||
    name.includes('\\') ||
    [...name].some((char) => char.codePointAt(0) < 32)
  )
    throw new Error(`unsafe file path: ${name}`);
  const file = path.join(root, name);
  let existing = file;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const actual = fs.realpathSync(existing);
  if (actual !== root && !actual.startsWith(root + path.sep))
    throw new Error(`path escapes repository: ${name}`);
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile())
    throw new Error(`nonregular path: ${name}`);
  return file;
}
function applyPlan(root, plan) {
  root = fs.realpathSync(root);
  if (!plan.ok)
    throw new Error('rename refused: resolve every blocking review/count/residual issue first');
  for (const change of plan.changes) {
    const source = safeFile(root, change.source),
      target = safeFile(root, change.target);
    if (hash(fs.readFileSync(source, 'utf8')) !== change.beforeHash)
      throw new Error(`source changed since plan: ${change.source}`);
    if (source !== target && fs.existsSync(target))
      throw new Error(`destination collision: ${change.target}`);
  }
  const done = [];
  let temporary;
  try {
    for (const change of plan.changes) {
      const source = safeFile(root, change.source),
        target = safeFile(root, change.target);
      if (hash(fs.readFileSync(source, 'utf8')) !== change.beforeHash)
        throw new Error(`source changed during apply: ${change.source}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      temporary = fs.mkdtempSync(path.join(path.dirname(target), '.rbook-rename-'));
      const staged = path.join(temporary, 'content');
      fs.writeFileSync(staged, change.after, { mode: Number.parseInt(change.mode.slice(-3), 8) });
      if (source === target) fs.renameSync(staged, target);
      else fs.linkSync(staged, target); // Exclusive destination creation also catches late collisions.
      done.push(change);
      fs.rmSync(temporary, { recursive: true });
      temporary = undefined;
      if (source !== target) fs.unlinkSync(source);
    }
  } catch (error) {
    for (const change of done.reverse()) {
      const source = path.join(root, change.source),
        target = path.join(root, change.target);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, change.before, { mode: Number.parseInt(change.mode.slice(-3), 8) });
      if (source !== target && fs.existsSync(target)) fs.unlinkSync(target);
    }
    throw error;
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
function main(args) {
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const allowed = new Set([
    '--apply',
    '--check',
    '--public-only',
    '--capture-counts',
    '--expect-head',
    '--expect-input',
    '--report',
  ]);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`unknown argument: ${args[i]}`);
    if (
      ['--expect-head', '--expect-input', '--report'].includes(args[i]) &&
      (!args[++i] || args[i].startsWith('--'))
    )
      throw new Error('missing option value');
  }
  if (args.includes('--check') && (args.includes('--apply') || args.includes('--capture-counts')))
    throw new Error('--check is read-only');
  if (args.includes('--public-only') && !args.includes('--check'))
    throw new Error('--public-only requires --check; apply always verifies the entire tree');
  const listPath = path.join(root, 'scripts/rbook-rename-protected.json');
  let manifest = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  const { files, excluded } = readInputs(root);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (args.includes('--capture-counts')) {
    if (args.includes('--apply'))
      throw new Error('capture counts separately; it never applies a rename');
    manifest = captureCounts(files, manifest);
    manifest.capturedAgainst = head;
    fs.writeFileSync(listPath, JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write(`Captured protection/replacement counts at ${head}; source unchanged.\n`);
    return;
  }
  const report = args.includes('--check')
    ? checkRename(files, manifest, { publicOnly: args.includes('--public-only') })
    : planRename(files, manifest);
  if (args.includes('--apply')) {
    if (value('--expect-head') !== head)
      throw new Error('--apply requires --expect-head matching the reviewed current commit');
    if (manifest.capturedAgainst !== head)
      throw new Error('--apply requires protection counts captured against current HEAD');
    if (value('--expect-input') !== report.inputHash)
      throw new Error('--apply requires --expect-input matching the reviewed preview inputHash');
    applyPlan(root, report);
  }
  const output = {
    mode: args.includes('--check') ? 'check' : args.includes('--apply') ? 'apply' : 'dry-run',
    head,
    inputHash: report.inputHash,
    ok: report.ok,
    scope: args.includes('--public-only') ? 'public-mirror' : 'full-tree',
    fileCount: files.length,
    scannedFileCount: report.scannedFileCount ?? files.length,
    excluded,
    issues: report.issues,
    reviews: report.reviews,
    changes: report.changes?.map(({ before, after, ...change }) => ({
      ...change,
      beforeLines: before.split('\n').length,
      afterLines: after.split('\n').length,
    })),
  };
  const serialized = JSON.stringify(output, null, 2) + '\n';
  if (value('--report')) fs.writeFileSync(path.resolve(root, value('--report')), serialized);
  process.stdout.write(
    value('--report')
      ? JSON.stringify(
          {
            mode: output.mode,
            head,
            inputHash: report.inputHash,
            ok: output.ok,
            scope: output.scope,
            fileCount: files.length,
            scannedFileCount: output.scannedFileCount,
            excludedCount: excluded.length,
            issueCount: report.issues.length,
            reviewCount: report.reviews.length,
            changeCount: report.changes?.length,
            pathChangeCount: report.changes?.filter((change) => change.source !== change.target)
              .length,
            report: path.resolve(root, value('--report')),
          },
          null,
          2
        ) + '\n'
      : serialized
  );
  process.exitCode = report.ok ? 0 : 1;
}
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Rename refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = { readInputs, applyPlan, main };
