// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — recording a draft the operator answered: the record says how the approval was known, and
// ABOUTME: nothing is recorded that the operator did not see, did not answer, declined, or that says something else.

/**
 * The hooks run as in tests/cli/hook-drafts.test.ts (in process, through runCli). The MCP server's
 * link to a harness session is stood in for by setExternalSessionOwner: a server linked to the
 * conversation writes as `ext:<hash>` (session-owner.ts), exactly what the harness link gives it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { cmosDecisions } from '../../../src/tools/cmos/cmos-decisions';
import { bindWindow, openDraftRuntime } from '../../../src/tools/cmos/draft-runtime';
import { harnessSessionHash } from '../../../src/tools/cmos/harness-session';
import { profilePath } from '../../../src/tools/cmos/operator-profile';
import { setExternalSessionOwner } from '../../../src/tools/cmos/session-owner';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
let tmp: string;
let projectRoot: string;
let dbPath: string;
const savedConfigDir = process.env.CMOS_CONFIG_DIR;
const savedStartId = process.env.CLAUDE_CODE_SESSION_ID;

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});

beforeEach(() => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s93m06-approval-'));
  process.env.CMOS_CONFIG_DIR = path.join(tmp, 'config');
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedCmosDb(projectRoot, { projectName: 'approval' });
  reidentifyCmosTestStore(projectRoot);
  CmosDetector.resetInstance();
});

afterEach(() => {
  setExternalSessionOwner(null);
  if (savedStartId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedStartId;
  if (savedConfigDir === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = savedConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function hook(event: string, stdin: unknown): Promise<string> {
  let stdout = '';
  const io: CliIo = {
    env: { ...process.env, CLAUDE_PID: String(process.pid) },
    cwd: projectRoot,
    readStdin: async () => JSON.stringify(stdin),
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  };
  await runCli(['hook', event], io);
  setExternalSessionOwner(null);
  return stdout;
}

const DRAFT = 'Store project decisions as one JSON file per decision, because diffs stay readable.';
const reply = (...lines: string[]) =>
  `Here is my recommendation.\n\n${lines.map((line) => `Would record: ${line}`).join('\n')}`;

const start = (session: string) =>
  hook('session-start', { session_id: session, cwd: projectRoot, source: 'startup' });
const stop = (session: string, text: string) =>
  hook('stop', { session_id: session, cwd: projectRoot, last_assistant_message: text });
const say = (session: string, prompt: string) =>
  hook('prompt', { session_id: session, cwd: projectRoot, prompt, prompt_id: `${Math.random()}` });

/** Propose one draft in s-one and answer it with the operator's message. */
async function proposeAndAnswer(answer: string, text = reply(DRAFT)): Promise<void> {
  await start('s-one');
  await stop('s-one', text);
  await say('s-one', answer);
}

/** The recording server, linked to a harness session (or to none). */
async function record(
  args: Record<string, unknown>,
  session: string | null = 's-one'
): Promise<Awaited<ReturnType<typeof cmosDecisions>>> {
  setExternalSessionOwner(session);
  try {
    return await cmosDecisions({ action: 'record', projectRoot, ...args } as never);
  } finally {
    setExternalSessionOwner(null);
  }
}

function row<T>(sql: string, ...params: unknown[]): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

const decision = (id: number) =>
  row<{
    approval_mode: string | null;
    approval_draft: string | null;
    approval_words: string | null;
  }>(
    'SELECT approval_mode, approval_draft, approval_words FROM strategic_decisions WHERE id = ?',
    id
  );
const proposal = (id = 1) =>
  row<{ outcome: string; record_id: string | null; approval_mode: string | null }>(
    'SELECT outcome, record_id, approval_mode FROM proposals WHERE id = ?',
    id
  );

const idOf = (result: Awaited<ReturnType<typeof record>>): number =>
  (result.data as { decisionId: number }).decisionId;

/** A refused approval must leave every possible record destination untouched. */
function recordState(): unknown {
  const db = new Database(dbPath, { readonly: true });
  try {
    const profile = profilePath(process.env);
    return {
      decisions: db.prepare('SELECT * FROM strategic_decisions ORDER BY id').all(),
      constraints: db.prepare('SELECT * FROM constraints ORDER BY id').all(),
      learnings: db.prepare('SELECT * FROM learnings ORDER BY id').all(),
      profile: fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : null,
    };
  } finally {
    db.close();
  }
}

