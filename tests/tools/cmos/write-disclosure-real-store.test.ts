// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m02b REAL-STORE positive fire — a failed decision INSERT must be NAMED in the
// ABOUTME: answer text, on a tmpdir COPY of the live cmos.sqlite, never on a fixture alone.

/**
 * Sprint 86 m02b — the standing gate's real-store half (agents.md Process Hardening #4,
 * decision #926 #3).
 *
 * A SEEDED FIXTURE IS NOT A REAL STORE, and stdio-against-dist proves TRANSPORT, not SCHEMA.
 * The divergence is measured, not hypothetical: `src/tools/cmos/schema.ts` declares SIX foreign
 * keys on `strategic_decisions` while the live store carries THREE — `PRAGMA
 * foreign_key_list(strategic_decisions)` on cmos/db/cmos.sqlite returns exactly
 * snapshot_id -> context_snapshots, sprint_id -> sprints, and context_id -> contexts
 * (ON DELETE CASCADE). So a fixture ENFORCES a mission_id FK the live store does not, and a test
 * that only ever ran against a fixture could be green about the wrong schema.
 *
 * THE REPRODUCTION, and why it fires on the real store specifically:
 * `strategic_decisions.context_id` is `TEXT NOT NULL DEFAULT 'master_context'` with an
 * `ON DELETE CASCADE` FK to `contexts(id)`. The capture INSERT never names `context_id`, so every
 * decision row takes that default. Delete the `master_context` row on a COPY and the FK has
 * nothing to point at: the next decision INSERT fails, and before s86-m02b the handler set
 * `decisionExtractionCount = 0` + `decisionAlreadyExtracted = false` and the formatter announced
 * "**Decision Extraction**: Extraction skipped". Nothing was skipped. A strategic decision was
 * lost and the answer reported an uneventful capture.
 *
 * NEVER AGAINST THE LIVE FILE. Everything below runs on an `mkdtempSync` copy.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  cmosSessionCapture,
  formatSessionCaptureForLLM,
} from '../../../src/tools/cmos/cmos-session-capture';
import { seedCmosDb } from '../../helpers/seedCmosDb';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LIVE_DB = path.join(REPO_ROOT, 'cmos', 'db', 'cmos.sqlite');

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Copy the live store into a temp project root. The live file is never opened for writing. */
function copyLiveStore(): string {
  const projectRoot = mkTmp('cmos-m02b-realstore-');
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  // Copy the main DB plus any WAL/SHM siblings so the copy is not mid-transaction.
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${LIVE_DB}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dbDir, `cmos.sqlite${suffix}`));
  }
  return projectRoot;
}

/**
 * Give the store an active session to capture into.
 *
 * SCHEMA-AWARE ON PURPOSE. The live store's `sessions` carries the s69-m03 firehose genesis
 * columns (`project_id NOT NULL`, `stable_event_id`, `occurred_at`, `origin_seq`, `event_type`
 * with a CHECK, `schema_version`); a freshly-seeded fixture may not have run that migration yet.
 * Stamping them only when they exist keeps ONE helper honest against BOTH stores — which is the
 * whole point of running this reproduction on a real-store copy AND a fixture.
 */
