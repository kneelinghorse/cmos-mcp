// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Verifies CLI and hook telemetry at dispatch, including skipped prompts and failed hooks.
// ABOUTME: Uses real temporary stores and isolated config paths; measurements never change a read's store.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import * as digest from '../../src/cli/digest';
import * as prompt from '../../src/cli/prompt';
import {
  emittedRenderedIds,
  observeCliResult,
  observeRenderedContext,
} from '../../src/cli/telemetry';
import { harnessSessionHash } from '../../src/tools/cmos/harness-session';
import {
  readTelemetry,
  targetForStore,
  type TelemetryRecord,
} from '../../src/tools/cmos/local-telemetry';
import { setExternalSessionOwner } from '../../src/tools/cmos/session-owner';
import { seedCmosDb } from '../helpers/seedCmosDb';

let tmp: string;
let projectRoot: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const savedConfig = process.env.CMOS_CONFIG_DIR;
const rule =
  'Preserve immutable event records during database migrations and verify foreign schema columns';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-cli-telemetry-'));
  projectRoot = path.join(tmp, 'project');
  dbPath = seedCmosDb(projectRoot, { projectId: 'cli-telemetry' });
  env = { ...process.env, CMOS_CONFIG_DIR: path.join(tmp, 'config'), CLAUDE_PROJECT_DIR: '' };
  process.env.CMOS_CONFIG_DIR = env.CMOS_CONFIG_DIR;
  const db = new Database(dbPath);
  db.exec('ALTER TABLE learnings ADD COLUMN evergreen INTEGER DEFAULT 0');
  db.close();
});

