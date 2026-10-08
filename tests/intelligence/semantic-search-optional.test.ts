// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m07 — the embedding stack is an optional peer dependency. Without it, writes and
// ABOUTME: searches run keyword-only and say nothing; health reports semantic search on or off.

/**
 * The branch, measured on 2,132 natural citation labels in four stores
 * (cmos/research/2026-10-strategy/retrieval-natural-labels.md §4.9): once the keyword arm reads
 * every query keyword, keyword-only recall@10 is 0.637 against hybrid's 0.592. The stack it would
 * pull in is about 81% of a 306 MB install. So a missing package is a supported configuration, not a
 * failure, and must not print a warning per write or per search.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  __resetEmbedderCacheForTesting,
  getEmbedder,
  recordEmbedding,
  semanticSearchStatus,
  setTransformersLoaderForTesting,
  setTransformersResolverForTesting,
} from '../../src/intelligence/embedding-pipeline';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { CmosDatabaseClient } from '../../src/tools/cmos/client';
import { cmosDb, formatDbForLLM } from '../../src/tools/cmos/cmos-db';
import type { CmosDbHealthResult } from '../../src/tools/cmos/cmos-db-health';
import { HybridRetriever } from '../../src/tools/cmos/fts5-retriever';
import { ensureDecisionsFts5, ensureVectorStorage } from '../../src/tools/cmos/schema-migrations';
import { reidentifyCmosTestStore, seedCmosDb } from '../helpers/seedCmosDb';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** What Node throws for `import('@xenova/transformers')` when the package is absent. */
function notInstalled(): Promise<never> {
  return Promise.reject(
    Object.assign(
      new Error(`Cannot find package '@xenova/transformers' imported from ${REPO_ROOT}/dist`),
      { code: 'ERR_MODULE_NOT_FOUND' }
    )
  );
}

let projectRoot: string;
let dbPath: string;
let errorSpy: jest.SpiedFunction<typeof console.error>;
let warnSpy: jest.SpiedFunction<typeof console.warn>;

beforeEach(() => {
  __resetEmbedderCacheForTesting();
  setTransformersLoaderForTesting(notInstalled);
  setTransformersResolverForTesting(() => false);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s92m07-semantic-'));
  dbPath = seedCmosDb(projectRoot, { projectName: 's92-m07 semantic' });
  reidentifyCmosTestStore(projectRoot);
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  setTransformersLoaderForTesting(null);
  setTransformersResolverForTesting(null);
  __resetEmbedderCacheForTesting();
  CmosDetector.resetInstance();
  fs.rmSync(projectRoot, { recursive: true, force: true });
  delete process.env.CMOS_DEBUG;
});

const stderrLines = (): string[] => errorSpy.mock.calls.map((call) => String(call[0]));

async function openClient(): Promise<CmosDatabaseClient> {
  const opened = await CmosDatabaseClient.create({ dbPath });
  if (!opened.success || !opened.data) throw new Error('open failed');
  return opened.data;
}

describe('s92-m07 — the package manifest', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it('makes @xenova/transformers an optional peer, kept installed in the repo as a dev dependency', () => {
    expect(pkg.dependencies).not.toHaveProperty('@xenova/transformers');
    expect(pkg.peerDependencies?.['@xenova/transformers']).toBeDefined();
    expect(pkg.peerDependenciesMeta?.['@xenova/transformers']).toEqual({ optional: true });
    expect(pkg.devDependencies).toHaveProperty('@xenova/transformers');
  });

  it('no longer depends on fast-xml-parser, which nothing imports', () => {
    expect(pkg.dependencies).not.toHaveProperty('fast-xml-parser');
    expect(pkg.devDependencies ?? {}).not.toHaveProperty('fast-xml-parser');
  });
});

