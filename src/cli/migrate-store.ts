// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Holds an offline migration guard while checkpointing, backing up and renaming a record.
// ABOUTME: A durable journal rolls an interrupted cutover back without overwriting another writer.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { LEGACY } from '../intelligence/legacy-compat';
import { acquireMigrationExclusion } from './migrate-exclusion';
import { assertNoOpenFiles, assertNoRecordProcesses } from './migrate-guard';

export const JOURNAL = '.rbook-migration.json';
export const PENDING = '.rbook-migration-pending.json';
const LOCK = '.rbook-migration.lock';
interface Journal {
  readonly pid: number;
  readonly source: string;
  readonly destination: string;
  readonly originalIgnore: string | null;
  readonly ignoreMode: number;
  readonly backup: string;
  readonly journalMode: string;
  phase: 'prepared' | 'folder' | 'database' | 'committed';
}

/** Flush each phase before its rename, so recovery sees an intent even after a process crash. */
export function writeMigrationState(file: string, data: unknown): void {
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function release(root: string): void {
  fs.rmSync(path.join(root, JOURNAL), { force: true });
  fs.rmSync(path.join(root, LOCK), { recursive: true, force: true });
}
function verify(file: string, journalMode: string): void {
  const db = new Database(file, { fileMustExist: true, timeout: 0 });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error(`Integrity check failed at ${file}`);
    if (journalMode === 'wal') db.pragma('journal_mode = WAL');
  } finally {
    db.close();
  }
}
function rollback(root: string, journal: Journal): void {
  const { source, destination } = journal;
  if (fs.existsSync(source) && fs.existsSync(destination))
    throw new Error(
      `Recovery cannot overwrite ${source} or ${destination}; both exist. Retained ${path.join(root, JOURNAL)} and the migration guard.`
    );
  const current = fs.existsSync(destination) ? destination : source;
  assertNoOpenFiles(current);
  const oldFile = path.join(current, 'db', LEGACY.databaseFile);
  const newFile = path.join(current, 'db', 'rbook.sqlite');
  if (fs.existsSync(newFile)) {
    if (fs.existsSync(oldFile))
      throw new Error(
        `Recovery will not overwrite ${oldFile}; retained ${path.join(root, JOURNAL)}.`
      );
    fs.renameSync(newFile, oldFile);
  }
  if (current === destination) fs.renameSync(destination, source);
  const ignore = path.join(source, '.gitignore');
  if (journal.originalIgnore === null) fs.rmSync(ignore, { force: true });
  else {
    fs.writeFileSync(ignore, journal.originalIgnore);
    fs.chmodSync(ignore, journal.ignoreMode);
  }
  verify(path.join(source, 'db', LEGACY.databaseFile), journal.journalMode);
  release(root);
}

/** A crashed owner is recovered first; a living owner is never interrupted. */
export function recoverMigration(root: string, coordinated = false): boolean {
  const release = coordinated ? () => {} : acquireMigrationExclusion(root);
  try {
    return recoverOwnedMigration(root);
  } finally {
    release();
  }
}

function recoverOwnedMigration(root: string): boolean {
  const file = path.join(root, JOURNAL);
  const lock = path.join(root, LOCK);
  if (!fs.existsSync(file) && !fs.existsSync(lock)) return false;
  const ownerFile = path.join(lock, 'owner.json');
  const owner = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Journal) : null;
  const pid =
    owner?.pid ??
    (fs.existsSync(ownerFile)
      ? (JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid: number }).pid
      : null);
  if (!pid || !Number.isInteger(pid) || isAlive(pid))
    throw new Error(
      `Migration guard at ${lock} has a live or unknown owner; no files were changed.`
    );
  if (owner) {
    if (
      owner.source !== path.join(root, LEGACY.recordDirectory) ||
      owner.destination !== path.join(root, 'rbook')
    )
      throw new Error(`Invalid recovery paths in ${file}; no files were changed.`);
    if (owner.phase === 'committed') {
      verify(path.join(owner.destination, 'db', 'rbook.sqlite'), owner.journalMode);
      writeMigrationState(path.join(root, PENDING), {
        backup: owner.backup,
        remaining: 'documents and registration',
      });
      release(root);
    } else rollback(root, owner);
  } else release(root);
  return true;
}

