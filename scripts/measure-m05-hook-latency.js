#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Measure fresh built-bin prompt hooks on readonly backups with the production deadline intact.
// ABOUTME: Print counts and latency only; isolate runtime state, verify copied bytes and remove all copied text.

const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const Database = require('better-sqlite3');

const repo = path.resolve(__dirname, '..');
const { digestHeadline } = require('../dist/tools/cmos/digest-v2');
const { readTelemetry, targetForStore } = require('../dist/tools/cmos/local-telemetry');
const { harnessSessionHash } = require('../dist/tools/cmos/harness-session');
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function argumentsFor(argv) {
  const projects = [];
  let samples = 10;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--project' && argv[index + 1]) projects.push(path.resolve(argv[++index]));
    else if (argv[index] === '--samples' && argv[index + 1]) samples = Number(argv[++index]);
    else throw new Error('invalid_arguments');
  }
  if (!projects.length || !Number.isInteger(samples) || samples < 2 || samples > 50)
    throw new Error('invalid_arguments');
  return { projects, samples };
}

function queriesFor(dbPath, samples) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const columns = new Set(db.pragma('table_info(strategic_decisions)').map((row) => row.name));
    const local = db.prepare("SELECT value FROM metadata WHERE key='project_id'").get()?.value;
    const scoped = columns.has('project_id');
    if (scoped && !local) throw new Error('query_project_identity_unavailable');
    const rows = db
      .prepare(
        `SELECT decision_text FROM strategic_decisions
      WHERE COALESCE(status,'active') <> 'superseded'
      ${columns.has('superseded_by') ? 'AND superseded_by IS NULL' : ''}
      ${scoped ? 'AND (project_id IS NULL OR project_id = ?)' : ''}
      ORDER BY julianday(created_at) DESC, id DESC LIMIT ?`
      )
      .all(...(scoped ? [local] : []), samples * 2);
    const queries = rows
      .map((row) => digestHeadline(row.decision_text))
      .filter(Boolean)
      .slice(0, samples);
    if (queries.length !== samples) throw new Error('insufficient_query_subjects');
    return queries;
  } finally {
    db.close();
  }
}