function seedActiveSession(dbPath: string, sessionId: string, sprintId: string | null): void {
  const db = new Database(dbPath);
  try {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    const names = ['id', 'type', 'title', 'sprint_id', 'started_at', 'agent', 'status', 'captures'];
    const values: unknown[] = [
      sessionId,
      'build',
      'm02b real-store fire',
      sprintId,
      new Date().toISOString(),
      'jest',
      'active',
      '[]',
    ];
    if (columns.has('project_id')) {
      const projectId =
        (
          db.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as
            | { value: string }
            | undefined
        )?.value ?? 'test-project';
      names.push(
        'project_id',
        'stable_event_id',
        'occurred_at',
        'origin_seq',
        'event_type',
        'schema_version'
      );
      values.push(
        projectId,
        `TEST${sessionId.replace(/\D/g, '')}`.padEnd(26, '0'),
        Date.now(),
        1,
        'session_started',
        1
      );
    }
    db.prepare(
      `INSERT INTO sessions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
    ).run(...values);
  } finally {
    db.close();
  }
}

interface CaptureShape {
  decisionExtractionCount?: number;
  decisionAlreadyExtracted?: boolean;
  decisionExtractionFailed?: string;
  writeFailures?: Array<{ op: string; code: string; message: string }>;
}

async function captureADecision(projectRoot: string, sessionId: string) {
  const result = await cmosSessionCapture({
    sessionId,
    category: 'decision',
    content: `s86-m02b real-store fire probe ${sessionId}`,
    projectRoot,
  });
  return { result, text: formatSessionCaptureForLLM(result) };
}

describe('s86-m02b real-store fire: a failed decision INSERT is named, not called "skipped"', () => {
  let liveStoreAvailable = false;

  beforeAll(() => {
    liveStoreAvailable = fs.existsSync(LIVE_DB);
  });

  it('the live store carries the context_id FK this reproduction depends on', () => {
    // PROBE-BEFORE-ENCODE (agents.md Process Hardening #5). If this ever stops holding, the
    // reproduction below stops being a reproduction and must be re-derived — it must NOT quietly
    // pass for a different reason.
    expect(liveStoreAvailable).toBe(true);
    const db = new Database(LIVE_DB, { readonly: true });
    try {
      const fks = db.prepare('PRAGMA foreign_key_list(strategic_decisions)').all() as Array<{
        table: string;
        from: string;
      }>;
      expect(fks.some((fk) => fk.from === 'context_id' && fk.table === 'contexts')).toBe(true);
      const ddl = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='strategic_decisions'`)
        .get() as { sql: string };
      expect(ddl.sql).toContain("context_id TEXT NOT NULL DEFAULT 'master_context'");
    } finally {
      db.close();
    }
  });

  it('names the FK failure with its DB error code, and no longer says "Extraction skipped"', async () => {
    const projectRoot = copyLiveStore();
    const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');

    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      db.prepare(`DELETE FROM contexts WHERE id = 'master_context'`).run();
      expect(
        db.prepare(`SELECT COUNT(*) AS c FROM contexts WHERE id = 'master_context'`).get()
      ).toEqual({ c: 0 });
    } finally {
      db.close();
    }

    const sessionId = 'PS-2026-08-11-901';
    seedActiveSession(dbPath, sessionId, null);

    const { result, text } = await captureADecision(projectRoot, sessionId);

    // success stays TRUE — the capture DID happen; what failed is the derived decision row.
    // The class is "assert something not so", not "keep going after a failure" (fork f09).
    expect(result.success).toBe(true);

    const data = result.data as CaptureShape;
    expect(data.decisionExtractionFailed).toBeDefined();
    expect(data.decisionExtractionFailed).toMatch(/FOREIGN KEY|constraint/i);

    // The structured channel carries op + code + message separately.
    const failures = data.writeFailures ?? [];
    expect(failures.map((f) => f.op)).toContain('strategic_decisions.insert');
    expect(failures[0]?.code).toBeTruthy();

    // THE POINT OF THE MISSION: the TEXT an agent reads must say so.
    expect(text).not.toContain('Extraction skipped');
    expect(text).toContain('**Decision Extraction**: FAILED');
    expect(text).toMatch(/FOREIGN KEY|constraint/i);
    expect(text).toContain('Write failures');
  });

  it('the same store WITH master_context present still reports a clean extraction', async () => {
    // The negative control. Without it, a test that fails for an unrelated reason (a broken
    // copy, a missing session) would still look like a successful reproduction.
    const projectRoot = copyLiveStore();
    const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
    const sessionId = 'PS-2026-08-11-902';
    seedActiveSession(dbPath, sessionId, null);

    const { result, text } = await captureADecision(projectRoot, sessionId);

    expect(result.success).toBe(true);
    const data = result.data as CaptureShape;
    expect(data.decisionExtractionFailed).toBeUndefined();
    expect(data.writeFailures).toEqual([]);
    expect(data.decisionExtractionCount).toBe(1);
    expect(text).toContain('**Decision Extraction**: Auto-extracted (1)');
    expect(text).not.toContain('Write failures');
  });

  it('a seedCmosDb fixture agrees with the real store, despite the 3-FK vs 6-FK divergence', async () => {
    // Success criterion: real-store and fixture must AGREE here. They diverge on which FKs are
    // enforced, but `context_id -> contexts` is present in both, so this reproduction is one of
    // the cases where the fixture is a faithful stand-in — proven, not assumed.
    const projectRoot = mkTmp('cmos-m02b-fixture-');
    const dbPath = seedCmosDb(projectRoot, { projectName: 'm02b fixture' });

    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      db.prepare(`DELETE FROM contexts WHERE id = 'master_context'`).run();
    } finally {
      db.close();
    }

    const sessionId = 'PS-2026-08-11-903';
    seedActiveSession(dbPath, sessionId, null);

    const { result, text } = await captureADecision(projectRoot, sessionId);

    expect(result.success).toBe(true);
    const data = result.data as CaptureShape;
    expect(data.decisionExtractionFailed).toBeDefined();
    expect(text).not.toContain('Extraction skipped');
    expect(text).toContain('**Decision Extraction**: FAILED');
  });
});
