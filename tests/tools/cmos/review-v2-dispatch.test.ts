// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises v2 review at the real dispatcher with its outer request-local MCP telemetry scope.
// ABOUTME: Legacy machine data stays bounded; presented rule IDs remain local to successful requests.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { readTelemetry, targetForStore } from '../../../src/tools/cmos/local-telemetry';
import { withMcpTelemetry } from '../../../src/tools/cmos/telemetry-call';
import type { CmosReviewResult } from '../../../src/tools/cmos/cmos-review';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { seedCmosDb, reidentifyCmosTestStore } from '../../helpers/seedCmosDb';

let tmp: string;
let root: string;
let dbPath: string;
let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
const previousConfig = process.env.CMOS_CONFIG_DIR;

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-v2-dispatch-'));
  process.env.CMOS_CONFIG_DIR = path.join(tmp, 'config');
  root = path.join(tmp, 'project');
  dbPath = fixture(root, 101);
  CmosDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  CmosDetector.resetInstance();
  if (previousConfig === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = previousConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fixture(project: string, ruleId: number): string {
  const file = seedCmosDb(project, { projectName: `Dispatch ${ruleId}` });
  reidentifyCmosTestStore(project);
  const db = new Database(file);
  try {
    db.exec('ALTER TABLE learnings ADD COLUMN evergreen INTEGER DEFAULT 0');
    const now = new Date().toISOString();
    db.prepare("INSERT INTO constraints(id,content,status,created_at) VALUES(?,?,'active',?)").run(
      ruleId,
      'Keep the project record readable.',
      now
    );
    db.prepare(
      "INSERT INTO learnings(id,content,status,created_at,evergreen) VALUES(?,?,'active',?,1)"
    ).run(
      ruleId,
      'Verify a read against the actual store schema.',
      new Date(Date.now() - 30 * 86400000).toISOString()
    );
    for (let id = 1; id <= 8; id++) {
      db.prepare(
        "INSERT INTO strategic_decisions(id,decision_text,status,created_at) VALUES(?,?,'active',?)"
      ).run(id, `Keep choice ${id} concise.`, new Date(Date.now() - id * 1000).toISOString());
    }
    // Newer learnings push the evergreen rule out of the legacy newest-three list.
    for (let id = 1; id <= 3; id++) {
      db.prepare("INSERT INTO learnings(id,content,status,created_at) VALUES(?,?,'active',?)").run(
        id,
        `Recent learning ${id}.`,
        now
      );
    }
  } finally {
    db.close();
  }
  return file;
}

async function dispatch(project = root) {
  return withMcpTelemetry(
    { name: 'cmos_review', args: { projectRoot: project }, mode: 'read', client: 'test/1' },
    () => executeMissionProtocolTool('cmos_review', { projectRoot: project }, context)
  );
}

it('ships v2 text with legacy structured data and unions real presented IDs into telemetry', async () => {
  const response = await dispatch();
  const result = response.structuredContent as unknown as CmosToolResult<CmosReviewResult>;
  expect(response.isError).not.toBe(true);
  expect(result.success).toBe(true);
  const text = response.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  expect(text).toContain('Rules in force:');
  expect(text).toContain('  • c:101 ');
  expect(text).toContain('  • l:101 ');
  expect(text).not.toContain('Digest size:');
  expect(result.data?.recentDecisions).toHaveLength(5);
  expect(result.data?.recentLearnings.map((item) => item.id)).not.toContain(101);
  expect(result.data).not.toHaveProperty('digest');
  const bytes = Buffer.byteLength(JSON.stringify(result.data));
  expect(bytes).toBeLessThanOrEqual(4096);
  expect(result.data?.digestSizeBytes).toBe(bytes);
  const records = readTelemetry(targetForStore(dbPath)!);
  expect(records).toHaveLength(1);
  expect(records[0].idsReturned).toEqual(expect.arrayContaining(['c:101', 'l:101', 'd:1', 'd:8']));
  expect(new Set(records[0].idsReturned).size).toBe(records[0].idsReturned?.length);
});

it('keeps presented IDs request-local when two real review dispatches overlap', async () => {
  const other = path.join(tmp, 'other');
  const otherDb = fixture(other, 202);
  const responses = await Promise.all([dispatch(root), dispatch(other)]);
  expect(responses.every((response) => response.isError !== true)).toBe(true);
  const first = readTelemetry(targetForStore(dbPath)!);
  const second = readTelemetry(targetForStore(otherDb)!);
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(first[0].idsReturned).toEqual(expect.arrayContaining(['c:101', 'l:101']));
  expect(first[0].idsReturned).not.toContain('c:202');
  expect(second[0].idsReturned).toEqual(expect.arrayContaining(['c:202', 'l:202']));
  expect(second[0].idsReturned).not.toContain('l:101');
});

it('frames foreign recent records while excluding their IDs and foreign binding rules', async () => {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO strategic_decisions(id,decision_text,status,created_at,project_id) VALUES(99,?,'active',?,'foreign-project')"
  ).run('Foreign decision remains visible as data.', now);
  db.prepare(
    "INSERT INTO learnings(id,content,status,created_at,project_id,evergreen) VALUES(99,?,'active',?,'foreign-project',1)"
  ).run('Foreign learning remains visible as data.', now);
  db.prepare(
    "INSERT INTO constraints(id,content,status,created_at,project_id) VALUES(99,?,'active',?,'foreign-project')"
  ).run('Foreign constraint must not bind this project.', now);
  db.close();
  const response = await dispatch();
  expect(response.isError).not.toBe(true);
  const text = response.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  expect(text).toMatch(/d:99[^\n]*⟪untrusted, from proj:foreign-project⟫[^\n]*Foreign decision/);
  expect(text).toMatch(/l:99[^\n]*⟪untrusted, from proj:foreign-project⟫[^\n]*Foreign learning/);
  expect(text).not.toContain('Foreign constraint');
  const record = readTelemetry(targetForStore(dbPath)!)[0];
  expect(record.idsReturned).not.toEqual(expect.arrayContaining(['d:99']));
  expect(record.idsReturned).not.toContain('l:99');
  expect(record.idsReturned).not.toContain('c:99');
});

it('logs no returned IDs when a request fails after the dispatcher supplied its presentation', async () => {
  await expect(
    withMcpTelemetry(
      { name: 'cmos_review', args: { projectRoot: root }, mode: 'read', client: 'test/1' },
      async () => {
        const response = await executeMissionProtocolTool(
          'cmos_review',
          { projectRoot: root },
          context
        );
        expect(response.isError).not.toBe(true);
        throw new Error('post-dispatch failure');
      }
    )
  ).rejects.toThrow('post-dispatch failure');
  expect(readTelemetry(targetForStore(dbPath)!)).toEqual([
    expect.objectContaining({ ok: false, idsReturned: [], refused: 'TOOL_EXECUTION_ERROR' }),
  ]);
  await dispatch();
  expect(readTelemetry(targetForStore(dbPath)!)[1].idsReturned).toContain('c:101');
});