function invoke(
  root,
  env,
  session,
  query,
  target,
  entry = path.join(repo, 'dist/bin.js'),
  hookSource
) {
  const start = performance.now();
  const child = spawnSync(
    process.execPath,
    [
      entry,
      'hook',
      'prompt',
      '--format',
      'text',
      '--project-root',
      root,
      ...(hookSource ? ['--hook-source', hookSource] : []),
    ],
    {
      env,
      cwd: root,
      input: JSON.stringify({ session_id: session, cwd: root, prompt: query }),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 256 * 1024,
    }
  );
  const wallMs = performance.now() - start;
  const text = (child.stdout ?? '').replace(/\n$/, '');
  const records = readTelemetry(target, env).filter(
    (record) =>
      record.tool === 'hook prompt' && record.session === `ext:${harnessSessionHash(session)}`
  );
  const record = records[records.length - 1];
  return {
    wallMs,
    exit: child.status,
    chars: text.length,
    ids: (text.match(/^ {2}• d:[1-9]\d* /gm) ?? []).length,
    stderrLines: (child.stderr ?? '').split('\n').filter(Boolean).length,
    failOpen: record?.failOpen ?? null,
    telemetryOk: record?.ok === true,
    spawnError: child.error?.code ?? null,
    records: records.length,
  };
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (number) => Math.round(number * 10) / 10;
  const percentile = (fraction) => round(sorted[Math.ceil(sorted.length * fraction) - 1]);
  return {
    min: round(sorted[0]),
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m05-bin-latency-'));
  const buildHash = JSON.parse(
    fs.readFileSync(path.join(repo, 'dist/.build-manifest.json'), 'utf8')
  ).buildHash;
  let passed = true;
  console.log(
    JSON.stringify({
      buildHash,
      node: process.version,
      samplesPerStore: options.samples,
      wallClockRule:
        'Fresh node spawn through process exit, including startup, input, output and telemetry; every sample included. Production process-start 800ms hook deadline unchanged.',
      queryRule:
        'Headlines of newest local-or-NULL, non-superseded decision rows; first nonempty subjects, without retrieval-label tuning.',
      percentileRule:
        'Nearest rank: sorted[ceil(p*n)-1]. Same-session checks excluded from latency samples.',
      loadBefore: os.loadavg(),
    })
  );
  try {
    for (const [projectIndex, project] of options.projects.entries()) {
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
      const env = {
        ...process.env,
        CMOS_CONFIG_DIR: path.join(temporary, `config-${projectIndex}`),
        CLAUDE_PROJECT_DIR: root,
        CMOS_AMBIENT: 'on',
        CMOS_CHECKPOINT_SYNC: 'off',
        CMOS_OFFLINE_EMBEDDINGS: '1',
      };
      const target = targetForStore(dbPath);
      if (!target) throw new Error('copied_identity_unavailable');
      const queries = queriesFor(dbPath, options.samples);
      const samples = queries.map((query, index) =>
        invoke(root, env, `latency-${projectIndex}-${index}`, query, target)
      );
      const successful = (sample) =>
        sample.exit === 0 &&
        sample.chars > 0 &&
        sample.chars <= 1500 &&
        sample.ids > 0 &&
        sample.stderrLines === 0 &&
        sample.telemetryOk &&
        !sample.failOpen &&
        !sample.spawnError;
      const firstSuccess = samples.findIndex(successful);
      const repeat =
        firstSuccess < 0
          ? null
          : invoke(
              root,
              env,
              `latency-${projectIndex}-${firstSuccess}`,
              queries[firstSuccess],
              target
            );
      const repeatSilent =
        repeat !== null &&
        repeat.exit === 0 &&
        repeat.chars === 0 &&
        repeat.stderrLines === 0 &&
        repeat.telemetryOk &&
        !repeat.failOpen &&
        repeat.records === 2;
      const unchanged = before === hash(dbPath);
      const failures = samples.filter((sample) => !successful(sample));
      passed = passed && failures.length === 0 && repeatSilent && unchanged;
      console.log(
        JSON.stringify({
          store: path.basename(project),
          samples: samples.length,
          successful: samples.length - failures.length,
          failures: failures.length,
          deadlineMisses: samples.filter((sample) => sample.failOpen === 'deadline').length,
          errorSamples: samples.filter(
            (sample) => sample.stderrLines > 0 || sample.spawnError || sample.exit !== 0
          ).length,
          emptySamples: samples.filter((sample) => sample.chars === 0).length,
          capViolations: samples.filter((sample) => sample.chars > 1500).length,
          wallMs: summary(samples.map((sample) => sample.wallMs)),
          injectedChars: {
            min: Math.min(...samples.map((sample) => sample.chars)),
            max: Math.max(...samples.map((sample) => sample.chars)),
          },
          emittedDecisionCounts: {
            min: Math.min(...samples.map((sample) => sample.ids)),
            max: Math.max(...samples.map((sample) => sample.ids)),
          },
          sameSessionSecondPromptSilent: repeatSilent,
          backupHashBefore: before,
          backupHashAfter: hash(dbPath),
          backupUnchanged: unchanged,
          failureMeasurements: failures,
        })
      );
    }
    const finalHash = JSON.parse(
      fs.readFileSync(path.join(repo, 'dist/.build-manifest.json'), 'utf8')
    ).buildHash;
    passed = passed && finalHash === buildHash;
    console.log(
      JSON.stringify({
        passed,
        buildHashUnchanged: finalHash === buildHash,
        loadAfter: os.loadavg(),
      })
    );
    if (!passed) process.exitCode = 1;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    console.log(JSON.stringify({ temporaryCopiesRemoved: !fs.existsSync(temporary) }));
  }
}

module.exports = { queriesFor, invoke, summary, hash };

if (require.main === module)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error:
          error instanceof Error && /^[a-z_]+$/.test(error.message)
            ? error.message
            : 'latency_probe_failed',
        countsOnly: true,
      })
    );
    process.exitCode = 1;
  });
