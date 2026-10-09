// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Elects one ready hook source per verified harness lifetime and journals successful turn events.
// ABOUTME: Keys contain hashes only; lifecycle repeats stay eligible and end never deletes suppression receipts.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { harnessSessionHash, runtimeDir } from '../tools/cmos/harness-session';
import type { HookEvent, HookInput } from './core';
import { prepareRuntimeFile, requireSafeRuntime } from './runtime-file';

export interface HookRuntimeIdentity {
  readonly sessionHash: string;
  readonly directory: string;
  readonly directoryHash: string;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Store discovery is intentionally absent: init must not change the election key mid-session. */
export function hookRuntimeIdentity(
  input: HookInput,
  env: NodeJS.ProcessEnv
): HookRuntimeIdentity | null {
  const rawId = input.session_id?.trim();
  const directory = env.CLAUDE_PROJECT_DIR?.trim() || input.cwd?.trim();
  if (!rawId || !directory) return null;
  try {
    const canonical = fs.realpathSync.native(path.resolve(directory));
    if (!fs.statSync(canonical).isDirectory()) return null;
    return {
      sessionHash: harnessSessionHash(rawId),
      directory: canonical,
      directoryHash: hash(canonical),
    };
  } catch {
    return null;
  }
}

export function hookRuntimePath(key: HookRuntimeIdentity, env: NodeJS.ProcessEnv): string {
  return path.join(runtimeDir(env), 'hooks', `${key.sessionHash}-${key.directoryHash}.sqlite`);
}

function open(key: HookRuntimeIdentity, env: NodeJS.ProcessEnv): Database.Database {
  const file = hookRuntimePath(key, env);
  prepareRuntimeFile(file, {
    projectId: '',
    dbPath: path.join(key.directory, 'cmos', 'db', 'cmos.sqlite'),
  });
  return new Database(file, { timeout: 10 });
}

/** Only explicit ready sources elect. Unverifiable epochs intentionally permit both sources. */
export function electHookSource(
  key: HookRuntimeIdentity | null,
  source: string | undefined,
  epoch: string | null,
  env: NodeJS.ProcessEnv
): boolean {
  if (!key || !source?.trim() || !epoch) return true;
  const epochHash = hash(epoch);
  const file = hookRuntimePath(key, env);
  requireSafeRuntime(file, {
    projectId: '',
    dbPath: path.join(key.directory, 'cmos', 'db', 'cmos.sqlite'),
  });
  // Established sources only read. In particular a loser cannot contend with the winner's
  // in-flight turn receipt or produce a fail-open measurement from that writer lock.
  if (fs.existsSync(file)) {
    const reader = new Database(file, { readonly: true, fileMustExist: true, timeout: 10 });
    try {
      if (reader.prepare("SELECT 1 FROM sqlite_master WHERE name = 'election'").get()) {
        const prior = reader
          .prepare('SELECT source FROM election WHERE epoch = ?')
          .get(epochHash) as { source: string } | undefined;
        if (prior) return prior.source === source;
      }
    } finally {
      reader.close();
    }
  }
  const db = open(key, env);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS election (epoch TEXT PRIMARY KEY, source TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    const prior = db.prepare('SELECT source FROM election WHERE epoch = ?').get(epochHash) as
      | { source: string }
      | undefined;
    if (prior) {
      db.exec('ROLLBACK');
      return prior.source === source;
    }
    db.prepare('INSERT INTO election (epoch, source) VALUES (?, ?)').run(epochHash, source);
    db.exec('COMMIT');
    return true;
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

export interface HookReceipt {
  readonly duplicate: boolean;
  commit(): void;
  rollback(): void;
}

/**
 * Prompt and Stop IDs identify turns; lifecycle IDs can refer to the preceding turn and never
 * suppress a lifecycle call. Missing IDs cannot distinguish repeats: no prompt-text hashing.
 * Hold the transaction through successful work/output. A crash after stdout before commit may
 * replay; SQLite and stdout cannot share an atomic commit.
 */
export function beginHookReceipt(
  key: HookRuntimeIdentity | null,
  event: HookEvent,
  promptId: string | undefined,
  env: NodeJS.ProcessEnv
): HookReceipt | null {
  if (!key || !promptId?.trim() || (event !== 'prompt' && event !== 'stop')) return null;
  const db = open(key, env);
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS receipts (event TEXT NOT NULL, turn TEXT NOT NULL, PRIMARY KEY(event,turn))'
    );
    db.exec('BEGIN IMMEDIATE');
    const turn = hash(promptId);
    const duplicate = Boolean(
      db.prepare('SELECT 1 FROM receipts WHERE event = ? AND turn = ?').get(event, turn)
    );
    let closed = false;
    const finish = (success: boolean): void => {
      if (closed) return;
      try {
        if (success && !duplicate) {
          db.prepare('INSERT INTO receipts (event, turn) VALUES (?, ?)').run(event, turn);
          db.exec('COMMIT');
        } else db.exec('ROLLBACK');
      } finally {
        if (db.inTransaction) db.exec('ROLLBACK');
        closed = true;
        db.close();
      }
    };
    return { duplicate, commit: () => finish(true), rollback: () => finish(false) };
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}
