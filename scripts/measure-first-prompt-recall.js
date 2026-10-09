#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Measure the m05 natural-label older-context gate against current source on temporary SQLite slices.
// ABOUTME: Emit counts only; preserve the historical population, isolate all writes, and remove copied text.

const fs = require('fs');
const path = require('path');
const os = require('os');
const ts = require('typescript');
const Database = require('better-sqlite3');

const STORES = ['cmos-mcp-pro', 'forge', 'stage1', 'deepsearch'];
const CONFIGS = [
  'production_decision',
  'production_mixed',
  'bm25_decision',
  'bm25_mixed',
  'cli_mixed',
  'first_prompt',
  'hook_emitted',
];
const EXPECTED_POSITIVES = 292;
const EXPECTED_QUERIES = 190;
const FLOOR = 0.3;

function argumentsFor(argv) {
  let scratch;
  let gate = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scratch' && argv[i + 1]) scratch = path.resolve(argv[++i]);
    else if (argv[i] === '--gate') gate = true;
    else throw new Error('invalid_arguments');
  }
  if (!scratch) throw new Error('missing_scratch');
  return { scratch, gate };
}

function counts() {
  return Object.fromEntries(CONFIGS.map((key) => [key, { hits: 0, positives: 0 }]));
}

function sourceModules() {
  // Transpile only in memory: this probe must neither rebuild dist nor require a model package.
  const previousLoader = require.extensions['.ts'];
  require.extensions['.ts'] = (mod, file) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    });
    mod._compile(outputText, file);
  };
  return {
    ...require('../src/tools/cmos/client.ts'),
    ...require('../src/tools/cmos/fts5-retriever.ts'),
    ...require('../src/cli/commands.ts'),
    ...require('../src/tools/cmos/first-prompt-recall.ts'),
    ...require('../src/cli.ts'),
    restoreLoader() {
      if (previousLoader) require.extensions['.ts'] = previousLoader;
      else delete require.extensions['.ts'];
    },
  };
}

