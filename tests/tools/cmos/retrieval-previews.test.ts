// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m08 (retrieval R5) — search hits and mission-start surfacing carry previews of at most
// ABOUTME: 300 characters with id and status, under payload ceilings; show reads one in full by id.

/**
 * The fixture's rows are long on purpose: decisions in this repository's store average about 2,000
 * characters and run to 9,000, which is what made a 10-hit search about 41 KB and mission start a
 * median 17 KB of structured content. Every row here is about 2,000 characters, so a payload that
 * still carried full text would blow each ceiling several times over.
 *
 * CEILING RULE: JSON.stringify of the structured `data` the tool returns, in characters.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { cmosContext } from '../../../src/tools/cmos/cmos-context';
import { formatContextSearchForLLM } from '../../../src/tools/cmos/cmos-context-search';
import type { ContextSearchResult } from '../../../src/tools/cmos/cmos-context-search';
import { cmosDecisions, formatDecisionsForLLM } from '../../../src/tools/cmos/cmos-decisions';
import type { CmosDecisionsShowResult } from '../../../src/tools/cmos/cmos-decisions-show';
import { cmosLearnings } from '../../../src/tools/cmos/cmos-learnings';
import type { CmosLearningsSearchResult } from '../../../src/tools/cmos/cmos-learnings-search';
import type { CmosLearningsShowResult } from '../../../src/tools/cmos/cmos-learnings-show';
import { cmosMissionTransition } from '../../../src/tools/cmos/cmos-mission-transition';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { PREVIEW_MAX_CHARS, previewText } from '../../../src/tools/cmos/text-preview';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

const SPRINT = 'sprint-m08t';
const MISSION = 'm08t-m01';
const TOPIC = 'retrieval preview payload ceiling harness surfacing';

/** About 2,000 characters, every one mentioning the topic so every row matches. */
function longText(i: number): string {
  const sentence = `Row ${i} discusses ${TOPIC} and why the agent should expand by id. `;
  return sentence.repeat(Math.ceil(2_000 / sentence.length));
}

