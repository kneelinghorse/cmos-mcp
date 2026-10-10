// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m07 retrieval R1 + R2: recall surfaces drop only superseded rows, inside the candidate
// ABOUTME: query so a page is never short, and the keyword arm reads every query keyword up to 64.

/**
 * Grounding (cmos/research/2026-10-strategy/retrieval-natural-labels.md): 46% of the rows later
 * records cite were no longer active when cited, and the active-only filter ran AFTER both arms had
 * filled their candidate pools, so 26-33% of searches came back short. The keyword arm read only
 * the first 10 distinct query words. Each test below fails on the pre-m07 retriever.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { EMBEDDING_DIM, type Embedder } from '../../../src/intelligence/embedding-pipeline';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { cmosContext } from '../../../src/tools/cmos/cmos-context';
import {
  formatContextSearchForLLM,
  type ContextSearchResult,
} from '../../../src/tools/cmos/cmos-context-search';
import {
  cmosMissionTransition,
  formatMissionTransitionForLLM,
} from '../../../src/tools/cmos/cmos-mission-transition';
import {
  DEFAULT_RRF_K,
  FTS_MAX_KEYWORDS,
  HybridRetriever,
  VECTOR_RRF_WEIGHT,
} from '../../../src/tools/cmos/fts5-retriever';
import {
  ensureDecisionsFts5,
  ensureVectorStorage,
} from '../../../src/tools/cmos/schema-migrations';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

let projectRoot: string;
let dbPath: string;
let client: CmosDatabaseClient;

beforeEach(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s92m07-recall-'));
  dbPath = seedCmosDb(projectRoot, { projectName: 's92-m07 recall' });
  reidentifyCmosTestStore(projectRoot);
  const opened = await CmosDatabaseClient.create({ dbPath });
  if (!opened.success || !opened.data) throw new Error('open failed');
  client = opened.data;
  // Create the FTS and vector tables before any row exists, so the insert triggers index them.
  ensureDecisionsFts5(client);
  ensureVectorStorage(client);
});

afterEach(() => {
  client.close();
  CmosDetector.resetInstance();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const now = (): string => new Date().toISOString();

function decision(text: string, status = 'active'): number {
  const inserted = client.execute(
    `INSERT INTO strategic_decisions (decision_text, created_at, status) VALUES (?, ?, ?)`,
    [text, now(), status]
  );
  return Number(inserted.data?.lastInsertRowid);
}

/** A vector pointing along one axis; the mock embedder maps the query to axis 0. */
function axis(index: number, weight = 1): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[index] = weight;
  return v;
}

function storeVector(id: number, vec: Float32Array): void {
  client.execute(`INSERT INTO decisions_vec(decision_id, embedding) VALUES (?, ?)`, [
    BigInt(id),
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
  ]);
}

const noEmbedder: Embedder = async () => {
  throw new Error('no embedder in this test');
};

