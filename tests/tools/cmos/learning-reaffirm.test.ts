// ABOUTME: Sprint 61 m01 — auto-reaffirm learnings on cite. Verifies explicit
// citesLearningIds path, implicit FTS5/keyword-overlap path, sanitizer wiring,
// and the regression guard against over-bumping below the keyword floor.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  applyLearningReaffirm,
  detectImplicitLearningCites,
  reaffirmLearningsByIds,
  sanitizeLearningIds,
  IMPLICIT_REAFFIRM_KEYWORD_FLOOR,
} from '../../../src/tools/cmos/learning-reaffirm';
import { ensureReviewTimestamps } from '../../../src/tools/cmos/schema-migrations';
import { cmosSessionCapture } from '../../../src/tools/cmos/cmos-session-capture';
import { cmosSessionComplete } from '../../../src/tools/cmos/cmos-session-complete';

function makeTempDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-learning-reaffirm-test-'));
  const cmosDbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDbDir, { recursive: true });
  const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      sprint_id TEXT REFERENCES sprints(id),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      agent TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      summary TEXT,
      captures TEXT DEFAULT '[]',
      next_steps TEXT,
      metadata TEXT
    );

    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent TEXT,
      mission TEXT,
      action TEXT NOT NULL,
      status TEXT,
      summary TEXT,
      next_hint TEXT,
      raw_event TEXT
    );

    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sprint_id TEXT,
      project_domain TEXT,
      session_id TEXT,
      mission_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      evidence TEXT,
      superseded_by INTEGER
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      sprint_id TEXT,
      session_id TEXT,
      mission_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      sprint_id TEXT REFERENCES sprints(id),
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      completed_at TEXT,
      notes TEXT,
      objective TEXT
    );

    CREATE TABLE contexts (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_id TEXT NOT NULL,
      session_id TEXT,
      source TEXT,
      content_hash TEXT,
      content TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);

    INSERT INTO sprints (id, title, status) VALUES ('sprint-61', 'Sprint 61', 'Active');
    INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
    VALUES ('PS-2026-05-07-100', 'planning', 'Test', 'sprint-61', '2026-05-07T00:00:00Z', 'active', '[]');
    INSERT INTO metadata (key, value) VALUES ('project_domain', 'cmos-mcp');
  `);
  db.close();

  return { tempDir, dbPath };
}

async function openClient(dbPath: string): Promise<CmosDatabaseClient> {
  const r = await CmosDatabaseClient.create({ dbPath });
  if (!r.success || !r.data) throw new Error('open failed');
  return r.data;
}

function cleanup(tempDir: string, client?: CmosDatabaseClient): void {
  if (client) client.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function seedLearning(
  dbPath: string,
  content: string,
  status: string = 'active',
  sprintId: string = 'sprint-61'
): number {
  const db = new Database(dbPath);
  try {
    const result = db
      .prepare(`INSERT INTO learnings (content, status, sprint_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(content, status, sprintId, '2026-01-01T00:00:00Z');
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

function readLastReviewedAt(dbPath: string, learningId: number): string | null {
  const db = new Database(dbPath);
  try {
    const cols = db.pragma('table_info(learnings)') as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'last_reviewed_at')) {
      // Migration hasn't fired — equivalent to "never reviewed".
      return null;
    }
    const row = db
      .prepare(`SELECT last_reviewed_at FROM learnings WHERE id = ?`)
      .get(learningId) as { last_reviewed_at: string | null } | undefined;
    return row?.last_reviewed_at ?? null;
  } finally {
    db.close();
  }
}

describe('IMPLICIT_REAFFIRM_KEYWORD_FLOOR', () => {
  it('is exported as a stable named constant set to 15', () => {
    // Floor calibrated against supersession-detection MIN_KEYWORDS_FOR_SEARCH=2 noise floor.
    expect(IMPLICIT_REAFFIRM_KEYWORD_FLOOR).toBe(15);
  });
});

