// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Workspace readers hide transferred source rows before budgets while history stays addressable.
// ABOUTME: Actual SQLite queries refute fallback resurrection and missing source/target pointers.
import Database from 'better-sqlite3';
import { cmosSprintShow } from '../../../src/tools/cmos/cmos-sprint-show';
import { cmosSprintRetro } from '../../../src/tools/cmos/cmos-sprint-retro';
import { cmosSprintAnalytics } from '../../../src/tools/cmos/cmos-sprint-analytics';
import { cmosSprintComplete } from '../../../src/tools/cmos/cmos-sprint-complete';
import { keywordRelevant } from '../../../src/cli/commands';
import { recallLaterPrompt } from '../../../src/cli/later-prompt-recall';
import { readDigestV2 } from '../../../src/tools/cmos/digest-v2-store';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';

import { createSeededCmosProject, type SeededCmosProject } from '../../helpers/seedCmosDb';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { HybridRetriever } from '../../../src/tools/cmos/fts5-retriever';
import { recallFirstPrompt } from '../../../src/tools/cmos/first-prompt-recall';
import { cmosDecisionsList } from '../../../src/tools/cmos/cmos-decisions-list';
import { cmosLearningsSearch } from '../../../src/tools/cmos/cmos-learnings-search';
import { cmosMissionShow } from '../../../src/tools/cmos/cmos-mission-show';
import { cmosLearningsList } from '../../../src/tools/cmos/cmos-learnings-list';
import { cmosMissionList } from '../../../src/tools/cmos/cmos-mission-list';
import {
  cmosDecisionsShow,
  formatDecisionsShowForLLM,
} from '../../../src/tools/cmos/cmos-decisions-show';
import { cmosLearningsShow } from '../../../src/tools/cmos/cmos-learnings-show';
import { cmosNextSteps } from '../../../src/tools/cmos/cmos-next-steps';
import {
  loadUnifiedDecisionRecords,
  getSprintDecisionCounts,
} from '../../../src/tools/cmos/decision-memory';

jest.mock('../../../src/tools/cmos/feedback-fleet', () => ({
  feedbackDigestLine: jest.fn(async () => undefined),
}));
jest.mock('../../../src/tools/cmos/operator-profile', () => ({
  ...jest.requireActual('../../../src/tools/cmos/operator-profile'),
  readProfile: jest.fn(async () => null),
}));
let project: SeededCmosProject, db: Database.Database, client: CmosDatabaseClient;
const when = () => new Date(Date.now() - 1000).toISOString();
function hide(kind: string, id: string | number, origin = false) {
  const p = {
    operationId: 'fork',
    sourceProjectId: 'source',
    sourceRoot: '/source',
    sourceId: id,
    targetProjectId: 'target',
    targetRoot: '/target',
    targetId: id,
  };
  db.prepare('INSERT INTO metadata VALUES (?,?)').run(
    `spin_out_${origin ? 'origin' : 'row'}:${kind}:${id}`,
    JSON.stringify(p)
  );
  return p;
}
beforeEach(async () => {
  project = await createSeededCmosProject({ projectId: 'source' }, 'cmos-spin-out-read-');
  db = new Database(project.dbPath);
  db.prepare("INSERT INTO sprints(id,title,status) VALUES('sprint-1','History','Completed')").run();
  const opened = await CmosDatabaseClient.create({ dbPath: project.dbPath });
  if (!opened.success || !opened.data) throw new Error('fixture open');
  client = opened.data;
});
afterEach(async () => {
  client.close();
  db.close();
  await project.cleanup();
});

it('fills keyword and first-prompt budgets after excluding many top-ranked source rows', async () => {
  const insert = db.prepare(
    'INSERT INTO strategic_decisions(id,decision_text,created_at,status) VALUES(?,?,?,?)'
  );
  for (let id = 1; id <= 30; id++) {
    insert.run(id, 'cobalt compass', when(), 'archived');
    hide('decision', id);
  }
  insert.run(31, 'cobalt compass allowed supporting context', when(), 'active');
  const retriever = new HybridRetriever(client, {
    embedder: async () => {
      throw new Error('Keyword-only fixture');
    },
  });
  expect(
    (await retriever.search('cobalt compass', { types: ['decision'], limit: 1 })).map(
      (row) => row.id
    )
  ).toEqual([31]);
  const first = recallFirstPrompt(project.dbPath, 'cobalt compass');
  expect(first.available).toBe(true);
  expect(first.items.map((row) => row.id)).toEqual([31]);
});