describe('how the approval is known', () => {
  it('approved: a plain approval of this draft alone, in this session; the row keeps the words', async () => {
    await proposeAndAnswer('approved');
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result))).toEqual({
      approval_mode: 'approved',
      approval_draft: 'P1',
      approval_words: 'approved',
    });
    expect(proposal()).toEqual({
      outcome: 'approved',
      record_id: `d:${idOf(result)}`,
      approval_mode: 'approved',
    });
  });

  it.each([
    [
      'two added subject words',
      'Store project decisions as one JSON file per decision, because reviewable diffs stay readable locally.',
      'agent-judged',
    ],
    [
      'three added subject words',
      'Store project decisions as one JSON file per decision, because reviewable diffs stay readable locally offline.',
      'agent-judged',
    ],
    [
      'two dropped subject words and one reworded word',
      'Store decisions as one JSON file per decision, because diffs stay legible.',
      'agent-judged',
    ],
    [
      'the three-word reason omitted',
      'Store project decisions as one JSON file per decision.',
      'agent-judged',
    ],
    [
      'an expanded policy on the same subject',
      `${DRAFT} Require schema validation, chronological filenames, signed reviews and encrypted backups for every saved decision.`,
      'agent-judged',
    ],
  ])(
    'plain approval with %s preserves the claimed approval scope',
    async (_description, content, mode) => {
      await proposeAndAnswer('approved');
      const result = await record({ content, fromDraft: 'P1' });
      expect(result.success).toBe(true);
      expect(decision(idOf(result))).toEqual({
        approval_mode: mode,
        approval_draft: 'P1',
        approval_words: 'approved',
      });
      expect(
        row<{ decision_text: string }>(
          'SELECT decision_text FROM strategic_decisions WHERE id = ?',
          idOf(result)
        ).decision_text
      ).toBe(content);
      expect(proposal()).toMatchObject({ outcome: 'approved', approval_mode: mode });
    }
  );

  it('approved tolerates whitespace changes without guessing at meaning', async () => {
    await proposeAndAnswer('approved');
    const result = await record({ content: DRAFT.replace(/ /g, '  '), fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result)).approval_mode).toBe('approved');
  });

  it.each([
    [
      'Do not deploy the service before the security review is complete.',
      'Deploy the service before the security review is complete.',
    ],
    [
      'Deploy the service after the security review is complete.',
      'Deploy the service before the security review is complete.',
    ],
    [
      'Limit the monthly hosting budget to 100 dollars.',
      'Limit the monthly hosting budget to 900 dollars.',
    ],
    ['Alice approves requests from Bob.', 'Bob approves requests from Alice.'],
    [DRAFT, DRAFT.replace('JSON', 'YAML')],
  ])('changed wording cannot borrow plain approval: %s', async (drafted, content) => {
    await proposeAndAnswer('approved', reply(drafted));
    const result = await record({ content, fromDraft: 'P1' });
    expect(result.success).toBe(true);
    expect(decision(idOf(result))).toMatchObject({
      approval_mode: 'agent-judged',
      approval_words: 'approved',
    });
  });

  it('agent-judged: nuance, with the nuance folded in and the words attached', async () => {
    await proposeAndAnswer('yes, but name each file by its decision id');
    const result = await record({
      content:
        'Store project decisions as one JSON file per decision, named by id, because diffs stay readable.',
      fromDraft: 'P1',
    });
    expect(decision(idOf(result))).toMatchObject({
      approval_mode: 'agent-judged',
      approval_words: 'yes, but name each file by its decision id',
    });
  });

  it('agent-judged: a plain approval over several drafts at once', async () => {
    await proposeAndAnswer(
      'approved',
      reply(DRAFT, 'Keep the decision folder under cmos/decisions, never at the repository root.')
    );
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(decision(idOf(result)).approval_mode).toBe('agent-judged');
  });

  it('a message that does not approve never reads approved', async () => {
    await proposeAndAnswer('let us look at the export command first');
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(decision(idOf(result)).approval_mode).toBe('agent-judged');
  });

  it('agent-attested: a hookless server can record a decision with no operator excerpt', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    const result = await record({ content: DRAFT, fromDraft: 'P1' }, null);
    expect(result.success).toBe(true);
    expect(decision(idOf(result))).toEqual({
      approval_mode: 'agent-attested',
      approval_draft: 'P1',
      approval_words: null,
    });
  });

  it('refuses words kept for another conversation rather than attesting to its approval', async () => {
    await proposeAndAnswer('approved');
    const before = recordState();
    const result = await record({ content: DRAFT, fromDraft: 'P1' }, 's-other');
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(proposal()).toEqual({ outcome: 'pending', approval_mode: null, record_id: null });
    expect(recordState()).toEqual(before);
  });

  it('refuses expired approval words rather than downgrading to agent-attested', async () => {
    await proposeAndAnswer('approved');
    const runtime = openDraftRuntime(dbPath, process.env)!;
    runtime.db.prepare('UPDATE excerpts SET at = at - ?').run(3 * 60 * 60 * 1000);
    runtime.close();
    const before = recordState();
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(proposal()).toEqual({ outcome: 'pending', approval_mode: null, record_id: null });
    expect(recordState()).toEqual(before);
  });

  it('a hooked server refuses an unanswered draft and leaves it pending', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    const before = recordState();
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    expect(result.error?.suggestion).toContain('after the operator approves');
    expect(proposal()).toEqual({ outcome: 'pending', approval_mode: null, record_id: null });
    expect(recordState()).toEqual(before);
  });

  it('goes end to end through the MCP dispatcher', async () => {
    await proposeAndAnswer('approved');
    setExternalSessionOwner('s-one');
    try {
      const answer = await executeMissionProtocolTool(
        'cmos_decisions',
        { action: 'record', content: DRAFT, fromDraft: 'P1', projectRoot },
        context
      );
      expect(answer.isError).not.toBe(true);
      expect(JSON.stringify(answer)).toContain('From draft');
    } finally {
      setExternalSessionOwner(null);
    }
    expect(
      row<{ approval_mode: string }>(
        "SELECT approval_mode FROM strategic_decisions WHERE approval_draft = 'P1'"
      ).approval_mode
    ).toBe('approved');
  });
});

