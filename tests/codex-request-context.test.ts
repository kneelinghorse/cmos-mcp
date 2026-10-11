// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The Codex carrier validates only caller identity/folder and never reuses a server folder.
// ABOUTME: Contextless resolution, runtime absence and lookup failures preserve the ownership boundary.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { currentCodexRequest, withCodexRequest } from '../src/codex-request-context';
import { resolveSenderContext } from '../src/intelligence/sender-context';
import { ProjectGraphRegistry } from '../src/intelligence/project-graph-registry';
import { CmosDetector } from '../src/intelligence/cmos-detector';
import { openDraftRuntime, recordSessionStart } from '../src/tools/cmos/draft-runtime';
import { harnessSessionHash } from '../src/tools/cmos/harness-session';
import { currentSessionOwner, processSessionOwner } from '../src/tools/cmos/session-owner';
import { formatCliRemedy } from '../src/utils/cli-remedy';
import { seedCmosDb } from './helpers/seedCmosDb';

let temp: string;
let project: string;
let dbPath: string;
const saved = process.env.CMOS_CONFIG_DIR;
const meta = (folder: string, sessionId = 'test-session') => ({
  'x-codex-turn-metadata': {},
  sessionId,
  'codex/sandbox-state-meta': { sandboxCwd: pathToFileURL(folder).href },
});
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-codex-context-'));
  project = path.join(temp, 'project');
  dbPath = seedCmosDb(project);
  process.env.CMOS_CONFIG_DIR = path.join(temp, 'config');
  ProjectGraphRegistry.resetInstance();
  CmosDetector.resetInstance();
});
afterEach(() => {
  jest.restoreAllMocks();
  ProjectGraphRegistry.resetInstance();
  CmosDetector.resetInstance();
  if (saved === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = saved;
  fs.rmSync(temp, { recursive: true, force: true });
});

it('interprets only sandboxCwd and retains no sandbox policy in the request carrier', () => {
  const metadata = meta(project);
  Object.defineProperty(metadata['codex/sandbox-state-meta'], 'permissionProfile', {
    get: () => {
      throw new Error('opaque policy must not be inspected');
    },
  });
  withCodexRequest(metadata, () => {
    expect(currentCodexRequest()).toEqual({ cwd: project, sessionId: 'test-session' });
  });
  expect(currentCodexRequest()).toBeUndefined();
});

it('does not recognize arbitrary non-Codex metadata as a caller identity', () => {
  withCodexRequest({ sessionId: 'other-client', 'codex/sandbox-state-meta': {} }, () => {
    expect(currentCodexRequest()).toBeUndefined();
  });
});

it.each([null, 'not-an-object', []])('refuses a malformed Codex marker %p', async (marker) => {
  await expect(
    withCodexRequest({ ...meta(project), 'x-codex-turn-metadata': marker }, () =>
      resolveSenderContext({ requireSenderIdentity: false })
    )
  ).rejects.toThrow('metadata is malformed');
});

it.each(['home', 'root'])(
  'treats %s as contextless without borrowing a server project',
  async (kind) => {
    const home = path.join(temp, 'home');
    fs.mkdirSync(home);
    const folder = kind === 'home' ? home : path.parse(temp).root;
    const options = {
      homeDirOverride: home,
      cwdOverride: project,
      serverProjectRootOverride: null,
      requireSenderIdentity: false,
    };
    await expect(
      withCodexRequest(meta(folder), () => resolveSenderContext(options))
    ).rejects.toMatchObject({ outcome: 'contextless-no-default', workingDir: folder });
    const resolved = await withCodexRequest(meta(folder), () =>
      resolveSenderContext({
        ...options,
        mcpRoots: [project],
      })
    );
    expect(resolved).toMatchObject({ projectRoot: project, source: 'mcp-roots' });
  }
);

it('honors the home ceiling instead of claiming an unrelated project under the home store', async () => {
  const home = path.join(temp, 'home');
  seedCmosDb(home);
  const child = path.join(home, 'uninitialized');
  fs.mkdirSync(child);
  await expect(
    withCodexRequest(meta(child), () =>
      resolveSenderContext({
        homeDirOverride: home,
        requireSenderIdentity: false,
      })
    )
  ).rejects.toMatchObject({ outcome: 'no-project-here', workingDir: child });
});

it('a hookless lookup creates no draft runtime and cannot borrow a conversation owner', () => {
  withCodexRequest(meta(project), () => {
    expect(currentSessionOwner(dbPath)).toEqual(processSessionOwner());
    expect(currentSessionOwner()).toEqual(processSessionOwner());
  });
  expect(fs.existsSync(path.join(process.env.CMOS_CONFIG_DIR!, 'runtime/drafts'))).toBe(false);
});

it('rechecks hook state after an absent table is created instead of caching its absence', () => {
  const runtime = openDraftRuntime(dbPath)!;
  runtime.db.exec('DROP TABLE session_state');
  runtime.close();
  withCodexRequest(meta(project), () => expect(currentSessionOwner(dbPath).kind).toBe('process'));
  const next = openDraftRuntime(dbPath)!;
  recordSessionStart(next, harnessSessionHash('test-session'), Date.now());
  next.close();
  withCodexRequest(meta(project), () =>
    expect(currentSessionOwner(dbPath)).toMatchObject({
      kind: 'external',
      key: `ext:${harnessSessionHash('test-session')}`,
    })
  );
});

it('surfaces an unreadable activation predicate instead of silently attesting approval', () => {
  const runtime = openDraftRuntime(dbPath)!;
  const file = runtime.path;
  runtime.close();
  // A foreign/corrupt runtime is a real database failure, not evidence that hooks are absent.
  const foreign = new Database(file);
  foreign.exec('DROP TABLE session_state; CREATE TABLE session_state (wrong_column TEXT)');
  foreign.close();
  expect(() => withCodexRequest(meta(project), () => currentSessionOwner(dbPath))).toThrow();
});

it('does not treat NULL session keys in a foreign runtime as hook proof', () => {
  const runtime = openDraftRuntime(dbPath)!;
  runtime.db.exec(
    'DROP TABLE session_state; CREATE TABLE session_state (session TEXT, started_at INTEGER)'
  );
  runtime.db.prepare('INSERT INTO session_state VALUES (NULL, NULL)').run();
  runtime.close();
  withCodexRequest(meta(project), () => expect(currentSessionOwner(dbPath).kind).toBe('process'));
});

it('keeps an un-migrated store without readable identity on the pid owner', () => {
  const foreign = path.join(temp, 'foreign/cmos/db/cmos.sqlite');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  const db = new Database(foreign);
  db.exec('CREATE TABLE legacy (value TEXT)');
  db.close();
  withCodexRequest(meta(path.join(temp, 'foreign')), () => {
    expect(currentSessionOwner(foreign)).toEqual(processSessionOwner());
  });
});

it('fails loudly while another process holds the hook runtime exclusively', async () => {
  const runtime = openDraftRuntime(dbPath)!;
  recordSessionStart(runtime, harnessSessionHash('test-session'), Date.now());
  const file = runtime.path;
  runtime.close();
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
     const db = new Database(process.argv[1]); db.exec('BEGIN EXCLUSIVE');
     process.stdout.write('locked'); setTimeout(() => db.close(), 5000);`,
      file,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Lock child exited early: ${code}`)));
    });
    expect(() => withCodexRequest(meta(project), () => currentSessionOwner(dbPath))).toThrow(
      /locked/
    );
  } finally {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
  }
});

it('names the client project explicitly in a shell remedy because shell cwd may differ', () => {
  expect(formatCliRemedy('review', { projectRoot: project, resolvedBy: 'client-cwd' })).toContain(
    `--project-root '${project}'`
  );
});
