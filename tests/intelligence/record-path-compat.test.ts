// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Prove renamed stores remain discoverable without reviving archived projects or forking data.
// ABOUTME: Real legacy/new stores cover precedence, cached migration guards and safe initialization.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { openStoreReadOnly } from '../../src/intelligence/cross-store-query';
import { resolveCliProject } from '../../src/cli/core';
import { copySeedDir } from '../../src/tools/rbook/level-files';
import { loadTierConfig } from '../../src/tools/rbook/tier-config';
import { storeAt } from '../../src/intelligence/resolution-policy';
import {
  ProjectGraphRegistry,
  readStoreIdentity,
} from '../../src/intelligence/project-graph-registry';
import { rbookProjectInit } from '../../src/tools/rbook/rbook-project-init';
import { RbookDatabaseClient } from '../../src/tools/rbook/client';
import { seedRbookDb } from '../helpers/seedRbookDb';
import { LEGACY } from '../../src/intelligence/legacy-compat';

describe('record path compatibility', () => {
  let temporary: string;
  let previousConfig: string | undefined;

  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'record-path-compat-'));
    previousConfig = process.env.RBOOK_CONFIG_DIR;
    process.env.RBOOK_CONFIG_DIR = path.join(temporary, 'config');
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
  });

  afterEach(() => {
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    if (previousConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = previousConfig;
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  function seed(name: string, renamed = false): string {
    const root = path.join(temporary, name);
    const created = seedRbookDb(root, { projectId: name, projectName: name });
    const directory = path.dirname(path.dirname(created));
    const wantedDirectory = path.join(root, renamed ? 'rbook' : LEGACY.recordDirectory);
    if (directory !== wantedDirectory) fs.renameSync(directory, wantedDirectory);
    const database = path.join(wantedDirectory, 'db', path.basename(created));
    const wantedDatabase = path.join(
      wantedDirectory,
      'db',
      renamed ? 'rbook.sqlite' : LEGACY.databaseFile
    );
    if (database !== wantedDatabase) fs.renameSync(database, wantedDatabase);
    return root;
  }

  it.each([false, true])(
    'reads a real store without changing its chosen layout (renamed=%s)',
    async (renamed) => {
      const root = seed(renamed ? 'new-store' : 'old-store', renamed);
      const spelling = renamed ? 'rbook' : LEGACY.recordDirectory;
      const detection = await RbookDetector.getInstance().detect(root);
      expect(detection.databasePath).toBe(path.join(root, spelling, 'db', `${spelling}.sqlite`));
      expect(storeAt(root)).toEqual({ root, hasDatabase: true });
      expect(readStoreIdentity(root)?.project_id).toBe(renamed ? 'new-store' : 'old-store');
      const opened = await RbookDatabaseClient.create({ projectRoot: root, readonly: true });
      expect(opened.success).toBe(true);
      opened.data?.close();
      expect(fs.existsSync(path.join(root, renamed ? LEGACY.recordDirectory : 'rbook'))).toBe(
        false
      );
    }
  );

  it('prefers the new folder even when its missing database must not fall back to a different record', async () => {
    const root = seed('both');
    fs.mkdirSync(path.join(root, 'rbook', 'db'), { recursive: true });
    expect(storeAt(root)).toEqual({ root, hasDatabase: false });
    const detection = await RbookDetector.getInstance().detect(root);
    expect(detection.rbookDirectory).toBe(path.join(root, 'rbook'));
    expect(detection.hasDatabase).toBe(false);
    expect(readStoreIdentity(root)).toBeNull();
  });

  it('does not mistake a bare record folder for a project marker', () => {
    fs.mkdirSync(path.join(temporary, 'rbook'));
    expect(storeAt(temporary)).toBeNull();
  });

  it('boot prune keeps active renamed stores and leaves deliberate archived stores archived', async () => {
    const active = seed('active', true);
    const archived = seed('archived', true);
    const graph = await ProjectGraphRegistry.create();
    graph.register({ project_id: 'active', store_path: active, name: 'Active' });
    graph.register({ project_id: 'archived', store_path: archived, name: 'Archived' });
    graph.archive('archived');
    expect(graph.pruneMissingStores()).toBe(0);
    expect(graph.get('active')?.archived_at).toBeNull();
    expect(graph.get('archived')?.archived_at).not.toBeNull();
  });

  it('checks migration recovery before serving a cached detection', async () => {
    const root = seed('guarded');
    const detector = RbookDetector.getInstance();
    await detector.detect(root);
    fs.writeFileSync(path.join(root, '.rbook-migration.json'), '{}');
    await expect(detector.detect(root)).rejects.toThrow(/migrat/i);
    expect(() => storeAt(root)).toThrow(/migrat/i);
  });

  it('refuses init during migration instead of creating a competing legacy store', async () => {
    const root = path.join(temporary, 'moving');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.rbook-migration.json'), '{}');
    const result = await rbookProjectInit({ projectRoot: root });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/migrat/i);
    expect(fs.existsSync(path.join(root, LEGACY.recordDirectory))).toBe(false);
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
  });

  it('initializes an existing renamed store without creating a second legacy record', async () => {
    const root = seed('init-new', true);
    const result = await rbookProjectInit({ projectRoot: root });
    expect(result.success).toBe(true);
    expect(result.data?.rbookDirectory).toBe(path.join(root, 'rbook'));
    expect(fs.existsSync(path.join(root, LEGACY.recordDirectory))).toBe(false);
    expect(readStoreIdentity(root)?.project_id).toBe('init-new');
  });

  it('uses the selected renamed record for CLI, cross-store reads and its own tier guide', async () => {
    const root = seed('all-readers', true);
    const dbPath = path.join(root, 'rbook/db/rbook.sqlite');
    const selected = resolveCliProject({ projectRootArg: root, env: {}, cwd: temporary });
    expect(selected).toMatchObject({ kind: 'store', dbPath });
    const db = openStoreReadOnly(root);
    try {
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get()).toEqual({
        value: 'all-readers',
      });
    } finally {
      db.close();
    }
    fs.mkdirSync(path.join(root, 'rbook/tiers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'rbook/tiers/build.md'), '# This project owns this guide');
    expect(loadTierConfig('build', root)?.guide).toBe('# This project owns this guide');
  });

  it('refuses explicit client and cross-store opens while migration owns the record', async () => {
    const root = seed('explicit-guard', true);
    fs.mkdirSync(path.join(root, '.rbook-migration.lock'));
    const result = await RbookDatabaseClient.create({
      dbPath: path.join(root, 'rbook/db/rbook.sqlite'),
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/migrat/i);
    expect(() => openStoreReadOnly(root)).toThrow(/migrat/i);
  });

  it('never copies a renamed seed database or its WAL into a freshly initialized record', () => {
    const source = path.join(temporary, 'seed');
    const destination = path.join(temporary, 'copy');
    fs.mkdirSync(source);
    for (const file of [
      LEGACY.databaseFile,
      `${LEGACY.databaseFile}-wal`,
      `${LEGACY.databaseFile}-shm`,
      'rbook.sqlite',
      'rbook.sqlite-wal',
      'rbook.sqlite-shm',
    ]) {
      fs.writeFileSync(path.join(source, file), 'stale record bytes');
    }
    fs.writeFileSync(path.join(source, 'schema.sql'), 'CREATE TABLE witness (id TEXT);');
    copySeedDir(source, destination, destination);
    expect(fs.readdirSync(destination)).toEqual(['schema.sql']);
  });

  it('preserves explicit custom detector directory and database options', async () => {
    const directory = path.join(temporary, 'custom');
    fs.mkdirSync(directory);
    const db = path.join(directory, 'other.sqlite');
    fs.writeFileSync(db, 'custom fixture');
    const found = await RbookDetector.getInstance({
      rbookDirectoryName: directory,
      sqliteRelativePath: db,
    }).detect(temporary);
    expect(found.databasePath).toBe(db);
  });
});
