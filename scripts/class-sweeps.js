#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Runs the public class-sweep gate over tracked working-tree source files of every extension.
// ABOUTME: Reads no stores or historical revisions and reports excluded encodings without hiding read errors.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { TextDecoder } = require('util');
const { REQUIRED, validateArtifacts, safePath } = require('./lib/class-sweep-schema');
const { evaluateSweeps } = require('./lib/class-sweep-evaluator');

function readRegular(root, file) {
  const absolute = path.join(root, file);
  if (!fs.lstatSync(absolute).isFile()) throw new Error(`nonregular or symlink path: ${file}`);
  const resolved = fs.realpathSync(absolute);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe escaping path: ${file}`);
  return fs.readFileSync(absolute);
}

function loadSweepInputs(projectRoot) {
  const root = fs.realpathSync(projectRoot);
  const tracked = execFileSync('git', ['ls-files', '-z', '--stage', '--', 'src/'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const sources = [];
  const excluded = [];
  const seen = new Set();
  for (const record of tracked) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('invalid Git index entry');
    const [, mode, , stage, file] = match;
    safePath(file);
    if (stage !== '0') throw new Error(`unmerged source path: ${file}`);
    if (!['100644', '100755'].includes(mode)) throw new Error(`nonregular indexed source: ${file}`);
    if (seen.has(file)) throw new Error(`duplicate tracked source: ${file}`);
    seen.add(file);
    const bytes = readRegular(root, file);
    if (bytes.includes(0)) {
      excluded.push({ file, reason: 'binary NUL' });
      continue;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      excluded.push({ file, reason: 'invalid UTF-8' });
      continue;
    }
    sources.push({ file, lines: text.split('\n') });
  }
  const directory = path.join(root, 'tests/sweeps');
  const names = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const expected = Object.keys(REQUIRED)
    .map((id) => `${id}.json`)
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error('missing or unknown required artifact files');
  const artifacts = names.map((name) => {
    const bytes = readRegular(root, `tests/sweeps/${name}`);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  });
  return {
    artifacts: validateArtifacts(artifacts),
    sources,
    universe: { trackedFiles: seen.size, textFiles: sources.length, excluded },
  };
}

function runClassSweeps(root = path.resolve(__dirname, '..')) {
  try {
    const { artifacts, sources, universe } = loadSweepInputs(root);
    return { mode: 'tracked-working-tree', universe, ...evaluateSweeps(artifacts, sources) };
  } catch (error) {
    return {
      ok: false,
      mode: 'tracked-working-tree',
      sweeps: [],
      issues: [`class-sweep input: ${error.message}`],
    };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--json') || args.length > 1) {
    process.stderr.write('Usage: node scripts/class-sweeps.js [--json]\n');
    process.exitCode = 1;
  } else {
    const report = runClassSweeps();
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      for (const sweep of report.sweeps)
        process.stdout.write(
          `${sweep.mission}/${sweep.arm}: ${sweep.currentCount} ${sweep.unit} (${sweep.currentMatchingLines} matching lines), historical ${sweep.historicalCount}; ${sweep.vanishedHistorical.length} historical occurrences vanished\n`
        );
      for (const exclusion of report.universe?.excluded ?? [])
        process.stdout.write(`Excluded ${exclusion.file}: ${exclusion.reason}\n`);
      for (const issue of report.issues) process.stderr.write(`${issue}\n`);
    }
    process.exitCode = report.ok ? 0 : 1;
  }
}

module.exports = { loadSweepInputs, runClassSweeps };
