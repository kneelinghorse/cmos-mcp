// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m02b criterion 5 — persistContext must not report a persisted context (or a
// ABOUTME: snapshot id) for content the database refused to store. Proven by raw SELECT, not shape.

/**
 * Sprint 86 m02b — `persistContext` is the single largest DURABLE-LOSS site in the class.
 *
 * WHY THIS MATTERS, not just what it asserts.
 *
 * `cmos_session(action="complete")` is the one call that folds a whole session's captures into
 * `master_context` / `project_context`. Everything the session learned reaches durable storage
 * through `persistContext` (cmos-session-complete.ts) and through nothing else. Before s86-m02b
 * that function BARE-EXECUTED its `UPDATE contexts SET content = ...`, discarded the envelope,
 * and then went on to write a context_snapshot and RETURN THE SNAPSHOT ID. `contextsUpdated` was
 * a hardcoded `true`. So a rejected context write produced an answer that reported a persisted
 * context, a positive `contextsUpdated`, and a snapshot id — for content that was never stored.
 *
 * That is worse than losing the write. An agent reading "Session Completed / Context Aggregation"
 * has no reason to re-capture anything, and the next session opens on a context that silently
 * predates the one that was just "saved". The loss is invisible AND unrecoverable, because the
 * only copy of the aggregated content was the one the process was holding in memory.
 *
 * SO THE TEST IS ABOUT DURABILITY, NOT ABOUT RESPONSE SHAPE. A response-shape test would pass
 * against an implementation that discloses a failure and then stores nothing, and would equally
 * pass against one that discloses a failure and then corrupts the row. Every case below reads the
 * stored `contexts.content` with a RAW SELECT before the call and again after it, and asserts on
 * the bytes. The disclosure assertions ride on top of that, never instead of it.
 *
 * HOW THE FAILURES ARE FORCED — at the DATABASE, never with a mock client (agents.md Process
 * Hardening #4). A mock client agrees with whatever SQL the handler happens to send, so it cannot
 * catch a wrong-column or wrong-table statement; these fixtures are real stores whose real SQLite
 * engine rejects the real statement:
 *
 *   - the WRITE half  — a `BEFORE UPDATE ON contexts` RAISE(ABORT) trigger. Surgical: it hits
 *     exactly the UPDATE arm of persistContext and nothing else in the handler.
 *   - the READ half   — `ALTER TABLE contexts RENAME TO ...`, which makes the existence SELECT
 *     that chooses UPDATE-vs-INSERT error out. Blunt by necessity (no SQL construct fails a
 *     SELECT while sparing an UPDATE on the same columns), and blunt is FINE here, because the
 *     claim under test is that NEITHER arm is attempted — which the op names in `writeFailures`
 *     record precisely.
 *
 *   - the SNAPSHOT half — a `BEFORE INSERT ON context_snapshots` RAISE(ABORT) trigger, which
 *     separates the two rows persistContext writes so neither can be blamed for the other.
 *
 * NEGATIVE CONTROL, and why it is not optional here. "The row did not change" is exactly what an
 * inert, half-broken fixture also produces. The second case runs the identical fixture with no
 * trigger and asserts the content DID change, `contextsUpdated` is true, a snapshot id comes back,
 * and the text carries no failure section. Without it, every assertion in the failing cases could
 * be green for the wrong reason.
 *
 * ONE MEASURED IMPRECISION, REPORTED RATHER THAN ASSERTED (see the note at the end of the
 * snapshot case): `aggregation.contextsUpdated` is computed from the SNAPSHOT ids, so a run whose
 * context UPDATEs all succeeded but whose snapshot INSERTs were rejected reports
 * `contextsUpdated: false` for contexts that were, in fact, durably updated. It errs toward
 * under-claiming — the opposite direction from the shipped defect — and the `writeFailures` entry
 * names `context_snapshots.insert(...)`, so the answer is not misleading about WHAT failed. It is
 * left unasserted on purpose: pinning it would freeze the imprecision into the suite.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  cmosSessionComplete,
  formatSessionCompleteForLLM,
  type CmosSessionCompleteResult,
} from '../../../src/tools/cmos/cmos-session-complete';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { seedCmosDb } from '../../helpers/seedCmosDb';

const CONTEXT_IDS = ['master_context', 'project_context'] as const;

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A seeded fixture under os.tmpdir(). NEVER cmos/db/cmos.sqlite — the real-store guard
 * (src/tools/cmos/real-store-guard.ts) throws on a write-capable open outside tmpdir under Jest,
 * and this suite deliberately schema-mutates its store.
 */
