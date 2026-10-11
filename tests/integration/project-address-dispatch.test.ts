// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Project addresses are resolved before the dispatcher's raw projectRoot consumers run.
// ABOUTME: A real-store write witness verifies that discovery never repairs or opens sibling stores writable.

import type { Server } from '@modelcontextprotocol/server';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { buildMissionProtocolContext, registerToolHandlers } from '../../src/index';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { reidentifyCmosTestStore, seedCmosDb } from '../helpers/seedCmosDb';

type Result = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent: {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string; suggestion?: string };
  };
};
type Call = (request: { params: Record<string, unknown> }) => Promise<Result>;
const ADDRESS = 'cmos://operator/address-target';
const saved = { config: process.env.CMOS_CONFIG_DIR, sync: process.env.CMOS_CHECKPOINT_SYNC };
let temp: string;
let target: string;
let sibling: string;
let graph: ProjectGraphRegistry;
let call: Call;
let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});
beforeEach(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-address-dispatch-'));
  process.env.CMOS_CONFIG_DIR = path.join(temp, 'config');
  process.env.CMOS_CHECKPOINT_SYNC = 'off';
  target = path.join(temp, 'target');
  sibling = path.join(temp, 'sibling');
  seedCmosDb(target, {
    projectName: 'target',
    cmosAddress: ADDRESS,
    dashboardProjectId: '11111111-1111-4111-8111-111111111111',
  });
  seedCmosDb(sibling, { projectName: 'sibling', cmosAddress: 'cmos://unknown/sibling' });
  reidentifyCmosTestStore(target, 'target');
  reidentifyCmosTestStore(sibling, 'sibling');
  ProjectGraphRegistry.resetInstance();
  CmosDetector.resetInstance();
  graph = await ProjectGraphRegistry.create();
  graph.register({ project_id: 'target', store_path: target, name: 'target' });
  graph.register({ project_id: 'sibling', store_path: sibling, name: 'sibling' });
  jest.spyOn(process, 'cwd').mockReturnValue(sibling);
  registerToolHandlers(context, {
    setRequestHandler: (method: string, handler: Call) => {
      if (method === 'tools/call') call = handler;
    },
    setNotificationHandler: () => {},
    getClientCapabilities: () => ({}),
    getClientVersion: () => ({ name: 'address-fixture', version: '1' }),
  } as unknown as Server);
});
afterEach(() => {
  jest.restoreAllMocks();
  ProjectGraphRegistry.resetInstance();
  CmosDetector.resetInstance();
  if (saved.config === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = saved.config;
  if (saved.sync === undefined) delete process.env.CMOS_CHECKPOINT_SYNC;
  else process.env.CMOS_CHECKPOINT_SYNC = saved.sync;
  fs.rmSync(temp, { recursive: true, force: true });
});
function invoke(name: string, args: Record<string, unknown> = {}) {
  return call({ params: { name, arguments: { ...args, projectRoot: ADDRESS } } });
}
function textOf(result: Result): string {
  return result.content.map((item) => item.text ?? '').join('\n');
}
async function snapshotHash(root: string, label: string): Promise<string> {
  const db = new Database(path.join(root, 'cmos/db/cmos.sqlite'), { readonly: true });
  const witness = path.join(temp, `${label}.sqlite`);
  try {
    await db.backup(witness);
  } finally {
    db.close();
  }
  return createHash('sha256').update(fs.readFileSync(witness)).digest('hex');
}

// Pre-edit ten-line census: two roots reads + two caller-named checks (onboard/review),
// whoami roots + resolver, send resolver, explicit message branch, omitted list resolver,
// and project action raw passthrough. These cases drive each category at the MCP boundary.
it.each(['cmos_agent_onboard', 'cmos_review'])(
  '%s treats an address as named and stamps address plus folder',
  async (name) => {
    const result = await invoke(name);
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.data).toMatchObject({
      projectRoot: target,
      resolvedBy: 'explicit',
      projectAddress: ADDRESS,
    });
    expect(textOf(result).split('\n')[0]).toContain(ADDRESS);
    expect(textOf(result).split('\n')[0]).toContain(target);
  }
);
it('whoami resolves the address before diagnostics and includes it in the project line', async () => {
  const result = await invoke('cmos_message', { action: 'whoami' });
  expect(result.structuredContent.success).toBe(true);
  expect(result.structuredContent.data?.resolved).toMatchObject({
    projectRoot: target,
    source: 'explicit',
    cmosAddress: ADDRESS,
  });
  expect(textOf(result).split('\n')[0]).toContain(ADDRESS);
});
it.each(['send', 'list', 'directory'])(
  'message %s refuses a missing address before dashboard access',
  async (action) => {
    const refused = await call({
      params: {
        name: 'cmos_message',
        arguments: { action, projectRoot: 'cmos://operator/missing' },
      },
    });
    expect(refused.structuredContent.error).toMatchObject({ code: 'PROJECT_ADDRESS_UNRESOLVABLE' });
    expect(refused.structuredContent.error?.suggestion).toContain('cmos_project(action="list")');
  }
);
it('send resolves a known address before parameter validation and stamps the selected folder', async () => {
  const result = await invoke('cmos_message', {
    action: 'send',
    targetAddress: 'invalid',
    type: 'question',
    summary: 'fixture',
  });
  expect(result.structuredContent.success).toBe(false);
  expect(textOf(result).split('\n')[0]).toContain(target);
  expect(textOf(result).split('\n')[0]).toContain(ADDRESS);
});
it('message list without an explicit root keeps cwd resolution (the omitted raw resolver site)', async () => {
  const result = await call({ params: { name: 'cmos_message', arguments: { action: 'list' } } });
  expect(textOf(result).split('\n')[0]).toContain(sibling);
});
it.each(['init', 'register', 'unregister'])(
  '%s requires a folder and never interprets an address as a relative path',
  async (action) => {
    const before = graph.list();
    const result = await invoke('cmos_project', { action });
    expect(result.structuredContent.error).toMatchObject({ code: 'PROJECT_FOLDER_REQUIRED' });
    expect(result.structuredContent.error?.suggestion).toMatch(/projectRoot.*folder/);
    expect(graph.list()).toEqual(before);
    expect(fs.existsSync(path.join(sibling, 'cmos:'))).toBe(false);
  }
);
it('project update uses the shared resolver and project list reports raw identities', async () => {
  const updated = await invoke('cmos_project', { action: 'update', projectType: 'general' });
  expect(updated.structuredContent.success).toBe(true);
  expect(updated.structuredContent.data?.projectRoot).toBe(target);
  const listed = await invoke('cmos_project', { action: 'list' });
  expect(listed.structuredContent.data?.projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'target', address: ADDRESS, projectRoot: target }),
    ])
  );
});
it('an addressed write preserves every sibling snapshot and records in the selected store', async () => {
  const root = target;
  const address = ADDRESS;
  const before = await snapshotHash(sibling, 'before');
  const result = await call({
    params: {
      name: 'cmos_decisions',
      arguments: {
        action: 'record',
        projectRoot: address,
        content:
          'Use the exact registered project address because a chat can have no local working folder.',
        mode: 'autonomous',
      },
    },
  });
  expect(result.structuredContent.success).toBe(true);
  expect(result.structuredContent.data?.projectRoot).toBe(root);
  const written = new Database(path.join(root, 'cmos/db/cmos.sqlite'), { readonly: true });
  try {
    expect(
      (
        written
          .prepare('SELECT COUNT(*) AS n FROM strategic_decisions WHERE decision_text = ?')
          .get(
            'Use the exact registered project address because a chat can have no local working folder.'
          ) as { n: number }
      ).n
    ).toBe(1);
  } finally {
    written.close();
  }
  expect(await snapshotHash(sibling, 'after')).toBe(before);
});
