// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Dashboard upload debt follows real MCP writes, including writes after first-store upkeep.
// ABOUTME: Status and review disclose the same project-local upload receipt without changing data contracts.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../../src/tools/rbook/dashboard-upload-scheduler', () => ({
  observeDashboardUploadProject: jest.fn(async () => undefined),
  markDashboardUploadOwed: jest.fn(async () => undefined),
  readDashboardUploadStatus: jest.fn(async () => null),
}));

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { rbookStatus, formatStatusForLLM } from '../../../src/tools/rbook/rbook-status';
import * as uploadScheduler from '../../../src/tools/rbook/dashboard-upload-scheduler';
import {
  resetFirstWriteMaintenance,
  storeNeedsFirstWriteMaintenance,
} from '../../../src/tools/rbook/first-write-maintenance';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const uploads = jest.mocked(uploadScheduler);

let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
let root: string;
let config: string | undefined;
let sync: string | undefined;
let role: string | undefined;

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-dispatch-'));
  seedRbookDb(root, { projectName: 'Upload dispatch' });
  reidentifyRbookTestStore(root);
  config = process.env.RBOOK_CONFIG_DIR;
  sync = process.env.RBOOK_CHECKPOINT_SYNC;
  role = process.env.RBOOK_AGENT_ROLE;
  process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
  process.env.RBOOK_CHECKPOINT_SYNC = 'on';
  delete process.env.RBOOK_AGENT_ROLE;
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  resetFirstWriteMaintenance();
  jest.clearAllMocks();
  uploads.readDashboardUploadStatus.mockResolvedValue(null);
});

afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  resetFirstWriteMaintenance();
  for (const [key, value] of Object.entries({
    RBOOK_CONFIG_DIR: config,
    RBOOK_CHECKPOINT_SYNC: sync,
    RBOOK_AGENT_ROLE: role,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const dispatch = (tool: string, args: Record<string, unknown> = {}) =>
  executeMissionProtocolTool(tool, { ...args, projectRoot: root }, context);
const textOf = (result: Awaited<ReturnType<typeof dispatch>>): string =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
const capture = (content: string) =>
  dispatch('rbook_session', { action: 'capture', category: 'context', content });

it('observes the resolved project even on a read so a surviving process can pay prior upload debt', async () => {
  const result = await dispatch('rbook_review');
  expect(result.isError).not.toBe(true);
  expect(uploads.observeDashboardUploadProject).toHaveBeenCalledWith(root);
  expect(uploads.markDashboardUploadOwed).not.toHaveBeenCalled();
});

it('marks every real write, including the second write after first-store upkeep is complete', async () => {
  expect((await capture('First real write.')).isError).not.toBe(true);
  expect(storeNeedsFirstWriteMaintenance(root)).toBe(false);
  expect((await capture('A later real write.')).isError).not.toBe(true);
  expect(uploads.markDashboardUploadOwed.mock.calls).toEqual([[root], [root]]);
});

it('overlapping writes mark their own resolved stores once, never a server or registry default', async () => {
  const other = path.join(root, 'other');
  seedRbookDb(other, { projectName: 'Other upload dispatch' });
  reidentifyRbookTestStore(other);
  const results = await Promise.all([
    capture('Write for the first project.'),
    executeMissionProtocolTool(
      'rbook_session',
      {
        action: 'capture',
        category: 'context',
        content: 'Write for the other project.',
        projectRoot: other,
      },
      context
    ),
  ]);
  expect(results.every((result) => result.isError !== true)).toBe(true);
  expect(uploads.markDashboardUploadOwed.mock.calls.map(([project]) => project).sort()).toEqual(
    [root, other].sort()
  );
});

it.each([
  ['read', 'rbook_review', {}],
  ['write-classified report', 'rbook_sprint', { action: 'analytics' }],
  ['refusal', 'rbook_decisions', { action: 'update', status: 'archived' }],
  ['onboard', 'rbook_agent_onboard', {}],
  ['onboard feedback', 'rbook_agent_onboard', { agentFeedback: 'The opener is useful.' }],
] as const)('%s creates no upload debt', async (_label, tool, args) => {
  await dispatch(tool, args);
  expect(uploads.markDashboardUploadOwed).not.toHaveBeenCalled();
});

it('a disabled sync leaves a real local write successful without scheduling uploads', async () => {
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  expect((await capture('Local-only write.')).isError).not.toBe(true);
  expect(uploads.markDashboardUploadOwed).not.toHaveBeenCalled();
});

it('the review role refuses a write before it creates upload debt', async () => {
  process.env.RBOOK_AGENT_ROLE = 'review';
  const result = await capture('A review must not write.');
  expect(result.isError).toBe(true);
  expect(uploads.markDashboardUploadOwed).not.toHaveBeenCalled();
});

it('status carries the upload receipt in warnings and text while keeping the five-field data contract', async () => {
  const line = 'Dashboard upload: failed; HTTP 403; automatic uploads paused.';
  uploads.readDashboardUploadStatus.mockResolvedValue(line);
  const result = await rbookStatus({ projectRoot: root });
  expect(result.success).toBe(true);
  expect(uploads.readDashboardUploadStatus).toHaveBeenCalledWith(root);
  expect(result.warnings).toContain(line);
  expect(formatStatusForLLM(result)).toContain(line);
  expect(Object.keys(result.data!).sort()).toEqual([
    'auth_tier',
    'dashboard_url',
    'last_delivery_observed_at',
    'last_sync_at',
    'rbook_address',
  ]);
});

it('review carries the same receipt without adding mutable upload state to its stable local digest', async () => {
  const line = `Dashboard upload: succeeded at ${new Date().toISOString()}.`;
  uploads.readDashboardUploadStatus.mockResolvedValue(line);
  const result = await dispatch('rbook_review');
  expect(result.isError).not.toBe(true);
  expect(uploads.readDashboardUploadStatus).toHaveBeenCalledWith(root);
  expect(result.structuredContent).toEqual(
    expect.objectContaining({ warnings: expect.arrayContaining([line]) })
  );
  expect(textOf(result).split(line)).toHaveLength(2);
  expect(result.structuredContent).not.toHaveProperty('data.dashboardUpload');
});
