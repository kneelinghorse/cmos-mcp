// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real-store dispatch observations remain once-per-call and scoped under concurrent requests.
// ABOUTME: Refusals and thrown errors still count, while telemetry failures cannot change tool results.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import { withMcpTelemetry, noteTelemetryProject } from '../../../src/tools/cmos/telemetry-call';
import { readTelemetry, targetForStore } from '../../../src/tools/cmos/local-telemetry';

let dir: string;
let project: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-call-telemetry-'));
  project = path.join(dir, 'project');
  dbPath = seedCmosDb(project);
  env = { ...process.env, CMOS_CONFIG_DIR: path.join(dir, 'config') };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it.each([null, 'scalar', 42, ['array']])(
  'preserves SDK v2 structured content %p without assuming an object',
  async (payload) => {
    const result = { structuredContent: payload };
    expect(
      await withMcpTelemetry(
        { name: 'cmos_review', args: { projectRoot: project }, mode: 'read', client: null, env },
        async () => result
      )
    ).toBe(result);
    expect(readTelemetry(targetForStore(dbPath)!, env)).toHaveLength(1);
  }
);

it('records one successful read, including returned typed IDs, without changing the store', async () => {
  const before = fs.readFileSync(dbPath);
  const result = { structuredContent: { success: true, data: { id: 7 } }, isError: false };
  const value = await withMcpTelemetry(
    {
      name: 'cmos_learnings',
      args: { action: 'show', learningId: 7 },
      mode: 'read',
      client: 'codex/1',
      env,
    },
    async () => {
      noteTelemetryProject(project);
      return result;
    }
  );
  expect(value).toBe(result);
  const records = readTelemetry(targetForStore(dbPath)!, env);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    surface: 'mcp',
    mode: 'read',
    ok: true,
    idsReturned: ['l:7'],
    idsCited: ['l:7'],
  });
  expect(fs.readFileSync(dbPath)).toEqual(before);
});

it('records refusal and exception once each and never counts their intended citations', async () => {
  const options = {
    name: 'cmos_decisions',
    args: { projectRoot: project, action: 'record', content: 'private #7' },
    mode: 'write' as const,
    client: 'codex/1',
    env,
  };
  await withMcpTelemetry(options, async () => ({
    isError: true,
    structuredContent: { success: false, error: { code: 'REFUSED' } },
  }));
  const error = new Error('private failure');
  await expect(
    withMcpTelemetry(options, async () => {
      throw error;
    })
  ).rejects.toBe(error);
  const records = readTelemetry(targetForStore(dbPath)!, env);
  expect(records).toHaveLength(2);
  expect(records.map((r) => r.refused)).toEqual(['REFUSED', 'TOOL_EXECUTION_ERROR']);
  expect(records.every((r) => !r.ok && r.idsCited?.length === 0)).toBe(true);
  expect(JSON.stringify(records)).not.toContain('private');
});

it('does not leak a concurrent request target into another project', async () => {
  const other = path.join(dir, 'other');
  const otherDb = seedCmosDb(other);
  const result = { structuredContent: { success: true } };
  await Promise.all(
    [project, other].map((root) =>
      withMcpTelemetry(
        { name: 'cmos_review', args: {}, mode: 'read', client: null, env },
        async () => {
          noteTelemetryProject(root);
          await new Promise((resolve) => setImmediate(resolve));
          return result;
        }
      )
    )
  );
  expect(readTelemetry(targetForStore(dbPath)!, env)).toHaveLength(1);
  expect(readTelemetry(targetForStore(otherDb)!, env)).toHaveLength(1);
});

it('does not change the result when the configured telemetry location is unwritable', async () => {
  const file = path.join(dir, 'not-a-directory');
  fs.writeFileSync(file, 'occupied');
  const result = { structuredContent: { success: true } };
  expect(
    await withMcpTelemetry(
      {
        name: 'cmos_review',
        args: { projectRoot: project },
        mode: 'read',
        client: null,
        env: { CMOS_CONFIG_DIR: file },
      },
      async () => result
    )
  ).toBe(result);
});

it.each([
  ['number', 12345],
  ['object', { private: 'not a folder' }],
  ['array', ['not a folder']],
  ['boolean', true],
])(
  'observes a %s projectRoot without validating or changing the tool response',
  async (_type, projectRoot) => {
    const before = fs.readFileSync(dbPath);
    const result = {
      structuredContent: { success: true, data: { unchanged: 'operation result' } },
    };
    const operation = jest.fn(async () => result);
    const value = await withMcpTelemetry(
      { name: 'cmos_review', args: { projectRoot }, mode: 'read', client: null, env },
      operation
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(value).toBe(result);
    expect(value).toEqual({
      structuredContent: { success: true, data: { unchanged: 'operation result' } },
    });
    expect(readTelemetry(targetForStore(dbPath)!, env)).toEqual([]);
    const anonymous = readTelemetry(
      {
        projectId: 'unattributed',
        dbPath: path.join(env.CMOS_CONFIG_DIR!, 'unattributed.sqlite'),
      },
      env
    );
    expect(anonymous).toEqual([
      expect.objectContaining({ tool: 'cmos_review', ok: true, refused: null }),
    ]);
    expect(fs.readFileSync(dbPath)).toEqual(before);
  }
);