describe('R2: the keyword arm reads every query keyword, up to the cap', () => {
  const filler = (n: number, prefix: string): string =>
    Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + (i % 26))}${i}`).join(
      ' '
    );

  it('finds a row whose only matching word is the 12th distinct keyword of the query', async () => {
    const target = decision('Quarantine the flaky ingestion worker behind a feature switch.');
    decision('An unrelated decision about release notes.');
    // Eleven distinct keywords no row contains, then the one word the target holds.
    const query = `${filler(11, 'zzq')} quarantine`;

    const results = await new HybridRetriever(client, { embedder: noEmbedder }).search(query, {
      types: ['decision'],
    });
    expect(results.map((r) => r.id)).toContain(target);
  });

  it(`stops at ${FTS_MAX_KEYWORDS} keywords`, async () => {
    expect(FTS_MAX_KEYWORDS).toBe(64);
    const inside = decision('Rotate the signing keys every ninety days, inside the cap.');
    const outside = decision('Archive the telemetry buckets nightly, beyond the cap.');
    // 63 unmatched keywords, then "rotate" (64th), then 10 more, then "telemetry" (75th).
    const query = `${filler(63, 'qqz')} rotate ${filler(10, 'xxv')} telemetry`;

    const ids = (
      await new HybridRetriever(client, { embedder: noEmbedder }).search(query, {
        types: ['decision'],
      })
    ).map((r) => r.id);
    expect(ids).toContain(inside);
    expect(ids).not.toContain(outside);
  });
});

describe('R1: recall drops only superseded rows, before the candidate pool is cut', () => {
  it('returns archived and stale rows with their status, never a superseded one', async () => {
    const active = decision('Cache the manifest digest between builds.');
    const archived = decision('Cache the manifest digest in the release job.', 'archived');
    const stale = decision('Cache the manifest digest on the build host.', 'stale');
    const superseded = decision('Cache the manifest digest in memory only.', 'superseded');

    const results = await new HybridRetriever(client, { embedder: noEmbedder }).search(
      'cache manifest digest',
      { types: ['decision'], limit: 10 }
    );
    const byId = new Map(results.map((r) => [r.id, r.status]));
    expect(byId.get(active)).toBe('active');
    expect(byId.get(archived)).toBe('archived');
    expect(byId.get(stale)).toBe('stale');
    expect(byId.has(superseded)).toBe(false);
  });

  it('keeps an explicit statusFilter as an include list, and [] as no filter at all', async () => {
    const active = decision('Pin the toolchain version in the lockfile.');
    const archived = decision('Pin the toolchain version per workspace.', 'archived');
    const superseded = decision('Pin the toolchain version globally.', 'superseded');
    const retriever = new HybridRetriever(client, { embedder: noEmbedder });

    const activeOnly = await retriever.search('pin toolchain version', {
      types: ['decision'],
      statusFilter: ['active'],
    });
    expect(activeOnly.map((r) => r.id)).toEqual([active]);

    const everything = await retriever.search('pin toolchain version', {
      types: ['decision'],
      statusFilter: [],
    });
    expect(everything.map((r) => r.id).sort()).toEqual([active, archived, superseded].sort());
  });

  it('fills the page when superseded rows dominate the keyword ranking', async () => {
    // Thirty superseded rows that match every query word, ahead of five eligible rows matching one.
    for (let i = 0; i < 30; i += 1) {
      decision(`Shard the ledger index by tenant and region, revision ${i}.`, 'superseded');
    }
    const eligible = Array.from({ length: 5 }, (_, i) =>
      decision(`Shard the archive bucket, variant ${i}.`, i % 2 === 0 ? 'active' : 'archived')
    );

    const results = await new HybridRetriever(client, { embedder: noEmbedder }).search(
      'shard ledger index tenant region',
      { types: ['decision'], limit: 5 }
    );
    // Pre-m07: the 25-row pool held only superseded rows, the post-filter emptied it, and the
    // search returned nothing.
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.id).sort()).toEqual([...eligible].sort());
  });

  it('widens the vector arm until it has a full eligible pool', async () => {
    // The 30 nearest vectors belong to superseded rows; the five eligible rows are further away.
    for (let i = 0; i < 30; i += 1) {
      storeVector(decision(`Superseded neighbour ${i}`, 'superseded'), axis(0));
    }
    const eligible = Array.from({ length: 5 }, (_, i) => {
      const id = decision(`Eligible neighbour ${i}`);
      const v = axis(0, 0.6);
      v[1 + i] = 0.8;
      storeVector(id, v);
      return id;
    });

    const results = await new HybridRetriever(client, {
      backend: 'vector',
      embedder: async () => axis(0),
    }).search('anything', { types: ['decision'], limit: 5 });
    expect(results.map((r) => r.id).sort()).toEqual([...eligible].sort());
  });
});

describe('the vector term is weighted at most 0.25 in the fusion', () => {
  it('a vector-only rank-1 hit scores a quarter of a keyword-only rank-1 hit', async () => {
    expect(VECTOR_RRF_WEIGHT).toBeLessThanOrEqual(0.25);
    const keywordHit = decision('Throttle the export queue during backfills.');
    const vectorHit = decision('Nothing in common with the query words.');
    storeVector(vectorHit, axis(0));

    const results = await new HybridRetriever(client, {
      embedder: async () => axis(0),
    }).search('throttle export queue', { types: ['decision'], recencyWeight: 0 });
    const rrf = new Map(results.map((r) => [r.id, r.rrfScore]));
    expect(rrf.get(keywordHit)).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 10);
    expect(rrf.get(vectorHit)).toBeCloseTo(VECTOR_RRF_WEIGHT / (DEFAULT_RRF_K + 1), 10);
  });
});

describe('R1 on the published surfaces', () => {
  it('cmos_context search returns archived rows by default and says which statuses it left out', async () => {
    const archived = decision(
      'Retire the nightly vacuum job once WAL checkpoints run.',
      'archived'
    );
    decision('Retire the nightly vacuum job immediately.', 'superseded');
    client.close();

    const result = await cmosContext({
      action: 'search',
      query: 'retire nightly vacuum',
      projectRoot,
    });
    expect(result.success).toBe(true);
    const data = result.data as ContextSearchResult;
    expect(data.results.map((r) => r.id)).toEqual([archived]);
    expect(data.options).toMatchObject({ statusFilter: [], excludedStatuses: ['superseded'] });
    expect(formatContextSearchForLLM(result as never)).toContain(`decision #${archived}, archived`);

    const activeOnly = await cmosContext({
      action: 'search',
      query: 'retire nightly vacuum',
      statusFilter: ['active'],
      projectRoot,
    });
    expect((activeOnly.data as ContextSearchResult).results).toEqual([]);
    expect((activeOnly.data as ContextSearchResult).options).toMatchObject({
      statusFilter: ['active'],
      excludedStatuses: [],
    });
    // Reopen for afterEach.
    const reopened = await CmosDatabaseClient.create({ dbPath });
    client = reopened.data!;
  });

  it('mission start surfaces an archived decision and shows its status', async () => {
    const archived = decision(
      'Partition the audit ledger by month so compaction stays bounded.',
      'archived'
    );
    decision('Partition the audit ledger by week.', 'superseded');
    client.close();
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO sprints (id, title, status, start_date) VALUES ('sprint-r1', 'R1', 'Active', ?)`
      ).run(now());
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, objective) VALUES ('r1-m01', 'sprint-r1', 'Ledger', 'Queued', ?)`
      ).run('Partition the audit ledger so monthly compaction stays bounded.');
    } finally {
      db.close();
    }

    const started = await cmosMissionTransition({
      action: 'start',
      missionId: 'r1-m01',
      projectRoot,
    });
    expect(started.success).toBe(true);
    const relevant = (started.data as { relevantDecisions?: Array<{ id: number; status: string }> })
      .relevantDecisions;
    expect(relevant?.map((d) => [d.id, d.status])).toEqual([[archived, 'archived']]);
    expect(formatMissionTransitionForLLM('start', started)).toContain(`#${archived}, archived`);
    const reopened = await CmosDatabaseClient.create({ dbPath });
    client = reopened.data!;
  });
});

describe('spin-out vector pools', () => {
  it.each([undefined, []])(
    'widens past hidden rows even with status filter %p',
    async (statusFilter) => {
      for (let i = 0; i < 30; i++) {
        const id = decision(`Nearest transferred source ${i}`, 'archived');
        storeVector(id, axis(0));
        client.execute('INSERT INTO metadata(key,value) VALUES(?,?)', [
          `spin_out_row:decision:${id}`,
          JSON.stringify({
            operationId: 'fork',
            sourceProjectId: 'source',
            sourceRoot: '/source',
            sourceId: id,
            targetProjectId: 'target',
            targetRoot: '/target',
            targetId: id,
          }),
        ]);
      }
      const id = decision('Visible semantic result');
      storeVector(id, axis(1));
      const retriever = new HybridRetriever(client, {
        embedder: async () => axis(0),
        backend: 'vector',
      });
      const result = await retriever.search('semantic query', {
        types: ['decision'],
        limit: 1,
        statusFilter,
      });
      expect(result.map((row) => row.id)).toEqual([id]);
    }
  );
});