it('does not resurrect a hidden decision through the unchanged session capture fallback', async () => {
  const text = 'cobalt compass captured history';
  db.prepare(
    "INSERT INTO sessions(id,type,title,started_at,status,sprint_id,captures) VALUES('author','build','History',?,'completed','sprint-1',?)"
  ).run(when(), JSON.stringify([{ category: 'decision', content: text }]));
  db.prepare(
    "INSERT INTO strategic_decisions(id,decision_text,created_at,status,sprint_id,author_session_id) VALUES(1,?,?,'archived','sprint-1','author')"
  ).run(text, when());
  hide('decision', 1);
  const list = await cmosDecisionsList({ projectRoot: project.projectRoot, sprintId: 'sprint-1' });
  expect(list.success).toBe(true);
  expect(list.data?.decisions).toEqual([]);
  expect(getSprintDecisionCounts(client, 'sprint-1').totalDecisionsCount).toBe(1);
});

it('keeps local learning and mission page totals aligned with visible rows', async () => {
  for (let id = 1; id <= 2; id++) {
    db.prepare("INSERT INTO learnings(id,content,created_at,status) VALUES(?,?,?,'archived')").run(
      id,
      `lesson ${id}`,
      when()
    );
    db.prepare("INSERT INTO missions(id,name,status) VALUES(?,?,'Completed')").run(
      `m${id}`,
      `mission ${id}`
    );
  }
  hide('learning', 1);
  hide('mission', 'm1');
  const learnings = await cmosLearningsList({ projectRoot: project.projectRoot, pageSize: 1 });
  expect(learnings.data?.learnings.map((row) => row.id)).toEqual([2]);
  expect(learnings.data?.totalCount).toBe(1);
  const missions = await cmosMissionList({ projectRoot: project.projectRoot, limit: 1 });
  expect(missions.data?.missions.map((row) => row.id)).toEqual(['m2']);
  expect(missions.data?.totalCount).toBe(1);
});

it('shows source and copied-row addresses without hiding explicit history', async () => {
  db.prepare(
    "INSERT INTO strategic_decisions(id,decision_text,created_at,status) VALUES(1,'Source decision',?,'archived')"
  ).run(when());
  db.prepare(
    "INSERT INTO learnings(id,content,created_at,status) VALUES(7,'Copied learning',?,'active')"
  ).run(when());
  const pointer = hide('decision', 1);
  const origin = hide('learning', 7, true);
  const shown = await cmosDecisionsShow({ projectRoot: project.projectRoot, decisionId: 1 });
  expect(shown).toMatchObject({ success: true, data: { spunOutTo: pointer } });
  expect(formatDecisionsShowForLLM(shown)).toContain('/target');
  expect(
    await cmosLearningsShow({ projectRoot: project.projectRoot, learningId: 7 })
  ).toMatchObject({ success: true, data: { spinOutOrigin: origin } });
});

it('reads a dropped next step by explicit IDs while honoring an explicit status filter', async () => {
  db.prepare(
    "INSERT INTO next_steps(id,content,status,created_at) VALUES(1,'Moved follow-up','dropped',?)"
  ).run(when());
  const pointer = hide('next-step', 1);
  const base = { projectRoot: project.projectRoot, nextStepAction: 'list' as const };
  expect((await cmosNextSteps(base)).data?.items).toEqual([]);
  expect((await cmosNextSteps({ ...base, nextStepIds: [1] })).data?.items).toEqual([
    expect.objectContaining({ id: 1, spunOutTo: pointer }),
  ]);
  expect(
    (await cmosNextSteps({ ...base, nextStepIds: [1], nextStepStatus: 'pending' })).data?.items
  ).toEqual([]);
});

it('keeps hidden canonical identity ahead of presentation date filters', () => {
  const old = new Date(Date.now() - 10000).toISOString(),
    recent = when();
  const text = 'copied decision must not reappear as historical capture';
  db.prepare(
    "INSERT INTO sessions(id,type,title,started_at,status,sprint_id,captures) VALUES('author','build','History',?,'completed','sprint-1',?)"
  ).run(old, JSON.stringify([{ category: 'decision', content: text, timestamp: old }]));
  db.prepare(
    "INSERT INTO strategic_decisions(id,decision_text,created_at,status,sprint_id,author_session_id) VALUES(1,?,?,'archived','sprint-1','author')"
  ).run(text, recent);
  hide('decision', 1);
  expect(
    loadUnifiedDecisionRecords(client, {
      sprintId: 'sprint-1',
      until: new Date(Date.now() - 5000).toISOString(),
    })
  ).toEqual([]);
});