describe('sanitizeLearningIds', () => {
  it('drops non-integers and reports them per index', () => {
    const result = sanitizeLearningIds('citesLearningIds', [
      1,
      2,
      'bad',
      null,
      3.5,
      -1,
      0,
      4,
    ] as unknown[]);
    expect(result.cleaned).toEqual([1, 2, 4]);
    const fieldNames = result.sanitizedFields.map((f) => f.field);
    expect(fieldNames).toEqual([
      'citesLearningIds[2]',
      'citesLearningIds[3]',
      'citesLearningIds[4]',
      'citesLearningIds[5]',
      'citesLearningIds[6]',
    ]);
  });

  it('returns empty when input is undefined', () => {
    const result = sanitizeLearningIds('citesLearningIds', undefined);
    expect(result.cleaned).toEqual([]);
    expect(result.sanitizedFields).toEqual([]);
  });

  it('dedupes repeated valid IDs', () => {
    const result = sanitizeLearningIds('citesLearningIds', [3, 1, 3, 1, 2] as unknown[]);
    expect(result.cleaned).toEqual([3, 1, 2]);
    expect(result.sanitizedFields).toEqual([]);
  });
});

describe('reaffirmLearningsByIds', () => {
  it('bumps last_reviewed_at on existing rows and reports missing IDs', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const id1 = seedLearning(dbPath, 'First learning');
      const id2 = seedLearning(dbPath, 'Second learning');
      ensureReviewTimestamps(client);

      const now = '2026-05-07T12:34:56Z';
      const outcome = reaffirmLearningsByIds(client, [id1, id2, 999], now);

      expect(outcome.reaffirmedIds.sort()).toEqual([id1, id2].sort());
      expect(outcome.missingIds).toEqual([999]);
      expect(readLastReviewedAt(dbPath, id1)).toBe(now);
      expect(readLastReviewedAt(dbPath, id2)).toBe(now);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('is a no-op for an empty ID list', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const outcome = reaffirmLearningsByIds(client, [], '2026-05-07T00:00:00Z');
      expect(outcome.reaffirmedIds).toEqual([]);
      expect(outcome.missingIds).toEqual([]);
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('detectImplicitLearningCites', () => {
  // The floor is 15 keywords. Stop-word filtering happens in extractKeywords —
  // these strings are deliberately verbose to exceed the floor cleanly.
  const HIGH_OVERLAP_LEARNING =
    'cursor-based pagination must always advance forwards with monotonic offset preventing duplicate row emission and skipped batch boundaries during streaming response handling for downstream consumers';

  it('returns matching learning IDs when overlap meets the floor', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const matchId = seedLearning(dbPath, HIGH_OVERLAP_LEARNING);
      seedLearning(dbPath, 'Completely unrelated note about brand voice copywriting');

      const matched = await detectImplicitLearningCites(client, HIGH_OVERLAP_LEARNING);
      expect(matched).toContain(matchId);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('returns empty when the new content has fewer than the floor in keywords', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      seedLearning(dbPath, HIGH_OVERLAP_LEARNING);
      // Short content — well under 15 unique non-stop-word keywords.
      const matched = await detectImplicitLearningCites(client, 'cursor pagination advance');
      expect(matched).toEqual([]);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('does NOT match learnings whose overlap is below the floor (regression guard)', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const lowOverlapId = seedLearning(
        dbPath,
        'Brand color palette uses Court Classic Navy and Vintage Blue for header accents'
      );

      // Content has 15+ keywords but shares only ~2 with the seeded learning.
      const matched = await detectImplicitLearningCites(client, HIGH_OVERLAP_LEARNING);
      expect(matched).not.toContain(lowOverlapId);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('skips learnings whose status is not active', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const archivedId = seedLearning(dbPath, HIGH_OVERLAP_LEARNING, 'archived');
      const matched = await detectImplicitLearningCites(client, HIGH_OVERLAP_LEARNING);
      expect(matched).not.toContain(archivedId);
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('applyLearningReaffirm — explicit + implicit pipeline', () => {
  const HIGH_OVERLAP_LEARNING =
    'cursor-based pagination must always advance forwards with monotonic offset preventing duplicate row emission and skipped batch boundaries during streaming response handling for downstream consumers';

  it('combines explicit IDs and implicit overlap matches without double-bumping', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const explicitId = seedLearning(dbPath, 'Unrelated explicit learning');
      const implicitId = seedLearning(dbPath, HIGH_OVERLAP_LEARNING);

      const outcome = await applyLearningReaffirm(client, {
        explicitIds: [explicitId],
        newContent: HIGH_OVERLAP_LEARNING,
        reaffirmedAt: '2026-05-07T01:00:00Z',
      });
      expect(outcome.explicitlyReaffirmedIds).toEqual([explicitId]);
      expect(outcome.implicitlyReaffirmedIds).toEqual([implicitId]);
      expect(outcome.missingIds).toEqual([]);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('does not implicitly bump excluded IDs (e.g. the freshly-inserted learning)', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const selfId = seedLearning(dbPath, HIGH_OVERLAP_LEARNING);

      const outcome = await applyLearningReaffirm(client, {
        explicitIds: [],
        newContent: HIGH_OVERLAP_LEARNING,
        reaffirmedAt: '2026-05-07T01:00:00Z',
        excludeIds: [selfId],
      });
      expect(outcome.implicitlyReaffirmedIds).toEqual([]);
      expect(readLastReviewedAt(dbPath, selfId)).toBeNull();
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('cmos_session_capture wiring — citesLearningIds and implicit reaffirm', () => {
  const HIGH_OVERLAP_LEARNING =
    'cursor-based pagination must always advance forwards with monotonic offset preventing duplicate row emission and skipped batch boundaries during streaming response handling for downstream consumers';

  it('explicitly reaffirms learnings cited via citesLearningIds (decision capture)', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const id1 = seedLearning(dbPath, 'Lock files for API tests');
      const id2 = seedLearning(dbPath, 'Always seed metadata table in fixtures');

      const result = await cmosSessionCapture({
        sessionId: 'PS-2026-05-07-100',
        category: 'decision',
        content: 'Use TypeScript for all new tools',
        citesLearningIds: [id1, id2],
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.explicitlyReaffirmedLearningIds?.sort()).toEqual([id1, id2].sort());
      expect(readLastReviewedAt(dbPath, id1)).not.toBeNull();
      expect(readLastReviewedAt(dbPath, id2)).not.toBeNull();
    } finally {
      cleanup(tempDir);
    }
  });

  it('implicitly reaffirms learnings whose content overlaps the new capture (decision capture)', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const matchId = seedLearning(dbPath, HIGH_OVERLAP_LEARNING);
      const unrelatedId = seedLearning(dbPath, 'Brand voice document drafted');

      const result = await cmosSessionCapture({
        sessionId: 'PS-2026-05-07-100',
        category: 'decision',
        content: HIGH_OVERLAP_LEARNING,
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.implicitlyReaffirmedLearningIds).toContain(matchId);
      expect(result.data?.implicitlyReaffirmedLearningIds ?? []).not.toContain(unrelatedId);
      expect(readLastReviewedAt(dbPath, matchId)).not.toBeNull();
      expect(readLastReviewedAt(dbPath, unrelatedId)).toBeNull();
    } finally {
      cleanup(tempDir);
    }
  });

  it('does NOT reaffirm anything when overlap is below the floor (regression guard)', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const id1 = seedLearning(dbPath, HIGH_OVERLAP_LEARNING);

      const result = await cmosSessionCapture({
        sessionId: 'PS-2026-05-07-100',
        category: 'decision',
        // Short content — fewer than 15 keywords post-stop-word filter.
        content: 'Use TypeScript for all new tools',
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.implicitlyReaffirmedLearningIds).toBeUndefined();
      expect(readLastReviewedAt(dbPath, id1)).toBeNull();
    } finally {
      cleanup(tempDir);
    }
  });

  it('does not implicitly reaffirm the freshly-inserted learning itself', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const result = await cmosSessionCapture({
        sessionId: 'PS-2026-05-07-100',
        category: 'learning',
        content: HIGH_OVERLAP_LEARNING,
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      // The learning we just inserted should not appear in the implicit list.
      expect(result.data?.implicitlyReaffirmedLearningIds ?? []).toEqual([]);
    } finally {
      cleanup(tempDir);
    }
  });

  it('surfaces sanitizedFields for non-integer entries in citesLearningIds', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const validId = seedLearning(dbPath, 'Valid learning');

      const result = await cmosSessionCapture({
        sessionId: 'PS-2026-05-07-100',
        category: 'decision',
        content: 'Use TypeScript for all new tools',
        citesLearningIds: [validId, 'oops' as unknown as number, -1, 3.14],
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      const fieldNames = (result.sanitizedFields ?? []).map((f) => f.field);
      expect(fieldNames).toEqual([
        'citesLearningIds[1]',
        'citesLearningIds[2]',
        'citesLearningIds[3]',
      ]);
      expect(result.data?.explicitlyReaffirmedLearningIds).toEqual([validId]);
      expect(readLastReviewedAt(dbPath, validId)).not.toBeNull();
    } finally {
      cleanup(tempDir);
    }
  });

  it('surfaces missingCitedLearningIds when a cited ID does not exist', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const validId = seedLearning(dbPath, 'Valid learning');

      const result = await cmosSessionCapture({
        sessionId: 'PS-2026-05-07-100',
        category: 'decision',
        content: 'Pick a default model and warn on override',
        citesLearningIds: [validId, 9999],
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.missingCitedLearningIds).toEqual([9999]);
      expect(result.data?.explicitlyReaffirmedLearningIds).toEqual([validId]);
    } finally {
      cleanup(tempDir);
    }
  });
});

describe('cmos_session_complete wiring — citesLearningIds and implicit reaffirm', () => {
  const HIGH_OVERLAP_LEARNING =
    'cursor-based pagination must always advance forwards with monotonic offset preventing duplicate row emission and skipped batch boundaries during streaming response handling for downstream consumers';

  it('reaffirms explicit IDs and implicitly-overlapping learnings on complete', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const explicitId = seedLearning(dbPath, 'Unrelated explicit cite');
      const implicitId = seedLearning(dbPath, HIGH_OVERLAP_LEARNING);

      const result = await cmosSessionComplete({
        sessionId: 'PS-2026-05-07-100',
        summary: 'Sprint 61 m01 done',
        decisions: [HIGH_OVERLAP_LEARNING],
        citesLearningIds: [explicitId],
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.explicitlyReaffirmedLearningIds).toEqual([explicitId]);
      expect(result.data?.implicitlyReaffirmedLearningIds).toContain(implicitId);
    } finally {
      cleanup(tempDir);
    }
  });

  it('surfaces sanitizedFields for non-integer entries in citesLearningIds at complete time', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const validId = seedLearning(dbPath, 'Valid learning');

      const result = await cmosSessionComplete({
        sessionId: 'PS-2026-05-07-100',
        summary: 'Closeout',
        decisions: ['A short decision'],
        citesLearningIds: [validId, 'oops' as unknown as number],
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      const fieldNames = (result.sanitizedFields ?? []).map((f) => f.field);
      expect(fieldNames).toContain('citesLearningIds[1]');
      expect(result.data?.explicitlyReaffirmedLearningIds).toEqual([validId]);
    } finally {
      cleanup(tempDir);
    }
  });
});
