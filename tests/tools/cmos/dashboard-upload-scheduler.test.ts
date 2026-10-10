// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The upload timer stays detached from initiating requests and never keeps a server alive.
// ABOUTME: Kill-switch/review sessions neither mark debt nor schedule background network work.

import { jest } from '@jest/globals';
jest.mock('../../../src/tools/cmos/checkpoint-backfill', () => ({
  triggerCheckpointBackfill: jest.fn(async () => {}),
}));
import { triggerCheckpointBackfill } from '../../../src/tools/cmos/checkpoint-backfill';
import {
  observeDashboardUploadProject,
  markDashboardUploadOwed,
  __resetDashboardUploadScheduler,
  __drainDashboardUploads,
} from '../../../src/tools/cmos/dashboard-upload-scheduler';
import {
  captureToolCall,
  currentToolCallActionMode,
  recordStoreWrite,
  currentWrittenStores,
} from '../../../src/tools/cmos/tool-call-context';

const trigger = jest.mocked(triggerCheckpointBackfill);
const original = { sync: process.env.CMOS_CHECKPOINT_SYNC, role: process.env.CMOS_AGENT_ROLE };
beforeEach(() => {
  jest.useFakeTimers();
  process.env.CMOS_CHECKPOINT_SYNC = 'on';
  delete process.env.CMOS_AGENT_ROLE;
  trigger.mockClear();
});
afterEach(async () => {
  await __resetDashboardUploadScheduler();
  jest.useRealTimers();
  if (original.sync === undefined) delete process.env.CMOS_CHECKPOINT_SYNC;
  else process.env.CMOS_CHECKPOINT_SYNC = original.sync;
  if (original.role === undefined) delete process.env.CMOS_AGENT_ROLE;
  else process.env.CMOS_AGENT_ROLE = original.role;
});

it('checks on first open and each minute, only once for repeated opens', async () => {
  await observeDashboardUploadProject('/tmp/one');
  await observeDashboardUploadProject('/tmp/one');
  await __drainDashboardUploads();
  expect(trigger).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(60000);
  expect(trigger).toHaveBeenCalledTimes(2);
  expect(trigger).toHaveBeenLastCalledWith({
    projectRoot: '/tmp/one',
    force: false,
    automatic: true,
  });
});

it('drops the initiating request context and its tracked writes', async () => {
  const observed: unknown[] = [];
  trigger.mockImplementation(async () => {
    observed.push([currentToolCallActionMode(), currentWrittenStores()]);
  });
  await captureToolCall('read', async () => {
    recordStoreWrite('/tmp/initiating-store');
    await observeDashboardUploadProject('/tmp/one');
  });
  await __drainDashboardUploads();
  await jest.advanceTimersByTimeAsync(60000);
  expect(observed).toEqual([
    ['write', []],
    ['write', []],
  ]);
});

it.each(['off', 'review'])(
  '%s does not create a timer or open a store to mark it',
  async (guard) => {
    if (guard === 'off') process.env.CMOS_CHECKPOINT_SYNC = 'off';
    else process.env.CMOS_AGENT_ROLE = 'review';
    await observeDashboardUploadProject('/missing/store');
    await markDashboardUploadOwed('/missing/store');
    await jest.advanceTimersByTimeAsync(600000);
    expect(trigger).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  }
);