it('filters CLI keyword and later-prompt recall before result budgets', () => {
  for (let id = 1; id <= 5; id++) {
    db.prepare(
      "INSERT INTO strategic_decisions(id,decision_text,created_at,status) VALUES(?,?,?,'archived')"
    ).run(id, 'cobalt compass', when());
    if (id < 5) hide('decision', id);
  }
  expect(keywordRelevant(project.dbPath, 'cobalt compass', 1).map((row) => row.id)).toEqual([5]);
  expect(
    recallLaterPrompt(project.dbPath, 'cobalt compass', [], { minKeywordMatches: 2 }).items.map(
      (row) => row.id
    )
  ).toEqual([5]);
});
it('omits transferred decisions and learnings from the digest recent sections', async () => {
  db.prepare(
    "INSERT INTO strategic_decisions(id,decision_text,created_at,status) VALUES(1,'cobalt compass',?,'archived')"
  ).run(when());
  db.prepare(
    "INSERT INTO learnings(id,content,created_at,status) VALUES(1,'cobalt compass',?,'archived')"
  ).run(when());
  hide('decision', 1);
  hide('learning', 1);
  const digest = await readDigestV2(project.projectRoot, {});
  expect(JSON.stringify(digest)).not.toContain('cobalt compass');
});
it('preserves historical ID lookup through actual MCP dispatch and rejects malformed IDs', async () => {
  db.prepare(
    "INSERT INTO next_steps(id,content,status,created_at) VALUES(1,'Moved follow-up','dropped',?)"
  ).run(when());
  hide('next-step', 1);
  const context = await buildMissionProtocolContext();
  const old = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    const call = (nextStepIds: unknown) =>
      executeMissionProtocolTool(
        'cmos_context',
        {
          action: 'next_steps',
          nextStepAction: 'list',
          nextStepIds,
          projectRoot: project.projectRoot,
        },
        context
      );
    const explicit = await call([1]);
    expect(explicit.isError).not.toBe(true);
    expect(JSON.stringify(explicit)).toContain('/target');
    expect((await call(null)).isError).not.toBe(true);
    for (const invalid of ['1', 1, {}, [null]]) {
      const refused = await call(invalid);
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain('INVALID_PARAMETER');
    }
  } finally {
    if (old === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = old;
  }
});

it('distinguishes transferred work in every sprint report while preserving historical denominators', async () => {
  db.exec(
    "INSERT INTO missions(id,name,status,sprint_id) VALUES('moved','Moved','Dropped','sprint-1'),('done','Done','Completed','sprint-1')"
  );
  hide('mission', 'moved');
  const args = { projectRoot: project.projectRoot, sprintId: 'sprint-1' };
  const show = await cmosSprintShow(args),
    retro = await cmosSprintRetro(args),
    analytics = await cmosSprintAnalytics(args);
  expect(show.data?.totalMissions).toBe(1);
  expect(show.data?.parkedMissions).toBe(1);
  expect(retro.data?.kpis.totalMissions).toBe(1);
  expect(retro.data?.kpis.parkedMissions).toBe(1);
  expect(analytics.data?.aggregates.totalMissions).toBe(1);
  expect(analytics.data?.aggregates.totalParked).toBe(1);
  for (const result of [show, retro, analytics]) {
    expect(result.success).toBe(true);
    expect(result.warnings?.join(' ')).toContain('Spun out:');
    expect(result.warnings?.join(' ')).toContain('/target');
  }
  db.exec("UPDATE sprints SET status='Active' WHERE id='sprint-1'");
  const close = await cmosSprintComplete({
    ...args,
    summary: 'Historical transferred work preserved',
    archive: false,
  });
  expect(close.success).toBe(true);
  expect(close.warnings?.join(' ')).toContain('Spun out:');
});

