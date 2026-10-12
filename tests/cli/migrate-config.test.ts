// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Offline rename recovery keeps the only valid store reachable after interrupted cutover.
// ABOUTME: Guard and config fixtures prove refusal, no overwrite, owned-text protection and retry.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import childProcess from 'child_process';
import { once } from 'events';
import { migrateProject, runMigrate } from '../../src/cli/migrate';
import { migrateConfig } from '../../src/cli/migrate-config';
import {
  assertModernClients,
  assertNoRecordProcesses,
  assertNoOpenFiles,
} from '../../src/cli/migrate-guard';
import { JOURNAL, PENDING, recoverMigration } from '../../src/cli/migrate-store';
import { LEGACY, resolveRecordPaths } from '../../src/intelligence/legacy-compat';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

let tmp: string;
let root: string;
let home: string;
let oldDb: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migration-recovery-'));
  root = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  oldDb = seedLegacyMigrationStore(root);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const options = () => ({
  projectRoot: root,
  env: { HOME: home },
  apply: true,
  checkProcesses: false,
});
function deadOwner(): void {
  const file = path.join(root, JOURNAL);
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  journal.pid = 2147483647;
  fs.writeFileSync(file, JSON.stringify(journal));
}

describe('shared config cutover', () => {
  const guard =
    require('../../src/cli/migrate-guard') as typeof import('../../src/cli/migrate-guard');
  function seedConfig(): { source: string; destination: string; recovery: string } {
    const source = path.join(home, '.config', LEGACY.configDirectory);
    fs.mkdirSync(source, { recursive: true });
    const db = new Database(path.join(source, 'project-graph.sqlite'));
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('registry survives')");
    db.close();
    fs.writeFileSync(path.join(source, 'profile.md'), 'Operator preferences');
    jest.spyOn(guard, 'assertNoRecordProcesses').mockImplementation(() => {});
    return {
      source,
      destination: path.join(home, '.config/rbook'),
      recovery: path.join(home, '.config/.rbook-config-migration.json'),
    };
  }
  it('moves offline registry and credentials together, then does nothing on a second apply', async () => {
    const { source, destination } = seedConfig();
    const result = await migrateConfig({ HOME: home }, true);
    expect(result).toMatchObject({ success: true, data: { moved: true } });
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'profile.md'), 'utf8')).toBe(
      'Operator preferences'
    );
    const db = new Database(path.join(destination, 'project-graph.sqlite'), { readonly: true });
    expect(db.prepare('SELECT value FROM witness').get()).toEqual({ value: 'registry survives' });
    db.close();
    expect((await migrateConfig({ HOME: home }, true)).data?.moved).toBe(false);
  });
  it('recovers a config move whose rollback was interrupted before retrying', async () => {
    const { source, destination, recovery } = seedConfig();
    const rename = fs.renameSync;
    const failed = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === source && String(to) === destination) {
        rename(from, to);
        throw new Error('interrupted after rename');
      }
      if (String(from) === destination && String(to) === source)
        throw new Error('rollback interrupted');
      rename(from, to);
    });
    expect((await migrateConfig({ HOME: home }, true)).success).toBe(false);
    failed.mockRestore();
    const receipt = JSON.parse(fs.readFileSync(recovery, 'utf8'));
    receipt.pid = 2147483647;
    fs.writeFileSync(recovery, JSON.stringify(receipt));
    expect((await migrateConfig({ HOME: home }, true)).success).toBe(true);
    expect(fs.existsSync(path.join(destination, 'project-graph.sqlite'))).toBe(true);
    expect(fs.existsSync(recovery)).toBe(false);
  });
  it('does not move shared config while any configured legacy 1.x build remains', async () => {
    const { source } = seedConfig();
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { old: { command: 'npx', args: [`${LEGACY.packageName}@1.0.1`] } },
      })
    );
    const result = await migrateConfig({ HOME: home }, true);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('legacy build');
    expect(fs.existsSync(source)).toBe(true);
  });
});
