// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s88-m08 boundary tests for request-local registration policy and identity-less probes.
// ABOUTME: Includes a deterministic two-process race proving first-writer UUID convergence.

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import {
  ProjectGraphRegistry,
  type ProjectGraphEntry,
} from '../../../src/intelligence/project-graph-registry';
import {
  resolveSenderContext,
  SenderResolutionError,
} from '../../../src/intelligence/sender-context';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  captureToolCall,
  currentToolCallActionMode,
} from '../../../src/tools/cmos/tool-call-context';
import { seedCmosDb } from '../../helpers/seedCmosDb';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

interface MintContender {
  readonly child: ChildProcess;
  readonly result: Promise<string>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForFiles(paths: readonly string[], timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (paths.every((file) => fs.existsSync(file))) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for contender barriers: ${paths.join(', ')}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

/**
 * Start one independent Node process that calls the real registerStore implementation.
 *
 * The tiny require hook only transpiles repository TypeScript because this project does not ship
 * ts-node. The better-sqlite3 wrapper pauses immediately AFTER this contender has observed the
 * blank metadata row. Releasing both processes only after both marker files exist makes the race
 * falsifiable: the former unconditional REPLACE returns two different UUIDs, while the conditional
 * UPSERT makes both contenders re-read and return the same persisted winner.
 */
function startMintContender(input: {
  projectRoot: string;
  configDir: string;
  readyFile: string;
  releaseFile: string;
}): MintContender {
  const childProgram = String.raw`
const fs = require('fs');
const ts = require('typescript');
const Database = require('better-sqlite3');
const [projectRoot, configDir, readyFile, releaseFile] = process.argv.slice(1);

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  module._compile(output, filename);
};

const originalPrepare = Database.prototype.prepare;
let pausedAfterBlankRead = false;
Database.prototype.prepare = function (...args) {
  const statement = Reflect.apply(originalPrepare, this, args);
  const sql = String(args[0]);
  if (
    pausedAfterBlankRead ||
    !sql.includes("SELECT value FROM metadata WHERE key = 'project_id'")
  ) {
    return statement;
  }

  return new Proxy(statement, {
    get(target, property) {
      if (property !== 'get') return Reflect.get(target, property, target);
      return (...getArgs) => {
        const row = Reflect.apply(target.get, target, getArgs);
        const observed = String(row?.value ?? '').trim();
        if (observed.length === 0 && !pausedAfterBlankRead) {
          pausedAfterBlankRead = true;
          fs.writeFileSync(readyFile, 'ready');
          const deadline = Date.now() + 20000;
          const sleeper = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(releaseFile)) {
            if (Date.now() >= deadline) throw new Error('release barrier timed out');
            Atomics.wait(sleeper, 0, 0, 10);
          }
        }
        return row;
      };
    },
  });
};

(async () => {
  const { ProjectGraphRegistry } = require('./src/intelligence/project-graph-registry.ts');
  const graph = await ProjectGraphRegistry.create({ configDir });
  try {
    const entry = graph.registerStore(projectRoot);
    process.stdout.write('RESULT:' + entry.project_id + '\n');
  } finally {
    graph.close();
  }
})().catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  process.exitCode = 1;
});
`;

  const child = spawn(
    process.execPath,
    ['-e', childProgram, input.projectRoot, input.configDir, input.readyFile, input.releaseFile],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  const result = new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      const match = stdout.match(/^RESULT:([^\r\n]+)$/m);
      if (code === 0 && match) {
        resolve(match[1].trim());
        return;
      }
      reject(
        new Error(
          `Registration contender exited ${String(code)} without a result. stdout=${JSON.stringify(
            stdout
          )} stderr=${JSON.stringify(stderr)}`
        )
      );
    });
  });

  return { child, result };
}

