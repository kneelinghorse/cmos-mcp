// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Rename migration previews leave no writes; owned text and offline moves preserve user state.
// ABOUTME: Real SQLite stores exercise refusal, recovery, idempotence and the CLI dispatch boundary.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli } from '../../src/cli';
import { migrateProject } from '../../src/cli/migrate';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import { rbookRulesLine, readRbookLine } from '../../src/tools/rbook/rules-files';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

let tmp: string;
let root: string;
let home: string;
let dbPath: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-'));
  root = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  dbPath = seedLegacyMigrationStore(root);
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    `# User rules\n\n${rbookRulesLine('builder')}\n\nUse ${LEGACY.toolPrefix}review and ${LEGACY.envPrefix}TEST. See ${LEGACY.recordDirectory}/docs/guide.md and ${LEGACY.recordDirectory}/db/${LEGACY.databaseFile}.\n${LEGACY.proseName} is our old project nickname.\n`
  );
  fs.writeFileSync(
    path.join(root, LEGACY.recordDirectory, '.gitignore'),
    `db/${LEGACY.databaseFile}\ncustom/\n`
  );
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const options = () => ({ projectRoot: root, env: { HOME: home }, checkProcesses: false });
function tree(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? tree(path.join(dir, e.name)) : [path.relative(tmp, path.join(dir, e.name))]
    );
}

describe('migration preview and document ownership', () => {
  it('dispatches --project as a read-only preview without telemetry or config writes', async () => {
    const before = tree(tmp);
    const bytes = fs.readFileSync(dbPath);
    const output: string[] = [];
    expect(
      await runCli(['migrate', '--project', root], {
        cwd: tmp,
        env: { HOME: home },
        readStdin: async () => '',
        stdout: (s) => output.push(s),
        stderr: (s) => output.push(s),
      })
    ).toBe(0);
    expect(output.join('')).toContain('dryRun');
    expect(tree(tmp)).toEqual(before);
    expect(fs.readFileSync(dbPath)).toEqual(bytes);
  });
  it('docs-only updates tool identifiers and owned prose while keeping paths to the unmoved folder', async () => {
    const result = await migrateProject({ ...options(), docsOnly: true, apply: true });
    expect(result.success).toBe(true);
    const text = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(text).toContain('Reasonbook keeps');
    expect(text).toContain('rbook_review');
    expect(text).toContain('RBOOK_TEST');
    expect(text).toContain(`${LEGACY.recordDirectory}/docs/guide.md`);
    expect(text).toContain(`${LEGACY.recordDirectory}/db/${LEGACY.databaseFile}`);
    expect(text).toContain(`${LEGACY.proseName} is our old project nickname.`);
    expect(result.data?.left).toEqual(expect.arrayContaining([expect.stringContaining('prose')]));
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(readRbookLine(root)?.level).toBe('builder');
    const again = await migrateProject({ ...options(), docsOnly: true, apply: true });
    expect(again.data?.changed).toEqual([]);
  });
  it('keeps a hand-edited owned line and reports its proposed replacement', async () => {
    const line = rbookRulesLine('planner') + ' Our exception.';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), `${line}\n`);
    const result = await migrateProject({ ...options(), docsOnly: true, apply: true });
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(`${line}\n`);
    expect(result.data?.left.join('\n')).toContain('edited by hand');
    expect(result.data?.left.join('\n')).toContain('Reasonbook keeps');
  });
});

