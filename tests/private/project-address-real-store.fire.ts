// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves address selection and sibling preservation against a copy of an explicit real store.
// ABOUTME: The private source is never changed and is not required by the public default suite.

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

it('positive fire on a copy of the real store records in the addressed project and preserves sibling snapshot bytes', async () => {
  const repoRoot = process.env.CMOS_ADDRESS_REAL_STORE_ROOT;
  if (!repoRoot) throw new Error('Set CMOS_ADDRESS_REAL_STORE_ROOT to an existing real project.');
  const source = new Database(path.join(repoRoot, 'cmos/db/cmos.sqlite'), { readonly: true });
  try {
    await source.backup(path.join(temp, 'real.sqlite'));
  } finally {
    source.close();
  }
  const root = path.join(temp, 'real');
  fs.mkdirSync(path.join(root, 'cmos/db'), { recursive: true });
  fs.renameSync(path.join(temp, 'real.sqlite'), path.join(root, 'cmos/db/cmos.sqlite'));
  reidentifyCmosTestStore(root);
  const db = new Database(path.join(root, 'cmos/db/cmos.sqlite'));
  const identity = JSON.parse(
    (
      db.prepare("SELECT content FROM contexts WHERE id='project_identity'").get() as {
        content: string;
      }
    ).content
  );
  const address = identity.cmos_address;
  const id = identity.project_id;
  db.close();
  graph.register({ project_id: id, store_path: root, name: 'real copy' });
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