describe('s92-m07 — without the package, semantic search is off and silent', () => {
  it('reports off before and after a load attempt, and the attempt prints nothing', async () => {
    expect(semanticSearchStatus()).toMatchObject({ enabled: false, state: 'not-installed' });
    await getEmbedder();
    expect(semanticSearchStatus()).toMatchObject({ enabled: false, state: 'not-installed' });
    expect(semanticSearchStatus().detail).toContain('@xenova/transformers');
    expect(stderrLines()).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a write records no embedding, quietly', async () => {
    const client = await openClient();
    try {
      ensureVectorStorage(client);
      const inserted = client.execute(
        `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Keep it local', ?)`,
        [new Date().toISOString()]
      );
      const id = Number(inserted.data?.lastInsertRowid);
      for (let i = 0; i < 3; i += 1) {
        const result = await recordEmbedding(client, {
          type: 'decision',
          id,
          inputText: 'Keep it local',
        });
        expect(result).toEqual({ action: 'skipped-unavailable' });
      }
      expect(stderrLines()).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('a search runs keyword-only, quietly', async () => {
    const client = await openClient();
    try {
      ensureDecisionsFts5(client);
      ensureVectorStorage(client);
      const inserted = client.execute(
        `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
        ['Ship the keyword arm on its own', new Date().toISOString()]
      );
      const id = Number(inserted.data?.lastInsertRowid);
      const results = await new HybridRetriever(client).search('keyword arm', {
        types: ['decision'],
      });
      expect(results.map((r) => r.id)).toEqual([id]);
      expect(results[0].vectorSimilarity).toBeNull();
      expect(stderrLines()).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('health says semantic search is off and why', async () => {
    const health = await cmosDb({ action: 'health', projectRoot });
    expect(health.success).toBe(true);
    expect((health.data as CmosDbHealthResult).semanticSearch).toMatchObject({
      enabled: false,
      state: 'not-installed',
    });
    expect(formatDbForLLM('health', health as never)).toMatch(
      /\*\*Semantic search\*\*: off .*@xenova\/transformers/
    );
  });

  it('recognises the CommonJS form too (the compiled dist loads it with require)', async () => {
    setTransformersLoaderForTesting(() =>
      Promise.reject(
        Object.assign(new Error("Cannot find module '@xenova/transformers'\nRequire stack:\n- x"), {
          code: 'MODULE_NOT_FOUND',
        })
      )
    );
    await getEmbedder();
    expect(semanticSearchStatus().state).toBe('not-installed');
    expect(stderrLines()).toEqual([]);
  });

  it('with CMOS_DEBUG=1 the missing package is named on stderr once', async () => {
    process.env.CMOS_DEBUG = '1';
    await getEmbedder();
    await getEmbedder();
    expect(stderrLines().filter((line) => line.includes('@xenova/transformers'))).toHaveLength(1);
  });
});

describe('s92-m07 — POSITIVE CONTROLS: an installed package is on, and a broken one still warns', () => {
  it('installed but not yet loaded reads as on, and checking does not load it', async () => {
    const loader = jest.fn(notInstalled);
    setTransformersLoaderForTesting(loader);
    setTransformersResolverForTesting(() => true);
    expect(semanticSearchStatus()).toMatchObject({ enabled: true, state: 'installed' });
    const health = await cmosDb({ action: 'health', projectRoot });
    expect((health.data as CmosDbHealthResult).semanticSearch.enabled).toBe(true);
    expect(loader).not.toHaveBeenCalled();
  });

  it('a package whose own dependency is missing counts as a failed load, not an absent one', async () => {
    setTransformersResolverForTesting(() => true);
    setTransformersLoaderForTesting(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "Cannot find module 'onnxruntime-node'\nRequire stack:\n- node_modules/@xenova/transformers/src/backends/onnx.js"
          ),
          { code: 'MODULE_NOT_FOUND' }
        )
      )
    );
    await getEmbedder();
    expect(semanticSearchStatus().state).toBe('failed');
    expect(stderrLines().filter((line) => line.includes('embedder load failed'))).toHaveLength(1);
  });

  it('a package that is installed but fails to load warns once and reads as failed', async () => {
    setTransformersResolverForTesting(() => true);
    setTransformersLoaderForTesting(() =>
      Promise.reject(new SyntaxError("Unexpected token 'export'"))
    );
    await getEmbedder();
    await getEmbedder();
    const warnings = stderrLines().filter((line) => line.includes('embedder load failed'));
    expect(warnings).toHaveLength(1);
    expect(semanticSearchStatus()).toMatchObject({ enabled: false, state: 'failed' });
    expect(semanticSearchStatus().detail).toContain("Unexpected token 'export'");
  });
});
