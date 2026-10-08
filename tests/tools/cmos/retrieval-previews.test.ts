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
