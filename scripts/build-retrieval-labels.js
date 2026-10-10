#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Freezes local natural-citation labels using the production extractor and prior-only inventories.
// ABOUTME: Refuses replacement of evidence; no source store is opened and no retrieval score is consulted.

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { sha, checkedJson, timeMs } = require('./retrieval-quality-fixture');

function buildLabels(corpus, extractor) {
  const kinds = {
    strategic_decisions: 'decision',
    learnings: 'learning',
    constraints: 'constraint',
    next_steps: 'next_step',
    agent_feedback: 'feedback',
  };
  const inventory = Object.entries(corpus.collisionInventory).flatMap(([table, rows]) =>
    rows.map((row) => ({ ...row, kind: kinds[table] }))
  );
  const queries = [];
  const discarded = {};
  let unknownSourceTimes = 0;
  let citationSentenceFallbacks = 0;
  for (const [kind, rows] of [
    ['decision', corpus.decisions],
    ['learning', corpus.learnings],
    ['mission', corpus.missions],
  ]) {
    for (const [ordinal, row] of rows.entries()) {
      if (row.project_id != null && row.project_id !== corpus.projectId) continue;
      const timestamp = kind === 'mission' ? (row.started_at ?? row.created_at) : row.created_at;
      const cutoff = timeMs(timestamp);
      if (!Number.isFinite(cutoff)) {
        unknownSourceTimes++;
        continue;
      }
      let fields;
      if (kind === 'mission') {
        let criteria = row.success_criteria;
        try {
          criteria = JSON.parse(criteria);
        } catch {
          /* Historical prose remains a separate field. */
        }
        fields = [row.objective, ...(Array.isArray(criteria) ? criteria : [criteria])].filter(
          (value) => typeof value === 'string'
        );
      } else fields = extractor.canonicalRecordFields(kind, row);
      const source = {
        kind,
        id: kind === 'mission' ? ordinal + 1 : row.id,
        created_at: timestamp,
        project_id: row.project_id,
      };
      // Unknown chronology is retained as a conservative ambiguity blocker, never a target.
      const prior = inventory.filter(
        (item) => !Number.isFinite(timeMs(item.created_at)) || timeMs(item.created_at) < cutoff
      );
      const extracted = extractor.extractRecordLinkCandidates(
        fields,
        source,
        prior,
        corpus.projectId
      );
      for (const [name, count] of Object.entries(extracted.discarded))
        discarded[name] = (discarded[name] ?? 0) + count;
      const positiveIds = [
        ...new Set(
          extracted.links.map((link) => `${link.to_kind === 'decision' ? 'd' : 'l'}:${link.to_id}`)
        ),
      ].sort();
      if (!positiveIds.length) continue;
      const positiveSet = new Set(positiveIds);
      const sentences = fields
        .flatMap((field) => field.match(/[^.!?\n]+(?:[.!?]|$)/g) ?? [])
        .filter((sentence) => {
          const found = extractor.extractRecordLinkCandidates(
            [sentence],
            source,
            prior,
            corpus.projectId
          );
          return found.links.some((link) =>
            positiveSet.has(`${link.to_kind === 'decision' ? 'd' : 'l'}:${link.to_id}`)
          );
        });
      if (!sentences.length) citationSentenceFallbacks++;
      queries.push({
        id: `${kind}:${row.id}`,
        kind,
        rowId: row.id,
        cutoff,
        full: fields.join('\n'),
        cite: [...new Set(sentences)].join(' ').trim() || fields.join('\n'),
        positiveIds,
      });
    }
  }
  return { schemaVersion: 1, queries, discarded, unknownSourceTimes, citationSentenceFallbacks };
}

function main(argv) {
  if (argv.length !== 2)
    throw new Error('Usage: build-retrieval-labels.js <corpus-directory> <output-directory>');
  const [fixture, output] = argv.map((value) => path.resolve(value));
  if (fs.existsSync(output))
    throw new Error('Frozen labels directory already exists; refusing replacement.');
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json'), 'utf8'));
  const corpus = checkedJson(path.join(fixture, manifest.file), manifest.sha256);
  const root = path.resolve(__dirname, '..');
  const previous = require.extensions['.ts'];
  const hashes = {};
  require.extensions['.ts'] = (mod, file) => {
    const bytes = fs.readFileSync(file);
    hashes[path.relative(root, file)] = sha(bytes);
    mod._compile(
      ts.transpileModule(bytes.toString('utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true,
        },
      }).outputText,
      file
    );
  };
  try {
    const extractor = require('../src/tools/cmos/record-link-extractor.ts');
    const labels = buildLabels(corpus, extractor);
    for (const [file, hash] of Object.entries(hashes)) {
      if (sha(fs.readFileSync(path.join(root, file))) !== hash)
        throw new Error(`extractor changed: ${file}`);
    }
    const bytes = JSON.stringify(labels, null, 2) + '\n';
    const receipt = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      corpusSha256: manifest.sha256,
      labelsSha256: sha(bytes),
      extractorSources: hashes,
      generatorSha256: sha(fs.readFileSync(__filename)),
      rule: 'One query per local/NULL-origin decision, learning or mission with >=1 production-accepted prior d/l citation. Primary units split non-mission queries by target kind; mixed units union typed positives. Mission cutoff started_at else created_at, current objective/criteria are mutable historical proxies.',
      temporalRule:
        'Candidate and edge source created_at < cutoff. Inventory keeps known prior rows and conservatively retains unknown-time blockers; no future rows. Pointer supersession follows prior superseder time; pointerless uses known sprint end, otherwise treated active. Archived status stays eligible.',
      counts: {
        queries: labels.queries.length,
        primary: labels.queries
          .filter((q) => q.kind !== 'mission')
          .reduce(
            (n, q) =>
              n +
              ['d:', 'l:'].filter((prefix) => q.positiveIds.some((id) => id.startsWith(prefix)))
                .length,
            0
          ),
        mission: labels.queries.filter(
          (q) => q.kind === 'mission' && q.positiveIds.some((id) => id.startsWith('d:'))
        ).length,
        mixed: labels.queries.filter((q) => q.kind !== 'mission').length,
      },
      discarded: labels.discarded,
      unknownSourceTimes: labels.unknownSourceTimes,
      citationSentenceFallbacks: labels.citationSentenceFallbacks,
    };
    if (!receipt.counts.primary || !receipt.counts.mission)
      throw new Error('empty acceptance population');
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'labels.json'), bytes);
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
    process.stdout.write(
      JSON.stringify({
        labelsSha256: receipt.labelsSha256,
        counts: receipt.counts,
        discarded: receipt.discarded,
      }) + '\n'
    );
  } finally {
    if (previous) require.extensions['.ts'] = previous;
    else delete require.extensions['.ts'];
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { buildLabels };