function sliceWriter(db) {
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO metadata VALUES ('project_id', 'recall-probe');
    CREATE TABLE constraints (id INTEGER PRIMARY KEY, content TEXT, status TEXT, expires_at TEXT);
    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY, decision_text TEXT, status TEXT, created_at TEXT,
      sprint_id TEXT, category TEXT, evidence TEXT
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY, content TEXT, status TEXT, created_at TEXT,
      sprint_id TEXT, category TEXT
    );
    CREATE VIRTUAL TABLE decisions_fts USING fts5(
      decision_text, content='strategic_decisions', content_rowid='id'
    );
    CREATE VIRTUAL TABLE learnings_fts USING fts5(
      content, content='learnings', content_rowid='id'
    );
  `);
  const insertDecision = db.prepare('INSERT INTO strategic_decisions VALUES(?,?,?,?,?,?,?)');
  const insertLearning = db.prepare('INSERT INTO learnings VALUES(?,?,?,?,?,?)');
  return db.transaction((corpus, query) => {
    db.exec('DELETE FROM strategic_decisions; DELETE FROM learnings;');
    for (const [type, key, statement] of [
      ['decision', 'decisions', insertDecision],
      ['learning', 'learnings', insertLearning],
    ]) {
      for (const row of corpus[key]) {
        if (
          row.ms === null ||
          row.ms >= query.qms ||
          (query.qtype === type && row.id === query.qrow)
        ) {
          continue;
        }
        // Match replica.py nosup: a superseder written at query time has not applied yet.
        const supersededBeforeQuery = row.inactive_from !== null && row.inactive_from < query.qms;
        const status =
          row.status === 'superseded' && !supersededBeforeQuery ? 'active' : row.status;
        const values = [row.id, row.text, status, new Date(row.ms).toISOString(), row.sprint, null];
        if (type === 'decision') values.push(null);
        statement.run(...values);
      }
    }
    // Rebuilding the scratch index gives BM25 the historical slice's document statistics.
    db.exec(`
      INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild');
      INSERT INTO learnings_fts(learnings_fts) VALUES('rebuild');
    `);
  });
}

function decisionIds(rows) {
  return rows
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .filter((row) => row.type === 'decision')
    .map((row) => row.id);
}

let hookSequence = 0;

async function emittedHookIds(source, dbPath, query) {
  const root = path.dirname(path.dirname(path.dirname(dbPath)));
  let stdout = '';
  let errors = 0;
  const code = await source.runCli(['hook', 'prompt', '--format', 'text', '--project-root', root], {
    env: { ...process.env, CMOS_AMBIENT: 'on', CLAUDE_PROJECT_DIR: '' },
    cwd: root,
    readStdin: async () => JSON.stringify({ session_id: `probe-${++hookSequence}`, prompt: query }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {
      errors++;
    },
  });
  if (code !== 0 || errors || stdout.length > 1501) throw new Error('hook_delivery_failed');
  const ids = [...stdout.matchAll(/^ {2}• d:([1-9]\d*) /gm)].map((match) => Number(match[1]));
  if (ids.length > 5) throw new Error('hook_item_count_exceeded');
  return ids;
}

async function currentSourceResults(source, dbPath, query) {
  const opened = await source.CmosDatabaseClient.create({ dbPath, readonly: true });
  if (!opened.success || !opened.data) throw new Error('readonly_open_failed');
  const client = opened.data;
  try {
    const retriever = new source.HybridRetriever(client);
    // Invoke the existing production keyword branch with a null vector. The public entry point
    // also initializes indexes and resolves optional embeddings; neither belongs in this probe.
    // This private method name is intentionally explicit: a future refactor must update the probe.
    const keyword = (type, weight) =>
      retriever.searchHybridForType(
        type,
        query,
        null,
        25,
        weight,
        undefined,
        source.DEFAULT_RRF_K,
        false,
        source.DEFAULT_GRAPH_WEIGHT
      );
    const productionWeight = source.DEFAULT_RECENCY_WEIGHT;
    const firstPrompt = source.recallFirstPrompt(dbPath, query, { nowMs: Date.now() });
    if (!firstPrompt.available) throw new Error('first_prompt_unavailable');
    return {
      first_prompt: firstPrompt.items.map((item) => item.id),
      hook_emitted: await emittedHookIds(source, dbPath, query),
      production_decision: decisionIds(keyword('decision', productionWeight)),
      production_mixed: decisionIds([
        ...keyword('decision', productionWeight),
        ...keyword('learning', productionWeight),
      ]),
      bm25_decision: decisionIds(keyword('decision', 0)),
      bm25_mixed: decisionIds([...keyword('decision', 0), ...keyword('learning', 0)]),
      cli_mixed: source
        .keywordRelevant(dbPath, query, 5)
        .filter((row) => row.kind === 'decision')
        .map((row) => row.id),
    };
  } finally {
    client.close();
  }
}

async function measure(source, scratch, dbPath, fill) {
  const total = counts();
  let queries = 0;
  for (const store of STORES) {
    const corpus = JSON.parse(
      fs.readFileSync(path.join(scratch, 'data', `${store}.corpus.json`), 'utf8')
    );
    const records = fs
      .readFileSync(path.join(scratch, 'data', `${store}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const local = counts();
    for (const record of records) {
      const positives = record.positives.filter(
        (positive) => positive.type === 'decision' && positive.age_days >= 7
      );
      if (record.qtype === 'mission' || positives.length === 0) continue;
      if (!record.q_cite.trim()) throw new Error('empty_citing_sentence_query');
      queries++;
      fill(corpus, record);
      Date.now = () => record.qms;
      const results = await currentSourceResults(source, dbPath, record.q_cite);
      for (const [key, ids] of Object.entries(results)) {
        const hits = positives.filter((positive) => ids.includes(positive.id)).length;
        for (const target of [local, total]) {
          target[key].hits += hits;
          target[key].positives += positives.length;
        }
      }
    }
    console.log(JSON.stringify({ store, counts: local }));
  }
  const populationMatches =
    queries === EXPECTED_QUERIES &&
    Object.values(total).every((count) => count.positives === EXPECTED_POSITIVES);
  const recall = total.hook_emitted.hits / total.hook_emitted.positives;
  console.log(
    JSON.stringify({
      queries,
      total,
      populationMatches,
      gateConfiguration: 'hook_emitted',
      recallAt5: recall,
      floor: FLOOR,
      passes: populationMatches && recall >= FLOOR,
    })
  );
  if (!populationMatches) throw new Error('historical_population_mismatch');
  return recall >= FLOOR;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m05-recall-'));
  const originalNow = Date.now;
  let db;
  let source;
  try {
    process.env.CMOS_CONFIG_DIR = path.join(temporary, 'config');
    process.env.CMOS_OFFLINE_EMBEDDINGS = '1';
    process.env.CMOS_CHECKPOINT_SYNC = 'off';
    source = sourceModules();
    const dbPath = path.join(temporary, 'project', 'cmos', 'db', 'cmos.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    const passed = await measure(source, options.scratch, dbPath, sliceWriter(db));
    if (options.gate && !passed) process.exitCode = 1;
  } finally {
    Date.now = originalNow;
    if (db) db.close();
    if (source) source.restoreLoader();
    fs.rmSync(temporary, { recursive: true, force: true });
    console.log(JSON.stringify({ temporaryPacketRemoved: !fs.existsSync(temporary) }));
  }
}

// The later-prompt probe reuses the exact historical slice and source loader.
module.exports = { sourceModules, sliceWriter };

if (require.main === module) {
  main().catch(() => {
    // Never print parser/SQL errors: an exception can contain corpus text or an input path.
    console.error(JSON.stringify({ error: 'recall_probe_failed', countsOnly: true }));
    process.exitCode = 1;
  });
}
