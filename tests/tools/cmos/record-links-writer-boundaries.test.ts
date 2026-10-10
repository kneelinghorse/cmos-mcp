// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Required link writes cross the real MCP boundary and operate on a private store backup.
// ABOUTME: Explicit roots and failure controls preserve captures while old stores migrate on writes.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { fork } from 'child_process';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { cmosSessionCapture } from '../../../src/tools/cmos/cmos-session-capture';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import {
  createSeededCmosProject,
  reidentifyCmosTestStore,
  type SeededCmosProject,
} from '../../helpers/seedCmosDb';

jest.mock('../../../src/intelligence/embedding-pipeline', () => ({
  ...jest.requireActual('../../../src/intelligence/embedding-pipeline'),
  recordEmbedding: jest.fn(async () => ({ success: true, warnings: [] })),
}));

function seedRows(dbPath: string, projectId: string): { target: number; session: string } {
  const db = new Database(dbPath);
  const session = `links-${randomUUID()}`;
  try {
    const target = Number(
      db
        .prepare(
          `INSERT INTO strategic_decisions(decision_text,created_at,project_id,stable_event_id,occurred_at,origin_seq,event_type,schema_version)
      VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(origin_seq),0)+1 FROM strategic_decisions),'decision_captured',1)`
        )
        .run(
          'A prior local decision for the real writer.',
          new Date(Date.now() - 60_000).toISOString(),
          projectId,
          randomUUID(),
          Date.now() - 60_000
        ).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO sessions(id,type,title,started_at,status,project_id,stable_event_id,occurred_at,origin_seq,event_type,schema_version)
      VALUES (?,'build','Citation writer',?,'active',?,?,?,(SELECT COALESCE(MAX(origin_seq),0)+1 FROM sessions),'session_started',1)`
    ).run(
      session,
      new Date(Date.now() - 30_000).toISOString(),
      projectId,
      randomUUID(),
      Date.now() - 30_000
    );
    return { target, session };
  } finally {
    db.close();
  }
}

describe('actual MCP citation writer boundary', () => {
  let project: SeededCmosProject;
  let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
  let previous: string | undefined;
  beforeAll(async () => {
    context = await buildMissionProtocolContext();
  });
  beforeEach(async () => {
    previous = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    project = await createSeededCmosProject(
      { projectId: 'links-dispatch' },
      'cmos-links-dispatch-'
    );
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous;
    await project.cleanup();
  });

  it('materializes learning capture through real dispatch with an explicit root and no ambient root', async () => {
    const { target, session } = seedRows(project.dbPath, 'links-dispatch');
    const result = await executeMissionProtocolTool(
      'cmos_session',
      {
        action: 'capture',
        category: 'learning',
        sessionId: session,
        content: `d:${target} explains the prior design.`,
        projectRoot: project.projectRoot,
      },
      context
    );
    expect(result.isError).not.toBe(true);
    const db = new Database(project.dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT from_kind,to_kind,to_id FROM record_links').all()).toEqual([
        { from_kind: 'learning', to_kind: 'decision', to_id: target },
      ]);
    } finally {
      db.close();
    }
  });

  it.each(['record', 'update', 'session complete', 'mission complete'])(
    '%s persists required links through the actual dispatcher',
    async (route) => {
      const { target, session } = seedRows(project.dbPath, 'links-dispatch');
      const db = new Database(project.dbPath);
      let source: number | undefined;
      try {
        if (route === 'update') {
          source = Number(
            db
              .prepare('INSERT INTO strategic_decisions(decision_text,created_at) VALUES (?,?)')
              .run(`d:${target} needs stored repair.`, new Date().toISOString()).lastInsertRowid
          );
        }
        if (route === 'mission complete')
          db.exec(
            "INSERT INTO missions(id,name,status) VALUES ('dispatch-mission','Dispatch mission','In Progress')"
          );
      } finally {
        db.close();
      }
      const content = `d:${target} supplies the dispatch citation.`;
      const tool =
        route === 'record' || route === 'update'
          ? 'cmos_decisions'
          : route === 'session complete'
            ? 'cmos_session'
            : 'cmos_mission_transition';
      const params =
        route === 'record'
          ? { action: 'record', content }
          : route === 'update'
            ? { action: 'update', decisionId: source }
            : route === 'session complete'
              ? {
                  action: 'complete',
                  sessionId: session,
                  summary: 'Dispatch close.',
                  decisions: [content],
                }
              : {
                  action: 'complete',
                  missionId: 'dispatch-mission',
                  notes: 'Dispatch mission close.',
                  decisions: [content],
                };
      const result = await executeMissionProtocolTool(
        tool,
        { ...params, projectRoot: project.projectRoot },
        context
      );
      expect(result.isError).not.toBe(true);
      const after = new Database(project.dbPath, { readonly: true });
      try {
        expect(after.prepare('SELECT from_kind,to_kind,to_id FROM record_links').all()).toEqual([
          { from_kind: 'decision', to_kind: 'decision', to_id: target },
        ]);
      } finally {
        after.close();
      }
    }
  );

  it('returns a refusal across dispatch when the required link write fails, preserving session captures', async () => {
    const { target, session } = seedRows(project.dbPath, 'links-dispatch');
    const invoke = (content: string) =>
      executeMissionProtocolTool(
        'cmos_session',
        {
          action: 'capture',
          category: 'decision',
          sessionId: session,
          content,
          projectRoot: project.projectRoot,
        },
        context
      );
    expect((await invoke('Prepare the citation schema.')).isError).not.toBe(true);
    const db = new Database(project.dbPath);
    const before = db.prepare('SELECT captures FROM sessions WHERE id=?').get(session);
    db.exec(
      "CREATE TRIGGER reject_dispatch_links BEFORE INSERT ON record_links BEGIN SELECT RAISE(FAIL,'dispatch citation failure'); END"
    );
    db.close();
    const result = await invoke(`d:${target} cannot commit with a broken required link.`);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('dispatch citation failure');
    const after = new Database(project.dbPath, { readonly: true });
    try {
      expect(after.prepare('SELECT captures FROM sessions WHERE id=?').get(session)).toEqual(
        before
      );
    } finally {
      after.close();
    }
  });

  it('a competing process cannot make a capture overwrite another committed append', async () => {
    const { target, session } = seedRows(project.dbPath, 'links-dispatch');
    expect(
      (
        await cmosSessionCapture({
          projectRoot: project.projectRoot,
          sessionId: session,
          category: 'context',
          content: 'Existing capture.',
        })
      ).success
    ).toBe(true);
    const worker = path.join(project.projectRoot, 'capture-lock.cjs');
    fs.writeFileSync(
      worker,
      `
      const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const db=new Database(process.argv[2]);
      db.exec('BEGIN IMMEDIATE');
      const row=db.prepare('SELECT captures FROM sessions WHERE id=?').get(process.argv[3]);
      const captures=JSON.parse(row.captures); captures.push({category:'context',content:'Competing committed capture.'});
      db.prepare('UPDATE sessions SET captures=? WHERE id=?').run(JSON.stringify(captures),process.argv[3]);
      process.send('locked');
      setTimeout(()=>{db.exec('COMMIT');db.close();process.exit(0)},500);
    `
    );
    const child = fork(worker, [project.dbPath, session], { silent: true });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Capture lock worker failed'))
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('message', () => resolve());
      });
      const params = {
        projectRoot: project.projectRoot,
        sessionId: session,
        category: 'decision' as const,
        content: `d:${target} preserves both capture histories.`,
      };
      const first = await cmosSessionCapture(params);
      await exited;
      if (!first.success) expect((await cmosSessionCapture(params)).success).toBe(true);
      const db = new Database(project.dbPath, { readonly: true });
      try {
        const row = db.prepare('SELECT captures FROM sessions WHERE id=?').get(session) as {
          captures: string;
        };
        const contents = (JSON.parse(row.captures) as { content: string }[]).map(
          (capture) => capture.content
        );
        expect(contents).toEqual([
          'Existing capture.',
          'Competing committed capture.',
          params.content,
        ]);
      } finally {
        db.close();
      }
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
});

const PRIVATE = requiresPrivateEvidence({
  reason: 'Citation positive fire uses a temporary backup of the private CMOS store.',
  paths: { source: 'cmos/db/cmos.sqlite' },
});
PRIVATE.describe('private real-store citation writer positive fire', () => {
  it('migrates and captures a local citation on a consistent disposable backup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-links-real-'));
    const dbPath = path.join(root, 'cmos/db/cmos.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    try {
      const source = new Database(PRIVATE.paths.source, { readonly: true, fileMustExist: true });
      try {
        await source.backup(dbPath);
      } finally {
        source.close();
      }
      reidentifyCmosTestStore(root, 'links-real-copy');
      CmosDetector.resetInstance();
      const { target, session } = seedRows(dbPath, 'links-real-copy');
      const result = await cmosSessionCapture({
        projectRoot: root,
        sessionId: session,
        category: 'decision',
        content: `d:${target} is the real-copy positive citation.`,
      });
      expect(result.success).toBe(true);
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(
          db.prepare("SELECT value FROM metadata WHERE key='record_links_schema'").get()
        ).toEqual({ value: '1' });
        expect(
          db
            .prepare(
              "SELECT to_kind,to_id FROM record_links WHERE from_kind='decision' AND from_id=?"
            )
            .all(result.data!.decisionId)
        ).toEqual([{ to_kind: 'decision', to_id: target }]);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      CmosDetector.resetInstance();
    }
  });
});