let projectRoot: string;
let dbPath: string;
const decisionIds: number[] = [];
const learningIds: number[] = [];

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s92m08-'));
  dbPath = seedCmosDb(projectRoot, { projectName: 's92-m08 fixture' });
  reidentifyCmosTestStore(projectRoot);
  decisionIds.length = 0;
  learningIds.length = 0;
  const db = new Database(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sprints (id, title, status, start_date) VALUES (?, 'Previews', 'Active', ?)`
    ).run(SPRINT, now);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, objective) VALUES (?, ?, 'Previews', 'Queued', ?)`
    ).run(MISSION, SPRINT, `Prove the ${TOPIC} work: previews, ids and status.`);
    const decision = db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
       VALUES (?, ?, ?, 'active')`
    );
    const learning = db.prepare(
      `INSERT INTO learnings (content, category, created_at, sprint_id, status)
       VALUES (?, 'process', ?, ?, 'active')`
    );
    for (let i = 0; i < 12; i += 1) {
      decisionIds.push(Number(decision.run(longText(i), now, SPRINT).lastInsertRowid));
      learningIds.push(Number(learning.run(longText(100 + i), now, SPRINT).lastInsertRowid));
    }
  } finally {
    db.close();
  }
  CmosDetector.resetInstance();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const size = (value: unknown): number => JSON.stringify(value).length;

describe('s92-m08 — previews, not bodies', () => {
  it('previewText cuts at a word boundary, says so, and leaves short text alone', () => {
    const short = previewText('a short decision');
    expect(short).toEqual({ preview: 'a short decision', truncated: false, fullLength: 16 });
    const long = previewText(longText(1));
    expect(long.preview.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(long.preview.endsWith('…')).toBe(true);
    expect(long.truncated).toBe(true);
    expect(long.fullLength).toBe(longText(1).length);
  });

  it('a 10-hit context search carries previews with id, type and status, under 12 KB', async () => {
    const result = await cmosContext({
      action: 'search',
      query: TOPIC,
      searchLimit: 10,
      searchTypes: ['decision', 'learning'],
      projectRoot,
    });
    expect(result.success).toBe(true);
    const data = result.data as ContextSearchResult;
    expect(data.results).toHaveLength(10);
    for (const hit of data.results) {
      expect(hit.text.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(hit.truncated).toBe(true);
      expect(hit.fullLength).toBeGreaterThan(1_900);
      expect(hit.status).toBe('active');
      expect(['decision', 'learning']).toContain(hit.type);
      for (const neighbour of hit.graphNeighbors ?? []) {
        expect(neighbour.text.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      }
    }
    // Full text would be about 10 × 2,000 characters of text alone.
    expect(size(data)).toBeLessThanOrEqual(12_000);
    const rendered = formatContextSearchForLLM(result as never);
    expect(rendered).toContain(`Previews are cut at ${PREVIEW_MAX_CHARS} characters`);
    expect(rendered).toMatch(
      /cmos_(decisions|learnings)\(action="show", (decision|learning)Id=\d+\)/
    );
  }, 60_000);

  it('a learnings search carries previews, under 15 KB for its default 20 hits', async () => {
    const result = await cmosLearnings({ action: 'search', query: TOPIC, projectRoot });
    expect(result.success).toBe(true);
    const data = result.data as CmosLearningsSearchResult;
    expect(data.results.length).toBeGreaterThanOrEqual(12);
    for (const hit of data.results) {
      expect(hit.content.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(hit.truncated).toBe(true);
    }
    expect(size(data)).toBeLessThanOrEqual(15_000);
  }, 60_000);

  it('mission start surfaces previews of relevant decisions, under 5 KB', async () => {
    const started = await cmosMissionTransition({
      action: 'start',
      missionId: MISSION,
      projectRoot,
    });
    expect(started.success).toBe(true);
    const relevant = (
      started.data as {
        relevantDecisions?: Array<{ id: number; decisionText: string; truncated: boolean }>;
      }
    ).relevantDecisions;
    expect(relevant?.length ?? 0).toBeGreaterThan(0);
    for (const d of relevant!) {
      expect(d.decisionText.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(d.truncated).toBe(true);
      expect(decisionIds).toContain(d.id);
    }
    expect(size(relevant)).toBeLessThanOrEqual(5_000);
  }, 60_000);
});

// s93-m11 (#602): the three answers sprint-92 left returning full bodies. Decisions search is the
// search the server instructions name, and returned about 790 characters a hit (4 KB for one).
describe('s93-m11 — decisions search, decisions list and session search carry previews', () => {
  it('a decisions search carries previews with status, under 15 KB for its default 20 hits', async () => {
    const result = await cmosDecisions({ action: 'search', query: TOPIC, projectRoot });
    expect(result.success).toBe(true);
    const data = result.data as {
      results: Array<{
        id: number;
        decision: string;
        truncated: boolean;
        fullLength: number;
        status: string | null;
      }>;
    };
    expect(data.results.length).toBeGreaterThanOrEqual(12);
    for (const hit of data.results) {
      expect(hit.decision.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(hit.truncated).toBe(true);
      expect(hit.fullLength).toBeGreaterThan(PREVIEW_MAX_CHARS);
      expect(hit.status).toBe('active');
    }
    expect(size(data)).toBeLessThanOrEqual(15_000);
    expect(formatDecisionsForLLM('search', result)).toMatch(
      /cmos_decisions\(action="show", decisionId=\d+\)/
    );
  }, 60_000);

  it('a decisions list carries previews, under 15 KB for its default page', async () => {
    const result = await cmosDecisions({ action: 'list', projectRoot });
    expect(result.success).toBe(true);
    const data = result.data as {
      decisions: Array<{ decision: string; truncated: boolean; fullLength: number }>;
    };
    expect(data.decisions.length).toBe(12);
    for (const row of data.decisions) {
      expect(row.decision.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(row.truncated).toBe(true);
    }
    expect(size(data)).toBeLessThanOrEqual(15_000);
  }, 60_000);

  // s93-m11, the contract critic's class-3 count: the learnings list and the session list returned
  // full bodies too (20 KB and 30 KB default pages on this repository's store).
  it('a learnings list carries previews and says how to read one, under 15 KB for its default page', async () => {
    const result = await cmosLearnings({ action: 'list', projectRoot });
    expect(result.success).toBe(true);
    const data = result.data as {
      learnings: Array<{ id: number; content: string; truncated: boolean; fullLength: number }>;
    };
    expect(data.learnings.length).toBe(12);
    for (const row of data.learnings) {
      expect(row.content.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(row.truncated).toBe(true);
      expect(row.fullLength).toBeGreaterThan(PREVIEW_MAX_CHARS);
    }
    expect(size(data)).toBeLessThanOrEqual(15_000);
    const { formatLearningsForLLM } = await import('../../../src/tools/cmos/cmos-learnings');
    const text = formatLearningsForLLM('list', result);
    expect(text).toContain(`cmos_learnings(action="show", learningId=${data.learnings[0].id})`);
    expect(text).not.toContain(longText(100));
  }, 60_000);

  it("a list never points a local show at another project's id", async () => {
    const { formatDecisionsListForLLM } =
      await import('../../../src/tools/cmos/cmos-decisions-list');
    const text = formatDecisionsListForLLM({
      success: true,
      data: {
        decisions: [
          {
            id: 7,
            decision: 'A foreign preview…',
            truncated: true,
            fullLength: 900,
            domain: null,
            sprintId: null,
            snapshotId: null,
            missionId: null,
            createdAt: '2026-10-01T00:00:00Z',
            source: 'strategic',
            category: null,
            status: 'active',
            supersededBy: null,
            evidence: null,
            projectId: 'another-project',
          },
        ],
        totalCount: 1,
        page: 1,
        pageSize: 20,
        hasMore: false,
        acrossProjects: true,
        filters: {},
      },
    } as never);
    expect(text).not.toContain('decisionId=7');
    expect(text).toContain('in that project, with its projectRoot');
  });

  it('a session search previews summaries and captures, and list reads one session in full', async () => {
    const summary = longText(900);
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO sessions (id, type, title, started_at, completed_at, status, summary, captures)
         VALUES ('PS-2026-01-02-001', 'research', 'Previews', ?, ?, 'completed', ?, ?)`
      ).run(
        new Date().toISOString(),
        new Date().toISOString(),
        summary,
        JSON.stringify([
          {
            category: 'learning',
            content: longText(901),
            timestamp: new Date().toISOString(),
            context: 'Why this capture was made, kept whole too.',
          },
        ])
      );
    } finally {
      db.close();
    }
    const { cmosSession } = await import('../../../src/tools/cmos/cmos-session');
    const found = await cmosSession({ action: 'search', query: 'preview payload', projectRoot });
    expect(found.success).toBe(true);
    const hit = (
      found.data as {
        results: Array<{
          summary: string | null;
          summaryTruncated: boolean;
          summaryFullLength: number;
          matchedCaptures: Array<{ content: string; truncated: boolean }>;
        }>;
      }
    ).results[0];
    expect(hit.summary!.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(hit.summaryTruncated).toBe(true);
    expect(hit.summaryFullLength).toBe(summary.length);
    expect(hit.matchedCaptures[0].content.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(hit.matchedCaptures[0].truncated).toBe(true);

    // The way back to the full text: list narrowed to that one session.
    const listed = await cmosSession({
      action: 'list',
      sessionId: 'PS-2026-01-02-001',
      projectRoot,
    });
    const sessions = (
      listed.data as {
        sessions: Array<{ id: string; summary: string; captures?: Array<{ content: string }> }>;
      }
    ).sessions;
    expect(sessions.map((s) => s.id)).toEqual(['PS-2026-01-02-001']);
    expect(sessions[0].summary).toBe(summary);
    expect(sessions[0].captures?.map((c) => c.content)).toEqual([longText(901)]);

    // A plain list carries the summary as a preview and points at the full read.
    const plain = await cmosSession({ action: 'list', projectRoot });
    const row = (
      plain.data as {
        sessions: Array<{ id: string; summary: string; summaryTruncated?: boolean }>;
      }
    ).sessions.find((s) => s.id === 'PS-2026-01-02-001')!;
    expect(row.summary.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(row.summaryTruncated).toBe(true);

    // s93-m11 (the contract critic): the TEXT an agent reads names the way back, and following it
    // shows the whole summary and every capture, not an 80-character cut.
    const { formatSessionForLLM } = await import('../../../src/tools/cmos/cmos-session');
    expect(formatSessionForLLM('search', found)).toContain(
      'cmos_session(action="list", sessionId="PS-2026-01-02-001")'
    );
    const listText = formatSessionForLLM('list', listed);
    expect(listText).toContain(summary);
    expect(listText).toContain(longText(901));
    expect(listText).toContain('Captures (1):');
    // The confirming critic: the full read dropped each capture's context.
    expect(listText).toContain('Context: Why this capture was made, kept whole too.');
  }, 60_000);
});