afterEach(() => {
  jest.restoreAllMocks();
  setExternalSessionOwner(null);
  if (savedConfig === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function records(): TelemetryRecord[] {
  return readTelemetry({ projectId: 'cli-telemetry', dbPath }, env);
}

async function run(
  argv: string[],
  input: unknown = {},
  overrides: Partial<CliIo> = {}
): Promise<{ code: number; stdout: string; stderr: string[] }> {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env,
    cwd: projectRoot,
    readStdin: async () => (typeof input === 'string' ? input : JSON.stringify(input)),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => {
      stderr.push(line);
    },
    ...overrides,
  };
  return { code: await runCli(argv, io), stdout, stderr };
}

function seedRules(): void {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const constraint = db.prepare(
    'INSERT INTO constraints (id,content,status,created_at,expires_at) VALUES (?,?,?,?,?)'
  );
  constraint.run(1, rule, 'active', now, null);
  constraint.run(2, rule, 'active', now, new Date(Date.now() - 60_000).toISOString());
  constraint.run(3, rule, 'archived', now, null);
  constraint.run(4, rule, 'active', now, new Date(Date.now() + 60_000).toISOString());
  const learning = db.prepare(
    'INSERT INTO learnings (id,content,status,created_at,evergreen) VALUES (?,?,?,?,?)'
  );
  learning.run(1, rule, 'active', now, 1);
  learning.run(2, rule, 'active', now, 0);
  learning.run(3, rule, 'archived', now, 1);
  learning.run(4, rule, 'active', now, null);
  db.close();
}

describe('s93-m04 CLI telemetry', () => {
  it('v2 measures complete owned spans across typed rule namespaces after the actual cap', async () => {
    const first = '  • c:7 A binding constraint cites d:999.';
    const second = '  • l:7 An evergreen learning.';
    const foreign = '  • d:8 A foreign item whose number is not local.';
    const text = `${first}\n${second}\n${foreign}`;
    const context = {
      text,
      returnedIds: ['c:7', 'l:7'],
      items: [
        { typedId: 'c:7', start: 0, end: first.length },
        { typedId: 'l:7', start: first.length + 1, end: first.length + second.length + 1 },
        { typedId: 'd:8', start: first.length + second.length + 2, end: text.length },
      ],
    };
    expect(emittedRenderedIds(context, text)).toEqual(['c:7', 'l:7']);
    expect(emittedRenderedIds(context, text.slice(0, first.length + 12))).toEqual(['c:7']);
    jest.spyOn(digest, 'buildDigest').mockImplementation(async (_root, io) => {
      observeRenderedContext(io, context);
      return text;
    });
    await run(['hook', 'session-start'], { session_id: 'session-a' });
    expect(records()[0]).toMatchObject({
      idsReturned: ['c:7', 'l:7'],
      idsInjected: ['c:7', 'l:7'],
    });
  });
  it('matches prompts before ambient-off skips and reads only active rules in force', async () => {
    seedRules();
    const before = fs.readFileSync(dbPath);
    const text = `Run cmos_review. ${rule}`;
    const result = await run(
      ['hook', 'prompt'],
      { session_id: 'raw-session', prompt: text },
      {
        env: { ...env, CMOS_AMBIENT: 'off' },
      }
    );
    expect(result).toEqual({ code: 0, stdout: '', stderr: [] });
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      surface: 'hook',
      tool: 'hook prompt',
      ambient: 'off',
      ok: true,
      session: `ext:${harnessSessionHash('raw-session')}`,
      procedurePatternIds: ['P02'],
      restatedRuleIds: ['c:1', 'c:4', 'l:1'],
      charsInjected: 0,
    });
    expect(JSON.stringify(records())).not.toContain(text);
    expect(JSON.stringify(records())).not.toContain('raw-session');
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('logs procedure patterns for ceremony commands before downstream skip rules', async () => {
    await run(['hook', 'prompt'], { prompt: '/cmos:close run cmos_review' });
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ ceremony: '/cmos:close', procedurePatternIds: ['P02'] });
  });

  it("does not treat foreign copied active rules as this project's rules in force", async () => {
    seedRules();
    const db = new Database(dbPath);
    db.exec(
      "UPDATE constraints SET project_id = 'foreign-project' WHERE id = 1; UPDATE learnings SET project_id = 'foreign-project' WHERE id = 1"
    );
    db.close();
    await run(['hook', 'prompt'], { prompt: rule });
    expect(records()[0].restatedRuleIds).toEqual(['c:4']);
  });

  it('records a rule-query failure instead of silently reporting no restatement', async () => {
    const db = new Database(dbPath);
    db.exec('DROP TABLE constraints');
    db.close();
    const result = await run(['hook', 'prompt'], { prompt: 'Run cmos_review' });
    expect(result.code).toBe(0);
    expect(result.stderr).toHaveLength(1);
    expect(records()[0]).toMatchObject({ ruleReadFailed: true, procedurePatternIds: ['P02'] });
    const restored = new Database(dbPath);
    restored.exec(
      'CREATE TABLE constraints (id INTEGER, content TEXT, status TEXT, expires_at TEXT)'
    );
    restored.prepare("INSERT INTO constraints VALUES (1, ?, 'active', NULL)").run(rule);
    restored.close();
    await run(['hook', 'prompt'], { prompt: rule });
    expect(records()[1].restatedRuleIds).toEqual(['c:1']);
    expect(records()[1].ruleReadFailed).not.toBe(true);
  });

  it('reports unavailable rule identity instead of silently excluding every scoped row', async () => {
    seedRules();
    const db = new Database(dbPath);
    db.exec('DROP TABLE metadata');
    db.close();
    const result = await run(['hook', 'prompt'], { prompt: rule });
    expect(result.stderr).toEqual([expect.stringContaining('rules in force could not be read')]);
    const unattributed = readTelemetry(
      { projectId: 'unattributed', dbPath: path.join(env.CMOS_CONFIG_DIR!, 'unattributed.sqlite') },
      env
    );
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]).toMatchObject({ ruleReadFailed: true, restatedRuleIds: [] });
  });

  it('records input failure once against the known project', async () => {
    const result = await run(['hook', 'prompt'], '{broken json');
    expect(result.code).toBe(0);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ ok: false, failOpen: 'input', charsInjected: 0 });
  });

  it('records a deadline once and ignores work that resolves after the receipt', async () => {
    let finish!: (value: string | null) => void;
    jest.spyOn(prompt, 'run').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    // Give setup a full deadline: a nearly-expired wall clock could reject before the mocked
    // work starts on a loaded Node20/22 runner, leaving no pending work to resolve below.
    const result = await run(['hook', 'prompt'], { prompt: 'Run cmos_review' });
    expect(result.stdout).toBe('');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ ok: false, failOpen: 'deadline', charsInjected: 0 });
    finish('late text must not be recorded');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(records()).toHaveLength(1);
    expect(records()[0].charsInjected).toBe(0);
  });

  it('hashes and counts the actual capped context, not JSON framing or its uncut source', async () => {
    jest.spyOn(digest, 'buildDigest').mockResolvedValue('long-line '.repeat(1000));
    const result = await run(['hook', 'session-start'], { session_id: 'session-a' });
    const emitted = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    expect(emitted.length).toBeLessThanOrEqual(6000);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      charsInjected: emitted.length,
      digestHash: createHash('sha256').update(emitted).digest('hex'),
    });
  });

  it('keeps digest IDs typed and excludes a learning cut out of the emitted context', async () => {
    jest.spyOn(digest, 'buildDigest').mockImplementation(async (_root, io) => {
      observeCliResult(
        io,
        'cmos_review',
        {},
        {
          success: true,
          data: { recentDecisions: [{ id: 7 }], recentLearnings: [{ id: 7 }] },
        }
      );
      return (
        'Recent decisions:\n  • #7 cites unrelated #999\n\n' +
        'padding '.repeat(800) +
        '\nRecent learnings:\n  • #7 learned\n'
      );
    });
    await run(['hook', 'session-start'], { session_id: 'session-a' });
    expect(records()[0]).toMatchObject({ idsReturned: ['d:7', 'l:7'], idsInjected: ['d:7'] });
  });

  it('observes actual review decision and learning rows with colliding numeric IDs', async () => {
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO strategic_decisions (id, decision_text, created_at, status) VALUES (1, ?, ?, 'active')"
    ).run('A concrete recent decision', now);
    db.prepare(
      "INSERT INTO learnings (id, content, created_at, status) VALUES (1, ?, ?, 'active')"
    ).run('A concrete recent learning', now);
    db.close();
    const result = await run(['review', '--format=context']);
    expect(result.code).toBe(0);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      idsReturned: ['d:1', 'l:1'],
      idsInjected: ['d:1', 'l:1'],
    });
  });

  it('keeps foreign relevant rows visible while measuring only local or NULL-provenance IDs', async () => {
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    for (const [id, project] of [
      [1, 'cli-telemetry'],
      [2, null],
      [3, 'foreign-project'],
    ] as const) {
      db.prepare(
        "INSERT INTO strategic_decisions (id, decision_text, created_at, status, project_id) VALUES (?, 'SQLite record', ?, 'active', ?)"
      ).run(id, now, project);
      db.prepare(
        "INSERT INTO learnings (id, content, created_at, status, project_id) VALUES (?, 'SQLite record', ?, 'active', ?)"
      ).run(id, now, project);
    }
    db.exec(
      'CREATE VIRTUAL TABLE learnings_fts USING fts5(content); INSERT INTO learnings_fts(rowid, content) SELECT id, content FROM learnings'
    );
    db.close();
    const before = fs.readFileSync(dbPath);
    const result = await run([
      'relevant',
      '--query',
      'sqlite',
      '--limit',
      '20',
      '--format',
      'json',
    ]);
    expect(result.code).toBe(0);
    const shown = JSON.parse(result.stdout).items as Array<{ kind: string; id: number }>;
    expect(shown).toHaveLength(6);
    expect(shown.filter((item) => item.id === 3)).toHaveLength(2);
    expect(records()).toHaveLength(1);
    expect(records()[0].idsReturned?.slice().sort()).toEqual(['d:1', 'd:2', 'l:1', 'l:2']);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it.each(['stop', 'pre-compact', 'session-end'])(
    'records silent hook %s exactly once without claiming injection',
    async (event) => {
      const result = await run(['hook', event], { session_id: 'session-a' });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({
        tool: `hook ${event}`,
        charsInjected: 0,
        idsInjected: [],
      });
    }
  );

  it('records successful CLI captures, explicit citations, and refused commands once each', async () => {
    const captured = await run([
      'capture',
      '--session-id',
      'session-a',
      '--category',
      'context',
      '--content',
      'Apply learning #41 and decision #52.',
    ]);
    expect(captured.code).toBe(0);
    const refused = await run(['capture', '--category', 'context', '--content', 'No session']);
    expect(refused.code).toBe(1);
    expect(records()).toHaveLength(2);
    expect(records()[0]).toMatchObject({
      surface: 'cli',
      tool: 'capture',
      mode: 'write',
      ok: true,
      idsCited: ['l:41', 'd:52'],
      session: `ext:${harnessSessionHash('session-a')}`,
    });
    expect(records()[1]).toMatchObject({ ok: false, refused: 'CLI_REFUSED' });
  });

  it('keeps an unattributed typo out of project measurements', async () => {
    await run(['unknown-verb'], {}, { cwd: tmp });
    expect(records()).toEqual([]);
    const unattributed = readTelemetry(
      { projectId: 'unattributed', dbPath: path.join(env.CMOS_CONFIG_DIR!, 'unattributed.sqlite') },
      env
    );
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]).toMatchObject({ tool: 'unknown-verb', ok: false });
  });

  it('attributes a successful init to the store it created', async () => {
    const fresh = path.join(tmp, 'fresh-project');
    fs.mkdirSync(fresh);
    const result = await run(['init', '--project-root', fresh, '--no-hooks']);
    expect(result.code).toBe(0);
    const target = targetForStore(path.join(fresh, 'cmos', 'db', 'cmos.sqlite'));
    expect(target).not.toBeNull();
    expect(readTelemetry(target!, env)).toEqual([
      expect.objectContaining({ tool: 'init', ok: true }),
    ]);
  });
});