export function moveRecord(root: string, checkProcesses = true): { backup: string } {
  const source = path.join(root, LEGACY.recordDirectory);
  const destination = path.join(root, 'rbook');
  const file = path.join(root, JOURNAL);
  const lock = path.join(root, LOCK);
  if (fs.existsSync(source) && fs.existsSync(destination))
    throw new Error(
      'Refusing migration because both record folders exist; inspect them before retrying.'
    );
  if (fs.lstatSync(source).isSymbolicLink())
    throw new Error(`Refusing a symlinked record directory: ${source}`);
  fs.mkdirSync(lock);
  writeMigrationState(path.join(lock, 'owner.json'), { pid: process.pid });
  let journal: Journal | undefined;
  try {
    if (checkProcesses) assertNoRecordProcesses();
    assertNoOpenFiles(source);
    const dbPath = path.join(source, 'db', LEGACY.databaseFile);
    if (fs.lstatSync(dbPath).nlink > 1)
      throw new Error(`Refusing a hardlinked database: ${dbPath}`);
    if (fs.lstatSync(dbPath).isSymbolicLink())
      throw new Error(`Refusing a symlinked database: ${dbPath}`);
    const db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
    const backupRelative = path.join('db', 'snapshots', `pre-migrate-${randomUUID()}.sqlite`);
    let journalMode = 'delete';
    try {
      journalMode = String(db.pragma('journal_mode', { simple: true }));
      const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
      if (checkpoint.some((row) => row.busy !== 0))
        throw new Error('Database checkpoint is busy; close all clients before migration.');
      db.pragma('locking_mode = EXCLUSIVE');
      db.pragma('journal_mode = DELETE');
      db.exec('BEGIN EXCLUSIVE; COMMIT;');
      const wal = `${dbPath}-wal`;
      if (fs.existsSync(wal) && fs.statSync(wal).size !== 0)
        throw new Error(`Uncheckpointed WAL remains at ${wal}; nothing was moved.`);
      fs.mkdirSync(path.join(source, 'db', 'snapshots'), { recursive: true });
      fs.copyFileSync(dbPath, path.join(source, backupRelative), fs.constants.COPYFILE_EXCL);
    } finally {
      db.close();
    }
    const ignore = path.join(source, '.gitignore');
    journal = {
      pid: process.pid,
      source,
      destination,
      originalIgnore: fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : null,
      ignoreMode: fs.existsSync(ignore) ? fs.statSync(ignore).mode & 0o7777 : 0o644,
      backup: path.join(destination, backupRelative),
      journalMode,
      phase: 'prepared',
    };
    writeMigrationState(file, journal);
    const original = journal.originalIgnore ?? '';
    let updated = original.split(`db/${LEGACY.databaseFile}`).join('db/*.sqlite');
    for (const pattern of [
      'db/*.sqlite',
      'db/*.sqlite-wal',
      'db/*.sqlite-shm',
      'db/snapshots/pre-migrate-*.sqlite',
    ]) {
      // Last matching rule wins: an earlier copy may be followed by a negation.
      updated += `${updated && !updated.endsWith('\n') ? '\n' : ''}${pattern}\n`;
    }
    fs.writeFileSync(ignore, updated);
    assertNoOpenFiles(source);
    journal.phase = 'folder';
    writeMigrationState(file, journal);
    fs.renameSync(source, destination);
    journal.phase = 'database';
    writeMigrationState(file, journal);
    fs.renameSync(
      path.join(destination, 'db', LEGACY.databaseFile),
      path.join(destination, 'db', 'rbook.sqlite')
    );
    verify(path.join(destination, 'db', 'rbook.sqlite'), journalMode);
    journal.phase = 'committed';
    writeMigrationState(file, journal);
    writeMigrationState(path.join(root, PENDING), {
      backup: journal.backup,
      remaining: 'documents and registration',
    });
    release(root);
    return { backup: journal.backup };
  } catch (error) {
    if (journal && journal.phase !== 'committed') {
      try {
        rollback(root, journal);
      } catch (recovery) {
        throw new Error(
          `${(error as Error).message}; recovery failed: ${(recovery as Error).message}`
        );
      }
    } else if (!journal) release(root);
    throw error;
  }
}