describe('what is never recorded', () => {
  it('refuses an id that is not a draft id, and one with no draft', async () => {
    await proposeAndAnswer('approved');
    expect((await record({ content: DRAFT, fromDraft: 'D1' })).error?.code).toBe(
      'INVALID_PARAMETER'
    );
    expect((await record({ content: DRAFT, fromDraft: 'P99' })).error?.code).toBe(
      'DRAFT_NOT_FOUND'
    );
  });

  it('refuses content about something else: the approval covers only what the draft said', async () => {
    await proposeAndAnswer('approved');
    const result = await record({
      content: 'Adopt Postgres for the analytics store, because the team already runs it.',
      fromDraft: 'P1',
    });
    expect(result.error?.code).toBe('INVALID_PARAMETER');
    expect(proposal().outcome).toBe('pending');
  });

  it('refuses a declined draft, a replaced one (naming its revision) and an expired one', async () => {
    await proposeAndAnswer('no');
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).error?.code).toBe(
      'DRAFT_NOT_PENDING'
    );

    await stop(
      's-one',
      reply('Keep the cache under the user config directory, never in the repository.')
    );
    await say('s-one', 'hmm, what about a shared cache?');
    await stop('s-one', reply('Keep the cache under a shared directory every user can read.'));
    const replaced = await record({
      content: 'Keep the cache under the user config directory.',
      fromDraft: 'P2',
    });
    expect(replaced.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(replaced.error?.suggestion).toContain('P3');

    const db = new Database(dbPath);
    db.prepare('UPDATE proposals SET created_at = ? WHERE id = 3').run(
      new Date(Date.now() - 8 * 86_400_000).toISOString()
    );
    db.close();
    const expired = await record({
      content: 'Keep the cache under a shared directory.',
      fromDraft: 'P3',
    });
    expect(expired.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(expired.error?.message).toContain('expired');
  });

  it('records a draft once: a second record, or a racing one, is refused', async () => {
    await proposeAndAnswer('approved');
    const [a, b] = await Promise.all([
      record({ content: DRAFT, fromDraft: 'P1' }),
      record({ content: `${DRAFT} Confirmed.`, fromDraft: 'P1' }),
    ]);
    expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((r) => !r.success)?.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(
      row<{ n: number }>(
        "SELECT COUNT(*) AS n FROM strategic_decisions WHERE approval_draft = 'P1'"
      ).n
    ).toBe(1);
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).error?.code).toBe(
      'DRAFT_NOT_PENDING'
    );
  });

  it('refuses a decline the hook could not write to the store', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    // The operator's "no" reached the runtime, but the store write of the decline did not happen.
    const runtime = openDraftRuntime(dbPath, process.env)!;
    bindWindow(runtime, harnessSessionHash('s-one'), [1], 'no', 'decline', Date.now());
    runtime.close();
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(result.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(result.error?.message).toContain('declined');
  });

  it('marks a draft answered, not approved, when this exact decision was already recorded directly', async () => {
    await start('s-one');
    await stop('s-one', reply(DRAFT));
    // Recorded before the operator answered (no window is open), so P1 stays pending.
    const direct = await record({ content: DRAFT });
    expect(proposal().outcome).toBe('pending');
    await say('s-one', 'approved');
    const again = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(idOf(again)).toBe(idOf(direct));
    expect((again.data as { approval?: unknown }).approval).toBeUndefined();
    expect(proposal()).toMatchObject({ outcome: 'answered', record_id: `d:${idOf(direct)}` });
    // The row keeps no approval it never had.
    expect(decision(idOf(direct)).approval_mode).toBeNull();
  });
});

