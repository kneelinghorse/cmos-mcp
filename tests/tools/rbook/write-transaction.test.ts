// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m11 — a write transaction takes the store's write lock at BEGIN, so a commit by another
// ABOUTME: connection cannot land between its first read and its write and get the write refused.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';

let tmp: string;
let file: string;
let client: RbookDatabaseClient;
let other: Database.Database;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-write-transaction-'));
  file = path.join(tmp, 'store.sqlite');
  const seed = new Database(file);
  seed.pragma('journal_mode = WAL');
  seed.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  seed.close();
  const opened = await RbookDatabaseClient.create({ dbPath: file });
  client = opened.data!;
  // The other process's connection: a short busy timeout, so a wait it cannot win ends quickly.
  other = new Database(file, { timeout: 100 });
});
afterEach(() => {
  client.close();
  other.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Read, let the other connection try to commit a row, then write: what a record write does. */
function readThenWrite(): number {
  client.getOne('SELECT COUNT(*) AS n FROM notes');
  try {
    other.prepare("INSERT INTO notes (body) VALUES ('from the other process')").run();
  } catch {
    // Held off by this transaction's write lock: the case writeTransaction is for.
  }
  const inserted = client.execute("INSERT INTO notes (body) VALUES ('this write')");
  if (!inserted.success) throw new Error(inserted.error?.message ?? 'insert failed');
  return Number(inserted.data?.lastInsertRowid);
}

describe('a write that reads first, while another connection commits', () => {
  it('is refused at once in a deferred transaction, whatever the busy timeout', () => {
    // Why writeTransaction exists: SQLite answers the stale snapshot's upgrade with SQLITE_BUSY.
    const result = client.transaction(readThenWrite);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/locked/i);
  });

  it('commits in a write transaction, which holds the lock from its first statement', () => {
    const result = client.writeTransaction(readThenWrite);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(other.prepare('SELECT body FROM notes ORDER BY id').all()).toEqual([
      { body: 'this write' },
    ]);
  });
});
