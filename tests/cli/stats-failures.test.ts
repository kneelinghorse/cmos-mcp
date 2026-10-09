// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Stats remains read-only and reports unavailable evidence on foreign schemas and held stores.
// ABOUTME: Real cross-process SQLite locks and NULL values cannot become clean counts or a passing gate.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runStats } from '../../src/cli/stats';
import {
  appendTelemetry,
  targetForStore,
  telemetryDir,
} from '../../src/tools/cmos/local-telemetry';
import { collectTelemetryStats, exportTelemetryStats } from '../../src/tools/cmos/telemetry-stats';
import { seedCmosDb } from '../helpers/seedCmosDb';

let tmp: string;
let root: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const window = () => {
  const now = Date.now();
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  return { since: at(14), until: at(0), baselineSince: at(45), baselineUntil: at(15) };
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-stats-failures-'));
  root = path.join(tmp, 'project');
  dbPath = seedCmosDb(root);
  env = { CMOS_CONFIG_DIR: path.join(tmp, 'config') };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('stats unavailable evidence', () => {
  it('does not report a held database as empty and releases every reader for a later retry', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const D=require('better-sqlite3');const db=new D(process.argv[1]);db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');process.send('held');setInterval(()=>{},1000);",
        dbPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    );
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', () => reject(new Error(stderr || 'Lock holder exited')));
      });
      const report = await collectTelemetryStats([root], window(), env);
      expect(report.projects[0].store.timing).toBeNull();
      expect(report.projects[0].store.warnings.length).toBeGreaterThan(0);
      expect(report.timing.passed).toBeNull();
    } finally {
      child.kill();
      await closed;
    }
    expect(
      (await collectTelemetryStats([root], window(), env)).projects[0].store.timing
    ).not.toBeNull();
  });

  it.each(['readable', 'unreadable'])(
    'keeps a NULL completion unavailable with a linked %s decision timestamp and never migrates foreign tables',
    async (decisionTime) => {
      const db = new Database(dbPath);
      try {
        db.exec(
          "INSERT INTO missions (id,name,status,completed_at) VALUES ('undated','no time','Completed',NULL); DROP TABLE learnings;"
        );
        db.prepare(
          'INSERT INTO strategic_decisions (decision_text,mission_id,created_at) VALUES (?,?,?)'
        ).run(
          'Potentially qualifying decision',
          'undated',
          decisionTime === 'readable' ? new Date(Date.now() - 1000).toISOString() : 'unreadable'
        );
      } finally {
        db.close();
      }
      const before = fs.readFileSync(dbPath);
      const report = await collectTelemetryStats([root], window(), env);
      expect(report.projects[0].store.timing).toBeNull();
      expect(report.projects[0].store.staleness).toBeNull();
      expect(
        report.projects[0].store.warnings.some((warning) => warning.includes('completion times'))
      ).toBe(true);
      expect(fs.readFileSync(dbPath)).toEqual(before);
    }
  );

  it('keeps a qualified timing cohort readable when legacy undated missions have no decisions', async () => {
    const db = new Database(dbPath);
    try {
      db.exec(
        "INSERT INTO missions (id,name,status,completed_at) VALUES ('legacy','no decisions','Completed',NULL);"
      );
      const mission = db.prepare(
        'INSERT INTO missions (id,name,status,completed_at) VALUES (?,?,?,?)'
      );
      const decision = db.prepare(
        'INSERT INTO strategic_decisions (decision_text,mission_id,created_at) VALUES (?,?,?)'
      );
      const now = Date.now();
      for (const [period, ageDays] of [
        ['baseline', 30],
        ['window', 1],
      ] as const) {
        const completed = now - ageDays * 86_400_000;
        for (let i = 0; i < 15; i++) {
          const id = `${period}-${i}`;
          mission.run(id, id, 'Completed', new Date(completed).toISOString());
          decision.run(
            `Decision for ${id}`,
            id,
            new Date(completed - (period === 'window' ? 300_000 : 0)).toISOString()
          );
        }
      }
    } finally {
      db.close();
    }
    const before = fs.readFileSync(dbPath);
    const report = await collectTelemetryStats([root], window(), env);
    expect(report.timing).toMatchObject({
      readableProjects: 1,
      excludedProjects: 0,
      baseline: { qualified: 15, endLoaded: 15 },
      window: { qualified: 15, endLoaded: 0 },
      passed: true,
    });
    expect(
      report.projects[0].store.warnings.filter((warning) => warning.startsWith('decision timing'))
    ).toEqual([]);
    expect(fs.readFileSync(dbPath)).toEqual(before);
  });

  it('accepts an explicit project without project environment variables and exports no human diagnostics', async () => {
    let stdout = '';
    const stderr: string[] = [];
    const code = await runStats(['--export', '--project-root', root], {
      cwd: tmp,
      env,
      readStdin: async () => '',
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr.push(text);
      },
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout).projects).toBe(1);
    expect(stdout).not.toContain(root);
    expect(stdout).not.toContain('missing id');
  });

  it('reports corrupt event evidence and excludes failed rule reads from the restatement denominator', async () => {
    const target = targetForStore(dbPath)!;
    appendTelemetry(
      {
        ts: new Date(Date.now() - 1000).toISOString(),
        session: 'a'.repeat(16),
        surface: 'hook',
        client: 'test',
        tool: 'hook prompt',
        action: null,
        mode: 'read',
        ok: true,
        refused: null,
        failOpen: null,
        ambient: 'on',
        procedurePatternIds: [],
        restatedRuleIds: [],
        ruleReadFailed: true,
      },
      target,
      env
    );
    const dir = telemetryDir(target, env);
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    fs.appendFileSync(file, '{torn private record content\n');
    const report = await collectTelemetryStats([root], window(), env);
    expect(report.projects[0].telemetry.warnings.length).toBeGreaterThan(0);
    expect(report.events.restatement).toMatchObject({
      measuredPrompts: 0,
      unmeasuredPrompts: 1,
      per100: null,
    });
    const exported = JSON.stringify(exportTelemetryStats(report));
    expect(exported).not.toContain('private record content');
    expect(exported).not.toContain('a'.repeat(16));
    expect(exported).not.toContain(root);
  });
});
