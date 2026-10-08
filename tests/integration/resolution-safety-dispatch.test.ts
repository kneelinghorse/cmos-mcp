// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m01 dispatch-boundary tests on real stores: the clean-room singleton and explicit-root
// ABOUTME: scenarios refuse without touching project A, and every success names the store it used.

/**
 * These drive `executeMissionProtocolTool` — the same entry the MCP CallTool handler uses — against
 * stores created by `cmos_project(init)` itself, with `process.cwd()` pointed at the folder the
 * scenario stands in. Every refusal is checked for its effect on the store it must NOT touch:
 * project A's decision and session rows are counted before and after.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../src/index';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';

type Context = Awaited<ReturnType<typeof buildMissionProtocolContext>>;

interface Structured {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; suggestion?: string };
}

describe('s92-m01 resolution safety at the dispatch boundary', () => {
  let context: Context;
  let tmpDir: string;
  let savedConfigDir: string | undefined;
  let projectA: string;
  let folderB: string;

  beforeAll(async () => {
    context = await buildMissionProtocolContext();
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s92m01-dispatch-'));
    savedConfigDir = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = path.join(tmpDir, 'config');
    ProjectGraphRegistry.resetInstance();
    CmosDetector.resetInstance();

    projectA = path.join(tmpDir, 'project-a');
    folderB = path.join(tmpDir, 'folder-b');
    fs.mkdirSync(projectA);
    fs.mkdirSync(folderB);

    const init = await call('cmos_project', {
      action: 'init',
      projectRoot: projectA,
      projectName: 'Project A',
    });
    expect(init.isError).toBe(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    ProjectGraphRegistry.resetInstance();
    CmosDetector.resetInstance();
    if (savedConfigDir === undefined) delete process.env.CMOS_CONFIG_DIR;
    else process.env.CMOS_CONFIG_DIR = savedConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function call(tool: string, args: Record<string, unknown>) {
    return executeMissionProtocolTool(tool, args, context);
  }

  function structured(result: Awaited<ReturnType<typeof call>>): Structured {
    return result.structuredContent as Structured;
  }

  function textOf(result: Awaited<ReturnType<typeof call>>): string {
    return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  }

  function standIn(dir: string): void {
    jest.restoreAllMocks();
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
  }

  function rowCounts(projectRoot: string): { decisions: number; sessions: number } {
    const db = new Database(path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      return { decisions: count('strategic_decisions'), sessions: count('sessions') };
    } finally {
      db.close();
    }
  }

  it('starts from exactly one registered project — the singleton topology', async () => {
    const graph = await ProjectGraphRegistry.create();
    expect(graph.list().map((row) => row.store_path)).toEqual([path.resolve(projectA)]);
  });

  describe('the clean-room singleton scenario (learning #387)', () => {
    it('refuses a write from uninitialised folder B and leaves project A unchanged', async () => {
      const before = rowCounts(projectA);
      standIn(folderB);

      const record = await call('cmos_decisions', {
        action: 'record',
        content: 'A decision made while standing in folder B',
      });
      const session = await call('cmos_session', {
        action: 'start',
        type: 'custom',
        title: 'Session started in folder B',
      });

      for (const result of [record, session]) {
        expect(result.isError).toBe(true);
        expect(structured(result).error).toMatchObject({
          code: 'CMOS_NOT_DETECTED',
          message: `No CMOS project in '${folderB}'. Nothing was written.`,
        });
        expect(structured(result).error?.suggestion).toContain(
          `cmos_project(action="init", projectRoot=${JSON.stringify(folderB)})`
        );
      }
      expect(rowCounts(projectA)).toEqual(before);
      // Nothing was created in B either: the refusal happens before any store is opened.
      expect(fs.existsSync(path.join(folderB, 'cmos'))).toBe(false);
    });

    it('answers a read from folder B with the labelled no-project answer', async () => {
      standIn(folderB);
      const result = await call('cmos_decisions', { action: 'list' });

      expect(result.isError).toBe(true);
      expect(structured(result).error).toMatchObject({
        code: 'CMOS_NOT_DETECTED',
        message: `No CMOS project in '${folderB}'. There is nothing to read here.`,
      });
    });
  });

  it('refuses projectRoot=B called from cwd A instead of writing A', async () => {
    const before = rowCounts(projectA);
    standIn(projectA);

    const result = await call('cmos_decisions', {
      action: 'record',
      projectRoot: folderB,
      content: 'Meant for B; must never land in A',
    });

    expect(result.isError).toBe(true);
    expect(structured(result).error?.code).toBe('CMOS_NOT_DETECTED');
    expect(rowCounts(projectA)).toEqual(before);
  });

  it('points an explicit subfolder at its enclosing project instead of offering a nested init', async () => {
    const subfolder = path.join(projectA, 'src', 'feature');
    fs.mkdirSync(subfolder, { recursive: true });
    standIn(folderB);

    const result = await call('cmos_decisions', { action: 'list', projectRoot: subfolder });

    expect(structured(result).error).toMatchObject({
      code: 'CMOS_NOT_DETECTED',
      suggestion: `Pass projectRoot=${JSON.stringify(projectA)}.`,
    });
  });

  describe('acrossProjects never moves a write (critic finding, s92-m01 build review)', () => {
    it('refuses a write that names a non-CMOS projectRoot alongside acrossProjects=true', async () => {
      const before = rowCounts(projectA);
      standIn(projectA);

      const record = await call('cmos_decisions', {
        action: 'record',
        projectRoot: folderB,
        acrossProjects: true,
        content: 'Must not land in project A',
      });
      expect(record.isError).toBe(true);
      expect(structured(record).error?.code).toBe('CMOS_NOT_DETECTED');
      expect(rowCounts(projectA)).toEqual(before);
    });

    it('writes to the named project, not the cwd project, when acrossProjects=true is passed', async () => {
      const projectC = path.join(tmpDir, 'project-c');
      fs.mkdirSync(projectC);
      expect(
        (await call('cmos_project', { action: 'init', projectRoot: projectC, projectName: 'C' }))
          .isError
      ).toBe(false);
      const beforeA = rowCounts(projectA);
      const beforeC = rowCounts(projectC);
      standIn(projectA);

      const record = await call('cmos_decisions', {
        action: 'record',
        projectRoot: projectC,
        acrossProjects: true,
        content: 'Belongs to project C',
      });
      expect(record.isError).toBe(false);
      expect(structured(record).data).toMatchObject({
        projectRoot: path.resolve(projectC),
        resolvedBy: 'explicit',
      });
      expect(rowCounts(projectA)).toEqual(beforeA);
      expect(rowCounts(projectC).decisions).toBe(beforeC.decisions + 1);
    });

    it('still serves the portfolio read from a folder that is not a project', async () => {
      standIn(folderB);
      const portfolio = await call('cmos_decisions', { action: 'list', acrossProjects: true });
      expect(portfolio.isError).toBe(false);
      expect(structured(portfolio).data).toMatchObject({ projectRoot: null, resolvedBy: 'none' });
    });
  });

  describe('a folder named cmos inside a project is not a project (critic finding)', () => {
    it('resolves a cwd inside a source tree with its own cmos/ folder to the enclosing project', async () => {
      const sourceTree = path.join(projectA, 'src', 'tools');
      fs.mkdirSync(path.join(sourceTree, 'cmos'), { recursive: true });
      standIn(sourceTree);

      const listed = await call('cmos_decisions', { action: 'list' });
      expect(structured(listed).data).toMatchObject({
        projectRoot: path.resolve(projectA),
        resolvedBy: 'cwd',
      });
    });

    it('answers an explicit source-tree folder with the enclosing project, never an init there', async () => {
      const sourceTree = path.join(projectA, 'src', 'tools');
      fs.mkdirSync(path.join(sourceTree, 'cmos'), { recursive: true });
      standIn(folderB);

      const result = await call('cmos_decisions', { action: 'list', projectRoot: sourceTree });
      expect(structured(result).error).toMatchObject({
        code: 'CMOS_NOT_DETECTED',
        suggestion: `Pass projectRoot=${JSON.stringify(projectA)}.`,
      });
    });
  });

  it('validates an explicit projectRoot on dashboard-only message actions', async () => {
    standIn(projectA);
    const result = await call('cmos_message', { action: 'list', projectRoot: folderB });
    expect(result.isError).toBe(true);
    expect(structured(result).error?.code).toBe('CMOS_NOT_DETECTED');
  });

  describe('every success names the store it touched', () => {
    it('stamps projectRoot and resolvedBy on a representative success from every store-backed tool', async () => {
      standIn(projectA);
      const sprint = await call('cmos_sprint', {
        action: 'add',
        sprintId: 'sprint-1',
        title: 'Stamp sprint',
      });
      expect(sprint.isError).toBe(false);
      const added = await call('cmos_mission', {
        action: 'add',
        missionId: 'm-stamp',
        name: 'Stamp probe',
        sprintId: 'sprint-1',
      });
      expect(added.isError).toBe(false);

      const calls: Array<[string, Record<string, unknown>]> = [
        ['cmos_db', { action: 'health' }],
        ['cmos_mission', { action: 'list' }],
        ['cmos_mission_transition', { action: 'start', missionId: 'm-stamp' }],
        ['cmos_sprint', { action: 'list' }],
        ['cmos_context', { action: 'view' }],
        ['cmos_session', { action: 'list' }],
        ['cmos_decisions', { action: 'list' }],
        ['cmos_learnings', { action: 'list' }],
        ['cmos_feedback', { action: 'list' }],
        ['cmos_status', {}],
        ['cmos_agent_onboard', {}],
        ['cmos_review', {}],
      ];
      for (const [tool, args] of calls) {
        const result = await call(tool, args);
        expect({ tool, isError: result.isError }).toEqual({ tool, isError: false });
        expect({ tool, data: structured(result).data }).toMatchObject({
          tool,
          data: { projectRoot: path.resolve(projectA), resolvedBy: 'cwd' },
        });
        // cwd and explicit are how a caller expects a project to be chosen: no extra line.
        expect(textOf(result)).not.toMatch(/^Project: /);
      }
    });

    it('reports an explicit root as explicit, and a walked-up cwd as cwd', async () => {
      standIn(folderB);
      const explicit = await call('cmos_decisions', { action: 'list', projectRoot: projectA });
      expect(structured(explicit).data).toMatchObject({
        projectRoot: path.resolve(projectA),
        resolvedBy: 'explicit',
      });

      const nested = path.join(projectA, 'docs', 'notes');
      fs.mkdirSync(nested, { recursive: true });
      standIn(nested);
      const walked = await call('cmos_decisions', { action: 'list' });
      expect(structured(walked).data).toMatchObject({
        projectRoot: path.resolve(projectA),
        resolvedBy: 'cwd',
      });
    });

    it('keeps the review digest inside its budget with the stamp inside it', async () => {
      standIn(projectA);
      const result = await call('cmos_review', {});
      const data = structured(result).data as Record<string, unknown>;
      expect(data.digestSizeBytes).toBe(Buffer.byteLength(JSON.stringify(data), 'utf8'));
      expect(data.digestSizeBytes as number).toBeLessThanOrEqual(4096);
    });
  });

  describe('actions that need no project never refuse for lack of one', () => {
    it('lists, validates and prunes the registry from a folder that is not a project', async () => {
      standIn(folderB);
      for (const action of ['list', 'validate', 'prune'] as const) {
        const result = await call('cmos_project', { action });
        expect({ action, isError: result.isError }).toEqual({ action, isError: false });
        expect(structured(result).data).toMatchObject({ projectRoot: null, resolvedBy: 'none' });
      }
    });

    it('runs a user-level auth action project-free instead of refusing for a missing project', async () => {
      standIn(folderB);
      const result = await call('cmos_auth', { action: 'list' });
      // No credential is configured in this isolated store, so the action itself refuses — but
      // for that reason, not because folder B is not a CMOS project.
      expect(structured(result).error?.code).not.toBe('CMOS_NOT_DETECTED');
    });

    it('treats unregister as a literal path: a dead path never unregisters the cwd project', async () => {
      standIn(projectA);
      const result = await call('cmos_project', {
        action: 'unregister',
        projectRoot: path.join(tmpDir, 'deleted-project'),
      });

      expect(result.isError).toBe(true);
      const graph = await ProjectGraphRegistry.create();
      expect(graph.getByStorePath(projectA)).not.toBeNull();
    });
  });
});