function makeStore(label: string): { projectRoot: string; dbPath: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cmos-m02b-persistctx-${label}-`));
  tmpDirs.push(projectRoot);
  const dbPath = seedCmosDb(projectRoot, { projectName: `m02b persist-context ${label}` });
  return { projectRoot, dbPath };
}

/** Deterministic-but-not-hardcoded ids: derived from the clock, never from a literal date. */
function todayStamp(): string {
  return new Date(Date.now()).toISOString().slice(0, 10);
}

/**
 * Give the store an active session with real, non-empty content to aggregate.
 *
 * The captures matter: `aggregateSessionIntoContexts` routes them into master_context, so the
 * content persistContext is asked to store genuinely DIFFERS from the seeded `'{}'`. If it did
 * not, "the stored content is unchanged" would be trivially true in the negative control too and
 * the whole durability clause would prove nothing.
 *
 * Genesis columns are stamped only when present so the same helper stays honest against a store
 * that has run the s69-m03 firehose migration and one that has not.
 */
function seedActiveSession(dbPath: string, sessionId: string): void {
  const db = new Database(dbPath);
  try {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
    const captures = JSON.stringify([
      {
        category: 'context',
        content: `s86-m02b persist-context probe ${sessionId}`,
        timestamp: new Date(Date.now()).toISOString(),
      },
    ]);
    const names = ['id', 'type', 'title', 'sprint_id', 'started_at', 'agent', 'status', 'captures'];
    const values: unknown[] = [
      sessionId,
      'build',
      'm02b persist-context probe',
      null,
      // Date.now()-relative: a session that started 45 minutes ago. No literal timestamps.
      new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      'jest',
      'active',
      captures,
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

/** Raw read of the durable bytes. The only evidence that counts in this file. */
function readContexts(dbPath: string, table = 'contexts'): Record<string, string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT id, content FROM ${table} WHERE id IN ('master_context', 'project_context')`)
      .all() as Array<{ id: string; content: string }>;
    return Object.fromEntries(rows.map((r) => [r.id, r.content]));
  } finally {
    db.close();
  }
}

function countSnapshotsFor(dbPath: string, source: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare('SELECT COUNT(*) AS c FROM context_snapshots WHERE source = ?').get(source) as {
        c: number;
      }
    ).c;
  } finally {
    db.close();
  }
}