describe('s88-m08 — identity registration concurrency and probe boundaries', () => {
  let tmpDir: string;
  let configDir: string;
  let savedConfigDir: string | undefined;
  let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
  const activeChildren = new Set<ChildProcess>();

  beforeAll(async () => {
    context = await buildMissionProtocolContext();
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s88m08-boundaries-'));
    configDir = path.join(tmpDir, 'config');
    savedConfigDir = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    ProjectGraphRegistry.resetInstance();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    for (const child of activeChildren) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    activeChildren.clear();
    jest.restoreAllMocks();
    ProjectGraphRegistry.resetInstance();
    CmosDetector.resetInstance();
    if (savedConfigDir === undefined) delete process.env.CMOS_CONFIG_DIR;
    else process.env.CMOS_CONFIG_DIR = savedConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeIdentitylessStore(label: string): { projectRoot: string; dbPath: string } {
    const projectRoot = path.join(tmpDir, label);
    const dbPath = seedCmosDb(projectRoot, {
      projectId: '',
      projectName: label,
      cmosAddress: `cmos://test/${label}`,
    });
    const db = new Database(dbPath);
    try {
      db.prepare(
        "DELETE FROM metadata WHERE key IN ('project_id', 'dashboard_slug', 'project_name', 'tracelab_project_id')"
      ).run();
      db.pragma('journal_mode = DELETE');
    } finally {
      db.close();
    }
    CmosDetector.resetInstance();
    return { projectRoot, dbPath };
  }

  function recordedProjectId(dbPath: string): string | null {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as
        | { value: string }
        | undefined;
      const value = row?.value?.trim() ?? '';
      return value.length > 0 ? value : null;
    } finally {
      db.close();
    }
  }

  async function registeredProjectId(projectRoot: string): Promise<string | null> {
    const graph = await ProjectGraphRegistry.create();
    return graph.getByStorePath(projectRoot);
  }

  it('keeps overlapping read/write action modes isolated through their client opens', async () => {
    const readStore = makeIdentitylessStore('overlap-read');
    const writeStore = makeIdentitylessStore('overlap-write');
    const readEntered = deferred<void>();
    const writeEntered = deferred<void>();

    const readCall = captureToolCall('read', async () => {
      readEntered.resolve(undefined);
      await writeEntered.promise;
      expect(currentToolCallActionMode()).toBe('read');
      const created = await CmosDatabaseClient.create({ projectRoot: readStore.projectRoot });
      expect(created.success).toBe(true);
      created.data?.close();
      return true;
    });

    const writeCall = captureToolCall('write', async () => {
      writeEntered.resolve(undefined);
      await readEntered.promise;
      expect(currentToolCallActionMode()).toBe('write');
      const created = await CmosDatabaseClient.create({ projectRoot: writeStore.projectRoot });
      expect(created.success).toBe(true);
      created.data?.close();
      return true;
    });

    const [readCapture, writeCapture] = await Promise.all([readCall, writeCall]);
    expect(readCapture.value).toBe(true);
    expect(writeCapture.value).toBe(true);
    expect(currentToolCallActionMode()).toBeUndefined();
    expect(recordedProjectId(readStore.dbPath)).toBeNull();
    expect(await registeredProjectId(readStore.projectRoot)).toBeNull();
    const writeId = recordedProjectId(writeStore.dbPath);
    expect(writeId).toMatch(UUID_RE);
    expect(await registeredProjectId(writeStore.projectRoot)).toBe(writeId);
  });

  it('does not mint or register sender candidates rejected inside a write request', async () => {
    const rejectedA = makeIdentitylessStore('rejected-a');
    const rejectedB = makeIdentitylessStore('rejected-b');
    const emptyCwd = path.join(tmpDir, 'empty-cwd');
    fs.mkdirSync(emptyCwd);

    const captured = await captureToolCall('write', async () => {
      try {
        await resolveSenderContext({
          mcpRoots: [rejectedA.projectRoot, rejectedB.projectRoot],
          cwdOverride: emptyCwd,
          serverInstallRootOverride: path.join(tmpDir, 'server-install'),
          requireSenderIdentity: true,
        });
        return null;
      } catch (error) {
        return error;
      }
    });

    expect(captured.value).toBeInstanceOf(SenderResolutionError);
    const resolutionError = captured.value as SenderResolutionError;
    expect(
      resolutionError.candidates
        .filter((candidate) => candidate.source === 'mcp-roots')
        .map((candidate) => candidate.projectRoot)
    ).toEqual([rejectedA.projectRoot, rejectedB.projectRoot]);
    expect(recordedProjectId(rejectedA.dbPath)).toBeNull();
    expect(recordedProjectId(rejectedB.dbPath)).toBeNull();
    expect(await registeredProjectId(rejectedA.projectRoot)).toBeNull();
    expect(await registeredProjectId(rejectedB.projectRoot)).toBeNull();
  });

  it('does not mint an identity before rejecting unregister for an unregistered explicit root', async () => {
    const store = makeIdentitylessStore('unregister-missing');

    const result = await executeMissionProtocolTool(
      'cmos_project',
      { action: 'unregister', projectRoot: store.projectRoot },
      context
    );

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as {
      success?: boolean;
      error?: { code?: string };
    };
    expect(structured.success).toBe(false);
    expect(structured.error?.code).toBe('MISSION_NOT_FOUND');
    expect(recordedProjectId(store.dbPath)).toBeNull();
    expect(await registeredProjectId(store.projectRoot)).toBeNull();
  });

  it('makes two process-level first registrations converge on one persisted UUID', async () => {
    const store = makeIdentitylessStore('concurrent-first-writer');
    // Pre-create the shared graph file/schema so this test isolates the project-store identity
    // race. First-open `journal_mode=WAL` contention is a different registry bootstrap concern.
    const bootstrapGraph = await ProjectGraphRegistry.create();
    bootstrapGraph.close();
    ProjectGraphRegistry.resetInstance();
    const releaseFile = path.join(tmpDir, 'release');
    const contenders = [
      startMintContender({
        projectRoot: store.projectRoot,
        configDir,
        readyFile: path.join(tmpDir, 'ready-a'),
        releaseFile,
      }),
      startMintContender({
        projectRoot: store.projectRoot,
        configDir,
        readyFile: path.join(tmpDir, 'ready-b'),
        releaseFile,
      }),
    ];
    contenders.forEach(({ child }) => activeChildren.add(child));

    let returnedIds: string[] | undefined;
    try {
      const prematureExit = Promise.race(
        contenders.map(({ result }) =>
          result.then(
            (projectId) => {
              throw new Error(
                `Registration contender returned ${projectId} before both race barriers opened`
              );
            },
            (error: unknown) => {
              throw error;
            }
          )
        )
      );
      await Promise.race([
        waitForFiles([path.join(tmpDir, 'ready-a'), path.join(tmpDir, 'ready-b')]),
        prematureExit,
      ]);
      fs.writeFileSync(releaseFile, 'release');
      returnedIds = await Promise.all(contenders.map(({ result }) => result));
    } finally {
      if (!fs.existsSync(releaseFile)) fs.writeFileSync(releaseFile, 'release');
      for (const { child } of contenders) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await Promise.allSettled(contenders.map(({ result }) => result));
      contenders.forEach(({ child }) => activeChildren.delete(child));
    }

    const persistedId = recordedProjectId(store.dbPath);
    expect(persistedId).toMatch(UUID_RE);
    expect(returnedIds).toEqual([persistedId, persistedId]);
    expect(await registeredProjectId(store.projectRoot)).toBe(persistedId);
    const graph = await ProjectGraphRegistry.create();
    const rows = graph
      .list()
      .filter(
        (entry: ProjectGraphEntry) =>
          path.resolve(entry.store_path) === path.resolve(store.projectRoot)
      );
    expect(rows).toHaveLength(1);
  });
});
