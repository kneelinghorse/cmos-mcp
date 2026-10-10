// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Citation recall must be explicit, bounded, origin-safe and visible in actual mission output.
// ABOUTME: Real SQLite records distinguish missing lexical matches from precision-only callers.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { ensureVectorStorage } from '../../../src/tools/cmos/schema-migrations';
import { ensureRecordLinks, materializeRecordLinks } from '../../../src/tools/cmos/record-links';
import { HybridRetriever } from '../../../src/tools/cmos/fts5-retriever';
import { findRelevantDecisions } from '../../../src/tools/cmos/relevance-surfacing';
import { recallFirstPrompt } from '../../../src/tools/cmos/first-prompt-recall';
import { cmosContextSearch } from '../../../src/tools/cmos/cmos-context-search';
import { cmosDecisionsSearch } from '../../../src/tools/cmos/cmos-decisions-search';
import { captureToolCall } from '../../../src/tools/cmos/tool-call-context';

let root: string, dbPath: string, client: CmosDatabaseClient;
let now: number;
beforeEach(async () => {
  now = Date.now();
  jest.spyOn(HybridRetriever.prototype as any, 'embedQuery').mockResolvedValue(null);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-citation-retrieval-'));
  dbPath = seedCmosDb(root, { projectId: 'citation-test' });
  const opened = await CmosDatabaseClient.create({ dbPath });
  if (!opened.success || !opened.data) throw new Error('fixture open failed');
  client = opened.data;
  ensureVectorStorage(client);
  if (!ensureRecordLinks(client).ready) throw new Error('fixture link preflight failed');
});
afterEach(() => {
  jest.restoreAllMocks();
  client?.close();
  fs.rmSync(root, { recursive: true, force: true });
});
function decision(
  id: number,
  text: string,
  age = 1,
  status = 'active',
  context: string | null = null
) {
  const result = client.execute(
    `INSERT INTO strategic_decisions
    (id,decision_text,context_text,created_at,status,project_id) VALUES(?,?,?,?,?,?)`,
    [id, text, context, new Date(now - age * 86400000).toISOString(), status, 'citation-test']
  );
  if (!result.success) throw new Error(JSON.stringify(result.error));
  expect(materializeRecordLinks(client, 'decision', id).success).toBe(true);
}
async function search(query: string, options: Record<string, unknown> = {}) {
  return (
    await captureToolCall('read', () =>
      new HybridRetriever(client, {
        embedder: async () => {
          throw new Error('deliberate keyword-only test');
        },
      }).search(query, { types: ['decision'], limit: 5, ...options })
    )
  ).value;
}

it('rescues a bare-unique neighbor only when citation recall is opted in', async () => {
  decision(501, 'Historical copper material choice.', 30);
  decision(502, 'Alchemy protocol follows #501.', 1);
  expect((await search('alchemy protocol')).map((row) => row.id)).toEqual([502]);
  const recalled = await search('alchemy protocol', { citationRecall: true });
  expect(recalled.map((row) => row.id)).toEqual([502, 501]);
  expect(recalled[1].bm25Score).toBe(0);
  expect(recalled[0].graphNeighbors).toEqual([
    { id: 501, text: 'Historical copper material choice.' },
  ]);
});

it('follows the authoritative superseder rather than retaining an obsolete textual endpoint', async () => {
  decision(501, 'Old material.', 30, 'superseded');
  decision(503, 'Replacement material.', 20);
  expect(
    client.execute('UPDATE strategic_decisions SET superseded_by=503 WHERE id=501').success
  ).toBe(true);
  decision(502, 'Alchemy protocol uses decision #501.', 1);
  expect((await search('alchemy protocol', { citationRecall: true })).map((row) => row.id)).toEqual(
    [502, 503]
  );
  expect(
    client.execute('UPDATE strategic_decisions SET superseded_by=NULL WHERE id=501').success
  ).toBe(true);
  expect((await search('alchemy protocol', { citationRecall: true })).map((row) => row.id)).toEqual(
    [502]
  );
});

it('scores actual mission overlap on rich fields while keeping the headline preview', async () => {
  decision(501, 'Choose copper.', 10, 'active', 'Alchemy protocol requires stable conductors.');
  const rows = (
    await captureToolCall('read', () => findRelevantDecisions(client, 'alchemy protocol'))
  ).value;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: 501, decisionText: 'Choose copper.', relevanceScore: 2 });
});

it('applies the learning prior only when both record types are requested', async () => {
  decision(501, 'Alchemy protocol.', 1);
  expect(
    client.execute('INSERT INTO learnings(id,content,created_at,project_id) VALUES(?,?,?,?)', [
      601,
      'Alchemy protocol.',
      new Date(now - 86400000).toISOString(),
      'citation-test',
    ]).success
  ).toBe(true);
  const single = await search('alchemy protocol', { types: ['learning'], learningPrior: 0.5 });
  const mixed = await search('alchemy protocol', {
    types: ['decision', 'learning'],
    learningPrior: 0.5,
  });
  expect(mixed.find((row) => row.type === 'learning')?.score).toBeCloseTo(single[0].score * 0.5);
  expect(mixed[0].type).toBe('decision');
});

it('reports a broken existing citation table while keeping the direct keyword result', async () => {
  decision(501, 'Alchemy protocol.', 1);
  expect(
    client.raw('DROP TABLE record_links; CREATE TABLE record_links(broken TEXT)').success
  ).toBe(true);
  const warning = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await captureToolCall('read', () =>
      new HybridRetriever(client, {
        embedder: async () => {
          throw new Error('deliberate keyword-only test');
        },
      }).search('alchemy protocol', { citationRecall: true } as any)
    );
    expect(result.value.map((row) => row.id)).toEqual([501]);
    expect(result.storeUpkeepNotes.join(' ')).toContain('RECORD_LINKS_READ_FAILED');
  } finally {
    warning.mockRestore();
  }
});

it('uses stored bare edges in first-prompt recall without creating a database write', () => {
  decision(501, 'Historical protocol material.', 30);
  decision(502, 'Alchemy protocol follows #501.', 1);
  const readonly = new Database(dbPath, { readonly: true });
  try {
    const before = readonly.serialize();
    const result = recallFirstPrompt(dbPath, 'alchemy', { minimumKeywordMatches: 0 });
    expect(result.items.find((row) => row.id === 501)?.retrievalSource).toBe('citation');
    expect(readonly.serialize()).toEqual(before);
  } finally {
    readonly.close();
  }
});

it('activates citation recall through both actual search handlers', async () => {
  decision(501, 'Historical copper material choice.', 30);
  decision(502, 'Alchemy protocol follows #501.', 1);
  const context = (
    await captureToolCall('read', () =>
      cmosContextSearch({ query: 'alchemy protocol', projectRoot: root })
    )
  ).value;
  const decisions = (
    await captureToolCall('read', () =>
      cmosDecisionsSearch({ query: 'alchemy protocol', projectRoot: root })
    )
  ).value;
  expect(context.success).toBe(true);
  expect(decisions.success).toBe(true);
  expect(context.data?.results.map((row) => row.id)).toEqual([502, 501]);
  expect(decisions.data?.results.map((row) => row.id)).toEqual([502, 501]);
});