function exec(dbPath: string, sql: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

async function completeSession(
  projectRoot: string,
  sessionId: string
): Promise<{ result: CmosToolResult<CmosSessionCompleteResult>; text: string }> {
  const result = await cmosSessionComplete({
    sessionId,
    summary: 's86-m02b persist-context disclosure probe',
    projectRoot,
  });
  return { result, text: formatSessionCompleteForLLM(result) };
}

describe('s86-m02b criterion 5: persistContext discloses a rejected context write', () => {
  it('WRITE HALF: a rejected UPDATE is named per context id, the stored content is unchanged, and no snapshot id is invented', async () => {
    const { projectRoot, dbPath } = makeStore('update-fail');
    const sessionId = `PS-${todayStamp()}-911`;
    seedActiveSession(dbPath, sessionId);

    // READ THE OLD CONTENT FIRST. Everything below is measured against these exact bytes.
    const before = readContexts(dbPath);
    expect(Object.keys(before).sort()).toEqual(['master_context', 'project_context']);

    // Surgical forcing: only the UPDATE arm of persistContext touches `contexts` with an UPDATE.
    exec(
      dbPath,
      `CREATE TRIGGER force_context_update_failure BEFORE UPDATE ON contexts
       BEGIN SELECT RAISE(ABORT, 'forced failure: contexts UPDATE rejected'); END;`
    );

    const { result, text } = await completeSession(projectRoot, sessionId);

    // success stays TRUE — the session DID complete. The cure for this defect class is
    // disclosure, not abortion (fork f09).
    expect(result.success).toBe(true);
    const data = result.data as CmosSessionCompleteResult;

    // --- THE DISCLOSURE, NAMING THE CONTEXT ID ---
    const failures = data.writeFailures ?? [];
    expect(failures.map((f) => f.op)).toEqual(
      expect.arrayContaining([
        'contexts.update(master_context)',
        'contexts.update(project_context)',
      ])
    );
    for (const contextId of CONTEXT_IDS) {
      const failure = failures.find((f) => f.op === `contexts.update(${contextId})`);
      expect(failure).toBeDefined();
      // The DB's own words, not a substituted generic phrase.
      expect(failure?.message).toContain('forced failure: contexts UPDATE rejected');
      expect(failure?.code).toBeTruthy();
    }

    // --- THE DURABILITY CLAUSE: a RAW SELECT proves the old content survived untouched ---
    const after = readContexts(dbPath);
    expect(after).toEqual(before);

    // --- THE SNAPSHOT STILL LANDS, AND THAT IS DELIBERATE ---
    // The obvious "fix" is to bail out before the snapshot INSERT so no id is invented. It is the
    // wrong trade, and the build-time critic was right to flag it: pre-s86-m02b the snapshot was
    // written even when the context write failed, and that snapshot is the ONLY durable copy of
    // the aggregated content — recoverable later via cmos_context(history). Bailing out would
    // have made the answer honest by DESTROYING data the fail-quiet version preserved.
    //
    // So the two facts are reported SEPARATELY rather than one standing in for the other:
    //   snapshotId      — did the snapshot land?      (yes, here)
    //   contextsUpdated — did the context row land?   (no, here)
    // Deriving contextsUpdated from the snapshot id, as an earlier revision did, reported
    // "contexts not updated" for a run whose contexts WERE written and whose snapshot merely
    // failed — this mission's own defect class, mirrored.
    expect(data.aggregation.masterSnapshotId).not.toBeNull();
    expect(data.aggregation.projectSnapshotId).not.toBeNull();
    expect(countSnapshotsFor(dbPath, `session_complete:${sessionId}`)).toBe(2);

    // --- contextsUpdated is COMPUTED now, not a hardcoded `true`, and it tracks the CONTEXT
    //     write specifically ---
    expect(data.aggregation.contextsUpdated).toBe(false);

    // --- AND IT IS VISIBLE IN THE TEXT AN AGENT ACTUALLY READS ---
    // structuredContent-only disclosure is the defect this sprint exists to close: src/index.ts
    // returns content[0].text = format*ForLLM(result), and that string is what the model sees.
    expect(text).toContain(
      'Write failures (the database rejected these; the counts above exclude them):'
    );
    expect(text).toContain('contexts.update(master_context)');
    expect(text).toContain('contexts.update(project_context)');
    expect(text).toContain('forced failure: contexts UPDATE rejected');
    // The answer must not simultaneously announce a successful aggregation.
    expect(text).not.toContain('**Context Aggregation**');
  });

  it('NEGATIVE CONTROL: without the trigger the same fixture really persists — content changes, snapshot id returned, no failure section', async () => {
    // Without this, "content unchanged" and "no snapshot" above would be equally green on a
    // fixture that was simply inert, and the durability clause would prove nothing.
    const { projectRoot, dbPath } = makeStore('control');
    const sessionId = `PS-${todayStamp()}-912`;
    seedActiveSession(dbPath, sessionId);

    const before = readContexts(dbPath);

    const { result, text } = await completeSession(projectRoot, sessionId);

    expect(result.success).toBe(true);
    const data = result.data as CmosSessionCompleteResult;

    expect(data.writeFailures).toEqual([]);
    expect(data.aggregation.contextsUpdated).toBe(true);
    expect(typeof data.aggregation.masterSnapshotId).toBe('number');
    expect(typeof data.aggregation.projectSnapshotId).toBe('number');

    const after = readContexts(dbPath);
    for (const contextId of CONTEXT_IDS) {
      expect(after[contextId]).not.toEqual(before[contextId]);
    }
    expect(countSnapshotsFor(dbPath, `session_complete:${sessionId}`)).toBeGreaterThan(0);

    expect(text).not.toContain('Write failures');
    expect(text).toContain('**Context Aggregation**');
  });

  it('READ HALF: when the existence SELECT fails, NEITHER arm is attempted and the answer says so', async () => {
    // fork f10, non-cuttable. The SELECT at persistContext chooses UPDATE (row exists) vs INSERT
    // (row absent). A FAILED select used to be indistinguishable from "absent", so the handler
    // took the INSERT arm against a row that already exists — turning a transient read error into
    // a constraint violation on a path that then reported success anyway.
    const { projectRoot, dbPath } = makeStore('select-fail');
    const sessionId = `PS-${todayStamp()}-913`;
    seedActiveSession(dbPath, sessionId);

    const before = readContexts(dbPath);

    // Blunt on purpose, and the bluntness is the point: with the table gone, ANY write attempt
    // would have to fail too — so the fact that no write op is recorded below is proof that no
    // write was attempted, not proof that a write happened to succeed.
    exec(dbPath, 'ALTER TABLE contexts RENAME TO contexts_quarantined;');

    const { result, text } = await completeSession(projectRoot, sessionId);

    expect(result.success).toBe(true);
    const data = result.data as CmosSessionCompleteResult;

    const failures = data.writeFailures ?? [];
    const ops = failures.map((f) => f.op);

    // Disclosed, per context id.
    expect(ops).toEqual(
      expect.arrayContaining([
        'contexts.persist(master_context)',
        'contexts.persist(project_context)',
      ])
    );
    for (const contextId of CONTEXT_IDS) {
      const failure = failures.find((f) => f.op === `contexts.persist(${contextId})`);
      expect(failure?.message).toContain('neither UPDATE nor INSERT was attempted');
    }

    // THE CLAUSE THAT CATCHES THE OLD BUG: no INSERT arm was taken. Under the pre-fix code the
    // failed read fell through to `INSERT INTO contexts (...)`, which on this fixture would have
    // produced a `contexts.insert(...)` op (or, before the guard existed, a silent loss).
    expect(ops.some((op) => op.startsWith('contexts.insert('))).toBe(false);
    expect(ops.some((op) => op.startsWith('contexts.update('))).toBe(false);

    expect(data.aggregation.contextsUpdated).toBe(false);
    expect(data.aggregation.masterSnapshotId).toBeNull();
    expect(data.aggregation.projectSnapshotId).toBeNull();

    // Durability: the rows are exactly as they were (read through the quarantined name).
    expect(readContexts(dbPath, 'contexts_quarantined')).toEqual(before);

    // Visible in the text.
    expect(text).toContain(
      'Write failures (the database rejected these; the counts above exclude them):'
    );
    expect(text).toContain('contexts.persist(master_context)');
    expect(text).toContain('neither UPDATE nor INSERT was attempted');
    expect(text).not.toContain('**Context Aggregation**');
  });

  it('SNAPSHOT HALF: a rejected snapshot INSERT is disclosed and yields no snapshot id, while the context write that DID land is not rolled back', async () => {
    // persistContext writes TWO rows: the context itself, then its audit snapshot. They fail
    // independently, and the answer must describe each honestly rather than collapsing them.
    const { projectRoot, dbPath } = makeStore('snapshot-fail');
    const sessionId = `PS-${todayStamp()}-914`;
    seedActiveSession(dbPath, sessionId);

    const before = readContexts(dbPath);

    exec(
      dbPath,
      `CREATE TRIGGER force_snapshot_insert_failure BEFORE INSERT ON context_snapshots
       BEGIN SELECT RAISE(ABORT, 'forced failure: snapshot INSERT rejected'); END;`
    );

    const { result, text } = await completeSession(projectRoot, sessionId);

    expect(result.success).toBe(true);
    const data = result.data as CmosSessionCompleteResult;

    const ops = (data.writeFailures ?? []).map((f) => f.op);
    expect(ops).toEqual(
      expect.arrayContaining([
        'context_snapshots.insert(master_context)',
        'context_snapshots.insert(project_context)',
      ])
    );
    // The context row itself was NOT rejected, so it must not be blamed.
    expect(ops.some((op) => op.startsWith('contexts.update('))).toBe(false);
    expect(ops.some((op) => op.startsWith('contexts.persist('))).toBe(false);

    // No snapshot id is invented for a snapshot that does not exist — the exact over-claim that
    // made this the largest durable-loss site.
    expect(data.aggregation.masterSnapshotId).toBeNull();
    expect(data.aggregation.projectSnapshotId).toBeNull();
    expect(countSnapshotsFor(dbPath, `session_complete:${sessionId}`)).toBe(0);

    // ...and the context write that genuinely landed is still there. Read back raw: this is the
    // clause that stops a future "fix" from reacting to a snapshot failure by discarding or
    // reverting the aggregated content.
    const after = readContexts(dbPath);
    for (const contextId of CONTEXT_IDS) {
      expect(after[contextId]).not.toEqual(before[contextId]);
    }

    expect(text).toContain(
      'Write failures (the database rejected these; the counts above exclude them):'
    );
    expect(text).toContain('forced failure: snapshot INSERT rejected');

    // DELIBERATELY NOT ASSERTED, and reported to the mission instead: in this scenario
    // `aggregation.contextsUpdated` is FALSE even though both context rows were durably updated,
    // because it is derived from the SNAPSHOT ids (`projectSnapshotId !== null &&
    // masterSnapshotId !== null`) rather than from the context write. Measured, not inferred.
    // Pinning that value here would freeze the imprecision into the suite and make a later
    // correction go red for the wrong reason.
  });
});