describe('constraints, rules and profile lines', () => {
  const kinds = [
    ['constraint', 'Never push to main without a green CI run on the branch.'],
    ['rule', 'Run the full suite before every commit that touches the hook CLI.'],
    ['profile', 'Ask before running any command that spends money on an API.'],
  ] as const;

  for (const [kind, text] of kinds) {
    it(`writes a ${kind} on the operator's approval, as that kind`, async () => {
      await proposeAndAnswer('approved', `Proposed.\n\nWould record (${kind}): ${text}`);
      const result = await record({ content: text, fromDraft: 'P1' });
      expect(result.success).toBe(true);
      const recorded = (result.data as { recorded: { typedId: string } }).recorded;
      expect(proposal()).toMatchObject({ outcome: 'approved', approval_mode: 'approved' });
      if (kind === 'constraint') {
        expect(recorded.typedId).toMatch(/^c:\d+$/);
        expect(
          row<{ n: number }>('SELECT COUNT(*) AS n FROM constraints WHERE content = ?', text).n
        ).toBe(1);
      } else if (kind === 'rule') {
        expect(recorded.typedId).toMatch(/^l:\d+$/);
        expect(
          row<{ evergreen: number }>('SELECT evergreen FROM learnings WHERE content = ?', text)
            .evergreen
        ).toBe(1);
      } else {
        expect(fs.readFileSync(profilePath(process.env), 'utf8')).toContain(text);
      }
      expect(proposal().record_id).toBe(recorded.typedId);
    });

    it(`writes the approved ${kind} draft text and warns when submitted content adds a policy`, async () => {
      await proposeAndAnswer('approved', `Proposed.\n\nWould record (${kind}): ${text}`);
      const content = `${text} Exempt emergency deployments and delegate future approvals automatically.`;
      const result = await record({ content, fromDraft: 'P1' });
      expect(result.success).toBe(true);
      expect(result.warnings).toContain(
        `The ${kind} was written as drafted (P1); the content passed differs and was not used. Propose a revised line to change it.`
      );
      expect(proposal()).toMatchObject({ outcome: 'approved', approval_mode: 'approved' });
      if (kind === 'profile') {
        expect(fs.readFileSync(profilePath(process.env), 'utf8').trim()).toBe(text);
      } else {
        const table = kind === 'constraint' ? 'constraints' : 'learnings';
        const recorded = (result.data as { recorded: { id: number } }).recorded;
        expect(
          row<{ content: string }>(`SELECT content FROM ${table} WHERE id = ?`, recorded.id)
        ).toEqual({ content: text });
        expect(
          row<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE content = ?`, content).n
        ).toBe(0);
      }
    });

    it.each([
      ['a question', 'Why should this apply to every session?'],
      ['nuance', 'yes, but exempt emergency deployments'],
    ])(`never writes a ${kind} after %s`, async (_description, answer) => {
      fs.mkdirSync(path.dirname(profilePath(process.env)), { recursive: true });
      fs.writeFileSync(profilePath(process.env), 'Keep replies concise.\n');
      await proposeAndAnswer(answer, `Proposed.\n\nWould record (${kind}): ${text}`);
      const before = recordState();
      const result = await record({ content: text, fromDraft: 'P1' });
      expect(result.error?.code).toBe('APPROVAL_REQUIRED');
      expect(result.error?.suggestion).toContain(`Would record (${kind}):`);
      expect(proposal()).toEqual({ outcome: 'pending', approval_mode: null, record_id: null });
      expect(recordState()).toEqual(before);
    });

    it(`never writes a ${kind} as agent-attested`, async () => {
      await proposeAndAnswer('approved', `Proposed.\n\nWould record (${kind}): ${text}`);
      const result = await record({ content: text, fromDraft: 'P1' }, null);
      expect(result.error?.code).toBe('APPROVAL_REQUIRED');
      expect(proposal().outcome).toBe('pending');
      expect(
        row<{ n: number }>('SELECT COUNT(*) AS n FROM constraints WHERE content = ?', text).n
      ).toBe(0);
      expect(fs.existsSync(profilePath(process.env))).toBe(false);
    });
  }

  it('claims a constraint draft once when two records race', async () => {
    const text = 'Never push to main without a green CI run on the branch.';
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (constraint): ${text}`);
    const results = await Promise.all([
      record({ content: text, fromDraft: 'P1' }),
      record({ content: text, fromDraft: 'P1' }),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.find((r) => !r.success)?.error?.code).toBe('DRAFT_NOT_PENDING');
    expect(
      row<{ n: number }>('SELECT COUNT(*) AS n FROM constraints WHERE content = ?', text).n
    ).toBe(1);
  });

  it('releases the claim when an approved profile line cannot be written', async () => {
    fs.mkdirSync(path.dirname(profilePath(process.env)), { recursive: true });
    fs.writeFileSync(profilePath(process.env), `${'x'.repeat(1080)}\n`);
    const text = 'Ask before running any command that spends money on an API.';
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (profile): ${text}`);
    const result = await record({ content: text, fromDraft: 'P1' });
    expect(result.error?.code).toBe('INVALID_PARAMETER');
    expect(result.error?.message).toContain('stays pending');
    expect(proposal()).toMatchObject({ outcome: 'pending', approval_mode: null, record_id: null });
    expect(fs.readFileSync(profilePath(process.env), 'utf8')).not.toContain(text);
  });

  it('does not append a profile line twice', async () => {
    const text = 'Ask before running any command that spends money on an API.';
    fs.mkdirSync(path.dirname(profilePath(process.env)), { recursive: true });
    fs.writeFileSync(profilePath(process.env), `${text}\n`);
    await proposeAndAnswer('approved', `Proposed.\n\nWould record (profile): ${text}`);
    const result = await record({ content: text, fromDraft: 'P1' });
    expect(
      (result.data as { recorded: { materialization: string } }).recorded.materialization
    ).toBe('existing');
    expect(fs.readFileSync(profilePath(process.env), 'utf8')).toBe(`${text}\n`);
  });
});

describe('a record without fromDraft while the operator’s message is open on drafts', () => {
  it('answers the drafts it covers', async () => {
    await proposeAndAnswer('approved');
    const result = await record({ content: DRAFT });
    expect((result.data as { answeredDrafts?: string[] }).answeredDrafts).toEqual(['P1']);
    expect(proposal().outcome).toBe('answered');
  });

  it('leaves an unrelated draft pending, and names it', async () => {
    await proposeAndAnswer('ok and also the parser');
    const result = await record({
      content: 'Parse dates with the platform parser, never a regex.',
    });
    expect((result.data as { stillPendingDrafts?: string[] }).stillPendingDrafts).toEqual(['P1']);
    expect(proposal().outcome).toBe('pending');
  });

  it('touches nothing once the turn has ended', async () => {
    await proposeAndAnswer('approved');
    await stop('s-one', 'Done with that.');
    await record({ content: DRAFT });
    expect(proposal().outcome).toBe('pending');
  });
});

describe('stores from before this mission', () => {
  it('without a proposals table: fromDraft finds no draft, and a plain record still works', async () => {
    const db = new Database(dbPath);
    db.exec('DROP TABLE proposals');
    db.close();
    expect((await record({ content: DRAFT, fromDraft: 'P1' })).error?.code).toBe('DRAFT_NOT_FOUND');
    expect((await record({ content: DRAFT })).success).toBe(true);
  });

  it('without the approval columns: the record adds them and the row carries its mode', async () => {
    const db = new Database(dbPath);
    for (const column of ['approval_mode', 'approval_draft', 'approval_words'])
      db.exec(`ALTER TABLE strategic_decisions DROP COLUMN ${column}`);
    db.close();
    await proposeAndAnswer('approved');
    const result = await record({ content: DRAFT, fromDraft: 'P1' });
    expect(decision(idOf(result)).approval_mode).toBe('approved');
  });
});