describe('offline record move', () => {
  it('requires an old unpinned MCP package to be upgraded before a folder move', async () => {
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { [LEGACY.command]: { command: 'npx', args: [LEGACY.packageName] } },
      })
    );
    const result = await migrateProject({ ...options(), apply: true });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('still names the legacy package');
    expect(fs.existsSync(dbPath)).toBe(true);
  });
  it('rejects a configured native local build whose manifest is still pre-4', async () => {
    const runtime = path.join(tmp, 'old-runtime');
    fs.mkdirSync(path.join(runtime, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(runtime, 'package.json'),
      JSON.stringify({ name: '@aquex/reasonbook', version: '3.5.0' })
    );
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { rbook: { command: 'node', args: [path.join(runtime, 'dist/index.js')] } },
      })
    );
    const result = await migrateProject({ ...options(), apply: true });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('pre-4.x or unknown local build');
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('moves one real store with its record, keeps an intact backup and ignores both database names', async () => {
    const result = await migrateProject({ ...options(), apply: true });
    expect(result).toMatchObject({ success: true, data: { moved: true } });
    const moved = path.join(root, 'rbook/db/rbook.sqlite');
    const db = new Database(moved, { readonly: true });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get()).toBeDefined();
    db.close();
    expect(fs.existsSync(result.data!.backup!)).toBe(true);
    expect(spawnSync('git', ['init', '--quiet', root]).status).toBe(0);
    for (const file of [moved, `${moved}-wal`, `${moved}-shm`, result.data!.backup!]) {
      expect(spawnSync('git', ['-C', root, 'check-ignore', file]).status).toBe(0);
    }
    expect(fs.readFileSync(path.join(root, 'rbook/.gitignore'), 'utf8')).toContain('db/*.sqlite');
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain(
      'rbook/db/rbook.sqlite'
    );
    expect(fs.existsSync(path.join(root, '.rbook-migration.json'))).toBe(false);
    const again = await migrateProject({ ...options(), apply: true });
    expect(again.success).toBe(true);
    expect(again.data?.moved).toBe(false);
    expect(again.data?.changed).toEqual([]);
  });
  it('refuses two folders before changing either', async () => {
    fs.mkdirSync(path.join(root, 'rbook'));
    const before = fs.readFileSync(dbPath);
    const result = await migrateProject({ ...options(), apply: true });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('both');
    expect(fs.readFileSync(dbPath)).toEqual(before);
  });
  it('keeps the renamed store and recovery backup private even after earlier ignore negations', async () => {
    const rules = [
      'db/*.sqlite',
      'db/*.sqlite-wal',
      'db/*.sqlite-shm',
      'db/snapshots/pre-migrate-*.sqlite',
    ];
    fs.writeFileSync(
      path.join(root, LEGACY.recordDirectory, '.gitignore'),
      [...rules, ...rules.map((rule) => `!${rule}`)].join('\n') + '\n'
    );
    const result = await migrateProject({ ...options(), apply: true });
    expect(result.success).toBe(true);
    expect(spawnSync('git', ['init', '--quiet', root]).status).toBe(0);
    const moved = path.join(root, 'rbook/db/rbook.sqlite');
    for (const file of [moved, `${moved}-wal`, `${moved}-shm`, result.data!.backup!]) {
      expect(spawnSync('git', ['-C', root, 'check-ignore', file]).status).toBe(0);
    }
  });
  it('refuses even an idle external SQLite handle, before backup or document rewrites', async () => {
    const db = new Database(dbPath);
    try {
      const result = await migrateProject({ ...options(), apply: true });
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/open|busy|locked/);
      expect(fs.existsSync(dbPath)).toBe(true);
    } finally {
      db.close();
    }
  });
  it('rolls back a failure after the folder rename and preserves the original ignore rules', async () => {
    const rename = fs.renameSync;
    const failure = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('/rbook.sqlite')) throw new Error('simulated rename failure');
      return rename(from, to);
    });
    const result = await migrateProject({ ...options(), apply: true });
    failure.mockRestore();
    expect(result.success).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
    expect(fs.readFileSync(path.join(root, LEGACY.recordDirectory, '.gitignore'), 'utf8')).toBe(
      `db/${LEGACY.databaseFile}\ncustom/\n`
    );
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
  });
  it('refuses installed legacy plugins and configured legacy packages with a concrete remedy', async () => {
    fs.mkdirSync(path.join(home, '.claude/plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          [`${LEGACY.recordDirectory}@${LEGACY.recordDirectory}`]: [{ version: '3.5.0' }],
        },
      })
    );
    const result = await migrateProject({ ...options(), apply: true });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('3.5.0');
    expect(result.error?.suggestion).toContain('4.x');
  });
});