it('filters mission keyword pools with text IDs and mission graph neighbors before allocation', async () => {
  for (let id = 1; id <= 30; id++) {
    db.prepare(
      "INSERT INTO missions(id,name,objective,status,sprint_id) VALUES(?,?,?,'Completed','sprint-1')"
    ).run(`m${id}`, 'cobalt compass', 'cobalt compass');
    hide('mission', `m${id}`);
  }
  db.exec(
    "INSERT INTO missions(id,name,objective,status,sprint_id) VALUES('visible','cobalt compass','allowed supporting context','Completed','sprint-1'),('neighbor','indirect topic','supporting graph context','Completed','sprint-1')"
  );
  const retriever = new HybridRetriever(client, {
    embedder: async () => {
      throw new Error('keyword fixture');
    },
  });
  expect(
    (
      await retriever.search('cobalt compass', { types: ['mission'], limit: 1, expandGraph: true })
    ).map((row) => row.id)
  ).toEqual(['visible']);
  const results = await retriever.search('cobalt compass', {
    types: ['mission'],
    limit: 10,
    expandGraph: true,
  });
  expect(results.map((row) => row.id).sort()).toEqual(['neighbor', 'visible']);
  expect(
    await cmosMissionShow({ projectRoot: project.projectRoot, missionId: 'm1' })
  ).toMatchObject({ success: true, data: { spunOutTo: { sourceId: 'm1' } } });
});
it('keeps learning keyword counts and returned rows aligned after filtering', async () => {
  for (let id = 1; id <= 2; id++)
    db.prepare("INSERT INTO learnings(id,content,created_at,status) VALUES(?,?,?,'archived')").run(
      id,
      'cobalt compass',
      when()
    );
  hide('learning', 2);
  const found = await cmosLearningsSearch({
    projectRoot: project.projectRoot,
    query: 'cobalt compass',
    limit: 1,
  });
  expect(found.data?.results.map((row) => row.id)).toEqual([1]);
  expect(found.data?.totalMatches).toBe(1);
});
it('reports ledger predicate failures loudly instead of turning recall into an empty result', async () => {
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(
    'spin_out_row:decision:1',
    'corrupt-json'
  );
  await expect(new HybridRetriever(client).search('cobalt compass')).rejects.toThrow(
    'SPIN_OUT_READ_FAILED'
  );
  const first = recallFirstPrompt(project.dbPath, 'cobalt compass');
  expect(first.available).toBe(false);
  expect(first.warnings.join(' ')).toContain('SPIN_OUT_READ_FAILED');
});

it('refuses a failed hidden-canonical identity read instead of resurrecting session history', () => {
  const original = client.getMany.bind(client);
  jest
    .spyOn(client, 'getMany')
    .mockImplementation((sql, params) =>
      sql.includes('FROM strategic_decisions sd') && !sql.includes('WHERE')
        ? { success: false, error: { code: 'DB_QUERY_FAILED', message: 'identity read failed' } }
        : original(sql, params)
    );
  expect(() => loadUnifiedDecisionRecords(client, { sprintId: 'sprint-1' })).toThrow(
    'SPIN_OUT_READ_FAILED'
  );
});

it('refuses failed canonical schema inspection while retaining absent-table legacy behavior', () => {
  const original = client.getMany.bind(client);
  let schemaReads = 0;
  jest.spyOn(client, 'getMany').mockImplementation((sql, params) => {
    if (sql === "PRAGMA table_info('strategic_decisions')" && ++schemaReads === 2)
      return { success: false, error: { code: 'DB_QUERY_FAILED', message: 'schema read failed' } };
    return original(sql, params);
  });
  expect(() => loadUnifiedDecisionRecords(client, { sprintId: 'sprint-1' })).toThrow(
    'SPIN_OUT_READ_FAILED'
  );
  expect(schemaReads).toBe(2);
});

it('retains an empty canonical inventory on a legacy store without its decision table', () => {
  db.exec('DROP TABLE strategic_decisions');
  expect(loadUnifiedDecisionRecords(client, { sprintId: 'sprint-1' })).toEqual([]);
});

it('keeps the outer row identity when legacy metadata has its own id column', async () => {
  db.exec('ALTER TABLE metadata ADD COLUMN id INTEGER');
  db.exec(
    "INSERT INTO missions(id,name,status) VALUES('hidden','Transferred','Completed'),('visible','Kept','Completed')"
  );
  // Use named columns: this foreign-compatible metadata shape has an unrelated identity.
  db.prepare('INSERT INTO metadata(key,value,id) VALUES(?,?,9)').run(
    'spin_out_row:mission:hidden',
    JSON.stringify({
      operationId: 'fork',
      sourceProjectId: 'source',
      sourceRoot: '/source',
      sourceId: 'hidden',
      targetProjectId: 'target',
      targetRoot: '/target',
      targetId: 'copied',
    })
  );
  const result = await cmosMissionList({ projectRoot: project.projectRoot, limit: 1 });
  expect(result.data?.missions.map((row) => row.id)).toEqual(['visible']);
  expect(result.data?.totalCount).toBe(1);
});
