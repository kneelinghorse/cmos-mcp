// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves address selection and sibling preservation against a copy of an explicit real store.
// ABOUTME: The private source is never changed and is not required by the public default suite.

import { resolveRecordPaths } from '../../src/intelligence/legacy-compat';
import type { Server } from '@modelcontextprotocol/server';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { buildMissionProtocolContext, registerToolHandlers } from '../../src/index';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';

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
const ADDRESS = 'rbook://operator/address-target';
const saved = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };
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
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-address-dispatch-'));
  process.env.RBOOK_CONFIG_DIR = path.join(temp, 'config');
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  target = path.join(temp, 'target');
  sibling = path.join(temp, 'sibling');
  seedRbookDb(target, {
    projectName: 'target',
    rbookAddress: ADDRESS,
    dashboardProjectId: '11111111-1111-4111-8111-111111111111',
  });
  seedRbookDb(sibling, { projectName: 'sibling', rbookAddress: 'rbook://unknown/sibling' });
  reidentifyRbookTestStore(target, 'target');
  reidentifyRbookTestStore(sibling, 'sibling');
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
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
  RbookDetector.resetInstance();
  if (saved.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = saved.config;
  if (saved.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = saved.sync;
  fs.rmSync(temp, { recursive: true, force: true });
});
async function snapshotHash(root: string, label: string): Promise<string> {
  const db = new Database(path.join(root, 'rbook/db/rbook.sqlite'), { readonly: true });
  const witness = path.join(temp, `${label}.sqlite`);
  try {
    await db.backup(witness);
  } finally {
    db.close();
  }
  return createHash('sha256').update(fs.readFileSync(witness)).digest('hex');
}

it('positive fire on a copy of the real store records in the addressed project and preserves sibling snapshot bytes', async () => {
  const repoRoot = process.env.RBOOK_ADDRESS_REAL_STORE_ROOT;
  if (!repoRoot) throw new Error('Set RBOOK_ADDRESS_REAL_STORE_ROOT to an existing real project.');
  const source = new Database(resolveRecordPaths(repoRoot).dbPath, { readonly: true });
  try {
    await source.backup(path.join(temp, 'real.sqlite'));
  } finally {
    source.close();
  }
  const root = path.join(temp, 'real');
  fs.mkdirSync(path.join(root, 'rbook/db'), { recursive: true });
  fs.renameSync(path.join(temp, 'real.sqlite'), path.join(root, 'rbook/db/rbook.sqlite'));
  reidentifyRbookTestStore(root);
  const db = new Database(path.join(root, 'rbook/db/rbook.sqlite'));
  const identity = JSON.parse(
    (
      db.prepare("SELECT content FROM contexts WHERE id='project_identity'").get() as {
        content: string;
      }
    ).content
  );
  const address = identity.rbook_address;
  const id = identity.project_id;
  db.close();
  graph.register({ project_id: id, store_path: root, name: 'real copy' });
  const before = await snapshotHash(sibling, 'before');
  const result = await call({
    params: {
      name: 'rbook_decisions',
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
  const written = new Database(path.join(root, 'rbook/db/rbook.sqlite'), { readonly: true });
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
