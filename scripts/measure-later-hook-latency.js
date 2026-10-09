#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Measures later-prompt wall time through fresh built CLI and plugin shim processes.
// ABOUTME: Uses readonly store backups, counts-only receipts and isolated state that is always removed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { queriesFor, invoke, summary, hash } = require('./measure-m05-hook-latency');
const { targetForStore } = require('../dist/tools/cmos/local-telemetry');
const { skipLaterPrompt } = require('../dist/cli/later-prompt-recall');
const repo = path.resolve(__dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  const projects = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--project' || !args[index + 1]) throw Error('invalid_arguments');
    projects.push(path.resolve(args[++index]));
  }
  if (!projects.length) throw Error('missing_projects');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m02-later-latency-'));
  const manifest = path.join(repo, 'dist/.build-manifest.json');
  const buildHash = JSON.parse(fs.readFileSync(manifest)).buildHash;
  let passed = true;
  console.log(
    JSON.stringify({
      buildHash,
      node: process.version,
      loadBefore: os.loadavg(),
      predicate:
        'Ten eligible newest-decision headlines per supplied store, no retrieval-label tuning. Every later sample is a fresh process after an available-empty first prompt in that session; all samples counted. Shim arm borrows the validated matching PATH package, including executable and native checks.',
      wallClockRule:
        'Fresh spawn through process exit, including startup, output and telemetry. Real clock, unchanged production800ms CLI deadline; maximum wall time must remain below1000ms.',
      percentileRule:
        'Nearest rank sorted[ceil(p*n)-1]; bootstrap prompts excluded from latency samples.',
    })
  );
  try {
    const bin = path.join(temporary, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(repo, 'dist/bin.js'), path.join(bin, 'cmos-mcp'));
    for (const [projectIndex, project] of projects.entries()) {
      const root = path.join(temporary, `project-${projectIndex}`);
      const dbPath = path.join(root, 'cmos/db/cmos.sqlite');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const source = new Database(path.join(project, 'cmos/db/cmos.sqlite'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        await source.backup(dbPath);
      } finally {
        source.close();
      }
      const before = hash(dbPath);
      const copied = new Database(dbPath, { readonly: true });
      const decisionRows = copied.prepare('SELECT count(*) AS n FROM strategic_decisions').get().n;
      copied.close();
      const queries = queriesFor(dbPath, 50)
        .filter((query) => !skipLaterPrompt(query))
        .slice(0, 10);
      if (queries.length !== 10) throw Error('insufficient_eligible_subjects');
      for (const arm of ['cli', 'plugin-path']) {
        const env = {
          ...process.env,
          CMOS_CONFIG_DIR: path.join(temporary, `config-${projectIndex}-${arm}`),
          CLAUDE_PLUGIN_DATA: path.join(temporary, `plugin-data-${projectIndex}`),
          CLAUDE_PROJECT_DIR: root,
          CLAUDE_PID: String(process.pid),
          CMOS_AMBIENT: 'on',
          CMOS_CHECKPOINT_SYNC: 'off',
          CMOS_OFFLINE_EMBEDDINGS: '1',
          PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        };
        const target = targetForStore(dbPath);
        if (!target) throw Error('copied_identity_unavailable');
        const entry = path.join(repo, arm === 'cli' ? 'dist/bin.js' : 'plugins/cmos/hooks/run.mjs');
        const samples = queries.map((query, index) => {
          const session = `later-${projectIndex}-${arm}-${index}`;
          const first = invoke(root, env, session, 'the', target, entry, 'cmos-plugin');
          if (
            first.exit !== 0 ||
            first.chars ||
            first.stderrLines ||
            first.failOpen ||
            !first.telemetryOk
          ) {
            console.log(
              JSON.stringify({
                bootstrapFailure: { store: path.basename(project), arm, index, ...first },
              })
            );
            throw Error('empty_bootstrap_failed');
          }
          return invoke(root, env, session, query, target, entry, 'cmos-plugin');
        });
        const failures = samples.filter(
          (sample) =>
            sample.exit !== 0 ||
            sample.spawnError ||
            sample.stderrLines ||
            sample.failOpen ||
            !sample.telemetryOk ||
            sample.chars > 1500 ||
            sample.ids > 3 ||
            sample.wallMs >= 1000 ||
            sample.records !== 2
        );
        const positives = samples.filter((sample) => sample.ids > 0).length;
        const unchanged = before === hash(dbPath);
        passed = passed && failures.length === 0 && positives > 0 && unchanged;
        console.log(
          JSON.stringify({
            store: path.basename(project),
            arm,
            decisionRows,
            countRule: 'All rows in strategic_decisions in the readonly backup.',
            samples: samples.length,
            failures: failures.length,
            withOutput: positives,
            wallMs: summary(samples.map((sample) => sample.wallMs)),
            maxChars: Math.max(...samples.map((sample) => sample.chars)),
            maxItems: Math.max(...samples.map((sample) => sample.ids)),
            backupUnchanged: unchanged,
            failureMeasurements: failures,
          })
        );
      }
    }
    const buildHashUnchanged = JSON.parse(fs.readFileSync(manifest)).buildHash === buildHash;
    passed = passed && buildHashUnchanged;
    console.log(JSON.stringify({ passed, buildHashUnchanged, loadAfter: os.loadavg() }));
    if (!passed) process.exitCode = 1;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    console.log(JSON.stringify({ temporaryCopiesRemoved: !fs.existsSync(temporary) }));
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: /^[a-z_]+$/.test(error.message) ? error.message : 'latency_probe_failed',
      countsOnly: true,
    })
  );
  process.exitCode = 1;
});
