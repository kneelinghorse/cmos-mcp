// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shared configuration moves only when every configured client can read its new location.
// ABOUTME: Offline checkpointing and a durable recovery receipt keep credentials and registry together.
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { LEGACY, getSetting } from '../intelligence/legacy-compat';
import type { RbookToolResult } from '../tools/rbook/types';
import { assertModernClients, assertNoRecordProcesses, assertNoOpenFiles } from './migrate-guard';
import { acquireMigrationExclusion } from './migrate-exclusion';
import { writeMigrationState } from './migrate-store';
import type { MigrationResult } from './migrate';

export async function migrateConfig(
  env: NodeJS.ProcessEnv,
  apply: boolean
): Promise<RbookToolResult<MigrationResult>> {
  const home = env.HOME ?? os.homedir();
  const parent = path.join(home, '.config');
  const source = path.join(parent, LEGACY.configDirectory);
  const destination = path.join(parent, 'rbook');
  const recovery = path.join(parent, '.rbook-config-migration.json');
  const lock = path.join(parent, '.rbook-config-migration.lock');
  let acquired = false;
  let release: (() => void) | undefined;
  const restoreModes = (directory: string, modes: Record<string, string>): void => {
    for (const [name, mode] of Object.entries(modes)) {
      if (path.basename(name) !== name || !name.endsWith('.sqlite'))
        throw new Error(`Invalid recovery database: ${name}`);
      const db = new Database(path.join(directory, name), { fileMustExist: true, timeout: 0 });
      try {
        if (db.pragma('integrity_check', { simple: true }) !== 'ok')
          throw new Error(`Integrity check failed for ${name}`);
        if (mode === 'wal') db.pragma('journal_mode = WAL');
      } finally {
        db.close();
      }
    }
  };
  try {
    if (getSetting('RBOOK_CONFIG_DIR', env) !== undefined)
      throw new Error(
        'Unset RBOOK_CONFIG_DIR and its legacy setting before moving the default shared config folder.'
      );
    if (apply && fs.existsSync(parent)) release = acquireMigrationExclusion(parent);
    if (fs.existsSync(recovery) || fs.existsSync(lock)) {
      if (!apply)
        throw new Error(
          `An interrupted config migration needs reasonbook migrate --config --apply; recovery record: ${recovery}`
        );
      assertModernClients(home, true);
      assertNoRecordProcesses();
      const receipt = fs.existsSync(recovery)
        ? (JSON.parse(fs.readFileSync(recovery, 'utf8')) as {
            pid: number;
            source: string;
            destination: string;
            modes: Record<string, string>;
          })
        : null;
      const ownerFile = path.join(lock, 'owner.json');
      const pid =
        receipt?.pid ??
        (fs.existsSync(ownerFile)
          ? (JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid: number }).pid
          : null);
      let alive = true;
      if (pid && Number.isInteger(pid)) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      }
      if (alive) throw new Error(`Config migration has a live or unknown owner; retained ${lock}.`);
      if (receipt && (receipt.source !== source || receipt.destination !== destination))
        throw new Error(`Invalid recovery paths in ${recovery}.`);
      if (fs.existsSync(source) && fs.existsSync(destination))
        throw new Error(
          'Cannot recover config while both directories exist; neither was overwritten.'
        );
      const current = fs.existsSync(destination) ? destination : source;
      assertNoOpenFiles(current);
      if (current === destination) fs.renameSync(destination, source);
      if (receipt) restoreModes(source, receipt.modes);
      fs.rmSync(recovery, { force: true });
      fs.rmSync(lock, { recursive: true, force: true });
    }
    if (fs.existsSync(source) && fs.existsSync(destination))
      throw new Error('Refusing config migration because both config folders exist.');
    if (!fs.existsSync(source))
      return { success: true, data: { dryRun: !apply, moved: false, changed: [], left: [] } };
    if (!apply)
      return {
        success: true,
        data: { dryRun: true, moved: false, changed: [`${source} -> ${destination}`], left: [] },
      };
    assertModernClients(home, true);
    fs.mkdirSync(lock);
    acquired = true;
    writeMigrationState(path.join(lock, 'owner.json'), { pid: process.pid });
    assertNoRecordProcesses();
    assertNoOpenFiles(source);
    const modes: Record<string, string> = {};
    for (const name of fs.readdirSync(source).filter((entry) => entry.endsWith('.sqlite'))) {
      const file = path.join(source, name);
      const db = new Database(file, { fileMustExist: true, timeout: 0 });
      try {
        modes[name] = String(db.pragma('journal_mode', { simple: true }));
        const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
        if (rows.some((row) => row.busy)) throw new Error(`${file} is busy; no folder was moved.`);
        db.pragma('locking_mode = EXCLUSIVE');
        db.pragma('journal_mode = DELETE');
        db.exec('BEGIN EXCLUSIVE; COMMIT;');
        fs.copyFileSync(file, `${file}.pre-migrate-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL);
      } finally {
        db.close();
      }
    }
    writeMigrationState(recovery, {
      pid: process.pid,
      source,
      destination,
      modes,
      phase: 'prepared',
    });
    assertNoOpenFiles(source);
    fs.renameSync(source, destination);
    restoreModes(destination, modes);
    fs.rmSync(recovery);
    fs.rmSync(lock, { recursive: true });
    acquired = false;
    return {
      success: true,
      data: { dryRun: false, moved: true, changed: [`${source} -> ${destination}`], left: [] },
    };
  } catch (error) {
    try {
      if (acquired && fs.existsSync(destination)) {
        if (fs.existsSync(source))
          throw new Error(`Cannot restore ${source}: another writer created it.`);
        assertNoOpenFiles(destination);
        fs.renameSync(destination, source);
      }
      if (acquired) {
        fs.rmSync(recovery, { force: true });
        fs.rmSync(lock, { recursive: true, force: true });
      }
    } catch (rollback) {
      return {
        success: false,
        error: {
          code: 'MIGRATION_RECOVERY_REQUIRED',
          message: `${(error as Error).message}; ${(rollback as Error).message}`,
          suggestion: `Preserved recovery record ${recovery} and migration guard ${lock}; resolve the conflicting path or open handle before retrying.`,
        },
      };
    }
    return {
      success: false,
      error: {
        code: 'MIGRATION_REFUSED',
        message: error instanceof Error ? error.message : String(error),
        suggestion:
          'Use Reasonbook 4.x in every configured client and close all clients using the shared config, then retry.',
      },
    };
  } finally {
    release?.();
  }
}
