// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Serializes prompt recall through output and remembers only completely delivered typed spans.
// ABOUTME: The external runtime holds hashed session/store keys and typed IDs, never prompt or record text.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import { harnessSessionHash, runtimeDir } from '../tools/cmos/harness-session';
import { safeDestination, targetForStore, telemetryKey } from '../tools/cmos/local-telemetry';
import type { RenderedContext } from '../tools/cmos/rendered-context';
import { emittedRenderedIds } from './telemetry';

export interface FirstPromptOptions {
  readonly dbPath: string;
  readonly rawSessionId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly deadlineAtMs: number;
}

/** Session state survives resume and compact. Runtime cleanup, not a session event, removes it. */
export function recallStatePath(rawSessionId: string, env: NodeJS.ProcessEnv): string {
  return path.join(runtimeDir(env), 'recall', `${harnessSessionHash(rawSessionId)}.sqlite`);
}

/** One transaction covers preparation, synchronous stdout and successful delivery state. */
function withRecallState(
  options: FirstPromptOptions,
  action: (db: Database.Database, key: string, checkDeadline: () => void) => void
): void {
  const checkDeadline = (): void => {
    if (Date.now() >= options.deadlineAtMs)
      throw new Error('first-prompt recall deadline exceeded');
  };
  checkDeadline();
  if (!options.rawSessionId.trim()) throw new Error('first-prompt recall needs a session id');
  const target = targetForStore(options.dbPath);
  if (!target) throw new Error('first-prompt recall could not read the project identity');
  const file = recallStatePath(options.rawSessionId, options.env);
  const requireSafe = (): void => {
    for (const name of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
      if (!safeDestination(name, target))
        throw new Error(
          'unsafe recall runtime destination; choose a config directory outside projects'
        );
      try {
        const stat = fs.lstatSync(name);
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error('linked recall runtime file is unsafe');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };
  requireSafe();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  requireSafe();
  const db = new Database(file, { timeout: 10 });
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS delivery (store_key TEXT PRIMARY KEY, completed INTEGER NOT NULL, ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (store_key TEXT NOT NULL, typed_id TEXT NOT NULL, PRIMARY KEY(store_key,typed_id))`);
    db.exec('BEGIN IMMEDIATE');
    action(db, telemetryKey(target), checkDeadline);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

function remember(db: Database.Database, key: string, ids: readonly string[]): void {
  const insert = db.prepare('INSERT OR IGNORE INTO seen (store_key,typed_id) VALUES (?,?)');
  for (const id of ids) insert.run(key, id);
}

/**
 * Retained indefinitely across resume/compact/end. A crash after stdout before COMMIT may replay;
 * the two effects cannot be atomic. Only the first available empty result consumes first recall.
 */
export function deliverPromptRecall(
  options: FirstPromptOptions,
  prepare: (first: boolean, seen: readonly string[]) => RenderedContext | null,
  emit: (context: RenderedContext) => string
): void {
  withRecallState(options, (db, key, checkDeadline) => {
    const prior = db
      .prepare('SELECT ids FROM delivery WHERE store_key = ? AND completed = 1')
      .get(key) as { ids: string } | undefined;
    // Receipts from m05 predate the seen table; their delivered IDs remain seen after upgrade.
    if (prior) remember(db, key, JSON.parse(prior.ids) as string[]);
    const seen = (
      db.prepare('SELECT typed_id FROM seen WHERE store_key = ? ORDER BY typed_id').all(key) as {
        typed_id: string;
      }[]
    ).map((row) => row.typed_id);
    checkDeadline();
    const context = prepare(!prior, seen);
    checkDeadline();
    if (!context) return;
    const emitted = context.text ? emit(context) : '';
    const ids = emittedRenderedIds(context, emitted);
    remember(db, key, ids);
    if (!prior)
      db.prepare('INSERT INTO delivery (store_key,completed,ids) VALUES (?,1,?)').run(
        key,
        JSON.stringify(ids)
      );
  });
}

/** Kept for the m05 first-prompt contract and its direct consumers. */
export function deliverFirstPrompt(
  options: FirstPromptOptions,
  prepare: () => RenderedContext,
  emit: (context: RenderedContext) => string
): void {
  deliverPromptRecall(options, (first) => (first ? prepare() : null), emit);
}

/** A digest marks seen spans without consuming the first prompt, only after its output succeeds. */
export function deliverRecallContext(
  options: FirstPromptOptions,
  context: RenderedContext,
  emit: (context: RenderedContext) => string
): void {
  withRecallState(options, (db, key, checkDeadline) => {
    checkDeadline();
    const emitted = context.text ? emit(context) : '';
    remember(db, key, emittedRenderedIds(context, emitted));
  });
}
