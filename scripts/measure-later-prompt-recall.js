#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Compare later-prompt keyword floors on unchanged historical natural citation labels.
// ABOUTME: Reuse m05's slices, count rendered local IDs only, and remove every temporary corpus copy.

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { sourceModules, sliceWriter } = require('./measure-first-prompt-recall');

const STORES = ['cmos-mcp-pro', 'forge', 'stage1', 'deepsearch'];
const FLOORS = [1, 2, 3, 4, 5];
const MODES = ['unseen-all', 'after-first-same-query'];

function count() {
  return { queries: 0, skipped: 0, positives: 0, hits: 0, emitted: 0, withOutput: 0 };
}

function add(target, values) {
  for (const key of Object.keys(target)) target[key] += values[key];
}

let hookSequence = 0;

async function emittedHookIds(source, root, sessionId, query, cap) {
  let stdout = '';
  let errors = 0;
  const code = await source.runCli(['hook', 'prompt', '--format', 'text', '--project-root', root], {
    env: { ...process.env, CMOS_AMBIENT: 'on', CLAUDE_PROJECT_DIR: '' },
    cwd: root,
    readStdin: async () => JSON.stringify({ session_id: sessionId, prompt: query }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {
      errors++;
    },
  });
  const ids = [...stdout.matchAll(/^ {2}• (d:[1-9]\d*) /gm)].map((match) => match[1]);
  if (code !== 0 || errors || stdout.length > 1501 || ids.length > cap)
    throw Error('hook_delivery_failed');
  return ids;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--scratch') throw Error('invalid_arguments');
  const scratch = path.resolve(args[1]);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-later-recall-'));
  const originalNow = Date.now;
  let source;
  let db;
  try {
    process.env.CMOS_CONFIG_DIR = path.join(temporary, 'config');
    process.env.CMOS_OFFLINE_EMBEDDINGS = '1';
    process.env.CMOS_CHECKPOINT_SYNC = 'off';
    source = sourceModules();
    const { recallLaterPrompt, skipLaterPrompt } = require('../src/cli/later-prompt-recall.ts');
    const { renderFirstPrompt } = require('../src/cli/prompt.ts');
    const { emittedRenderedIds } = require('../src/cli/telemetry.ts');
    const dbPath = path.join(temporary, 'project', 'cmos', 'db', 'cmos.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    const fill = sliceWriter(db);
    const total = Object.fromEntries(
      MODES.map((mode) => [mode, Object.fromEntries(FLOORS.map((floor) => [floor, count()]))])
    );
    const emittedHooks = Object.fromEntries(MODES.map((mode) => [mode, count()]));
    let populationQueries = 0;
    let populationPositives = 0;
    for (const store of STORES) {
      const corpus = JSON.parse(
        fs.readFileSync(path.join(scratch, 'data', `${store}.corpus.json`))
      );
      const records = fs
        .readFileSync(path.join(scratch, 'data', `${store}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      for (const record of records) {
        const positives = record.positives.filter(
          (item) => item.type === 'decision' && item.age_days >= 7
        );
        if (record.qtype === 'mission' || !positives.length) continue;
        populationQueries++;
        populationPositives += positives.length;
        fill(corpus, record);
        Date.now = () => record.qms;
        const query = record.q_cite;
        if (!query.trim()) throw Error('empty_query');
        const first = source.recallFirstPrompt(dbPath, query);
        if (!first.available) throw Error('first_unavailable');
        const firstContext = renderFirstPrompt(first);
        const prior = emittedRenderedIds(firstContext, firstContext.text);
        for (const mode of MODES) {
          const seen = mode === 'unseen-all' ? [] : prior;
          const remaining = positives.filter((item) => !seen.includes(`d:${item.id}`));
          let expectedIds;
          for (const floor of FLOORS) {
            const skipped = skipLaterPrompt(query);
            let emitted = [];
            if (!skipped) {
              const result = recallLaterPrompt(dbPath, query, seen, { minKeywordMatches: floor });
              if (!result.available) throw Error('later_unavailable');
              const context = renderFirstPrompt(result);
              if (context.text.length > 1500) throw Error('text_cap');
              emitted = emittedRenderedIds(context, context.text);
              if (emitted.length > 3 || emitted.some((id) => seen.includes(id)))
                throw Error('item_cap_or_seen_replay');
            }
            add(total[mode][floor], {
              queries: 1,
              skipped: Number(skipped),
              positives: remaining.length,
              hits: remaining.filter((item) => emitted.includes(`d:${item.id}`)).length,
              emitted: emitted.length,
              withOutput: Number(emitted.length > 0),
            });
            if (floor === 3) expectedIds = emitted;
          }
          const root = path.dirname(path.dirname(path.dirname(dbPath)));
          const sessionId = `later-probe-${++hookSequence}`;
          // A nonempty stopword-only first attempt commits m05's empty-result receipt.
          // The other mode uses the same real first prompt as the controlled helper experiment.
          const bootstrap = await emittedHookIds(
            source,
            root,
            sessionId,
            mode === 'unseen-all' ? 'the' : query,
            5
          );
          if (JSON.stringify(bootstrap) !== JSON.stringify(seen)) throw Error('bootstrap_mismatch');
          const emitted = await emittedHookIds(source, root, sessionId, query, 3);
          if (JSON.stringify(emitted) !== JSON.stringify(expectedIds))
            throw Error('hook_helper_mismatch');
          add(emittedHooks[mode], {
            queries: 1,
            skipped: Number(skipLaterPrompt(query)),
            positives: remaining.length,
            hits: remaining.filter((item) => emitted.includes(`d:${item.id}`)).length,
            emitted: emitted.length,
            withOutput: Number(emitted.length > 0),
          });
        }
      }
    }
    if (populationQueries !== 190 || populationPositives !== 292)
      throw Error('historical_population_mismatch');
    console.log(
      JSON.stringify({
        predicate:
          'Non-mission citing sentences with decision positives aged >=7 days; historical slices before each query; later skips applied; complete rendered local IDs only. after-first-same-query excludes the five actually rendered first-prompt IDs from later retrieval and gold positives.',
        limitations:
          'In-sample citation proxies, not held-out user prompts. Unlabeled results are not known irrelevant. Same-query first/later is a controlled unseen-state experiment, not an observed conversation.',
        populationQueries,
        populationPositives,
        total,
        emittedHooks,
      })
    );
  } finally {
    Date.now = originalNow;
    if (db) db.close();
    if (source) source.restoreLoader();
    fs.rmSync(temporary, { recursive: true, force: true });
    console.log(JSON.stringify({ temporaryPacketRemoved: !fs.existsSync(temporary) }));
  }
}

main().catch(() => {
  console.error(JSON.stringify({ error: 'later_recall_probe_failed', countsOnly: true }));
  process.exitCode = 1;
});