describe('s92-m08 — show reads one row in full by id', () => {
  it('cmos_decisions(show) returns the full text a preview stood for', async () => {
    const shown = await cmosDecisions({
      action: 'show',
      decisionId: decisionIds[3],
      projectRoot,
    });
    expect(shown.success).toBe(true);
    const data = shown.data as CmosDecisionsShowResult;
    expect(data.decisionText).toBe(longText(3));
    expect(data).toMatchObject({ id: decisionIds[3], status: 'active', sprintId: SPRINT });
    expect(formatDecisionsForLLM('show', shown)).toContain(longText(3).trim());
  });

  it('cmos_learnings(show) returns the full text a preview stood for', async () => {
    const shown = await cmosLearnings({
      action: 'show',
      learningId: learningIds[5],
      projectRoot,
    });
    expect(shown.success).toBe(true);
    expect((shown.data as CmosLearningsShowResult).content).toBe(longText(105));
  });

  it('an id the project does not hold is refused by name', async () => {
    const decision = await cmosDecisions({ action: 'show', decisionId: 999_999, projectRoot });
    expect(decision.error).toMatchObject({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      field: 'decisionId',
    });
    expect(decision.error?.message).toContain('#999999');
    const learning = await cmosLearnings({ action: 'show', learningId: 999_999, projectRoot });
    expect(learning.error).toMatchObject({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      field: 'learningId',
    });
  });
});
