// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — the proposals table: a carve-out that holds drafts until the operator answers them.
// ABOUTME: Expiry is computed when read, and only a pending draft can become a record, exactly once.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DRAFT_EXPIRY_DAYS,
  DRAFT_EXPIRY_STARTS,
  draftLabel,
  ensureProposalsTable,
  getDraft,
  insertDraft,
  isExpired,
  markAnswered,
  markApproved,
  markDeclined,
  markOffered,
  markReplaced,
  parseDraftId,
  pendingDrafts,
  proposalsTableExists,
  rawRunner,
} from '../../../src/tools/cmos/proposals';
import { CMOS_SCHEMA } from '../../../src/tools/cmos/schema';

const DAY = 86_400_000;
let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s93m06-proposals-'));
  db = new Database(path.join(tmp, 'cmos.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const draft = (overrides: Partial<Parameters<typeof insertDraft>[1]> = {}) => ({
  text: 'Store decisions as one JSON file each, because diffs stay readable.',
  kind: 'decision' as const,
  sourceSession: 'a1b2c3d4e5f60718',
  assistantExcerpt: 'I would go with JSON files.',
  evidence: [],
  outsideContent: 0,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('the table', () => {
  it('is created on demand, idempotently, and an absent table reads as no drafts', () => {
    const run = rawRunner(db);
    expect(proposalsTableExists(run)).toBe(false);
    expect(pendingDrafts(run)).toEqual([]);
    ensureProposalsTable(run);
    ensureProposalsTable(run);
    expect(proposalsTableExists(run)).toBe(true);
  });

  it('ships in the seed schema, outside FTS and without genesis columns', () => {
    expect(CMOS_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS proposals');
    db.exec(CMOS_SCHEMA);
    const columns = (db.pragma('table_info(proposals)') as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(columns).not.toContain('stable_event_id');
    expect(columns).not.toContain('project_id');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'proposals%fts%'").all()
    ).toEqual([]);
  });
});

describe('ids', () => {
  it('reads P<n>, p<n> and a bare number, and refuses anything else', () => {
    expect(parseDraftId('P12')).toBe(12);
    expect(parseDraftId('p7')).toBe(7);
    expect(parseDraftId(' 3 ')).toBe(3);
    expect(parseDraftId('D3')).toBeNull();
    expect(parseDraftId('P0')).toBeNull();
    expect(parseDraftId('P1.5')).toBeNull();
    expect(draftLabel(12)).toBe('P12');
  });
});

describe('the lifecycle in the store', () => {
  it('keeps a draft pending until something answers it', () => {
    const run = rawRunner(db);
    ensureProposalsTable(run);
    const id = insertDraft(run, draft());
    expect(pendingDrafts(run).map((row) => row.id)).toEqual([id]);
    markOffered(run, [id], new Date().toISOString());
    expect(getDraft(run, id)?.offeredAt).not.toBeNull();
    expect(pendingDrafts(run)).toHaveLength(1);
  });

  it('records declines, replacements and direct answers as outcomes, never deletions', () => {
    const run = rawRunner(db);
    ensureProposalsTable(run);
    const [a, b, c, d] = [1, 2, 3, 4].map(() => insertDraft(run, draft()));
    const now = new Date().toISOString();
    markDeclined(run, [a], now);
    markReplaced(run, b, d, now);
    markAnswered(run, [c], 'd:9', now);
    expect(getDraft(run, a)).toMatchObject({ outcome: 'declined', answeredAt: now });
    expect(getDraft(run, b)).toMatchObject({ outcome: 'replaced', replacedBy: d });
    expect(getDraft(run, c)).toMatchObject({ outcome: 'answered', recordId: 'd:9' });
    expect(pendingDrafts(run).map((row) => row.id)).toEqual([d]);
  });

  it('approves a draft once: a second approval of the same draft changes nothing', () => {
    const run = rawRunner(db);
    ensureProposalsTable(run);
    const id = insertDraft(run, draft());
    const now = new Date().toISOString();
    expect(markApproved(run, id, { recordId: 'd:1', mode: 'approved', at: now })).toBe(1);
    expect(markApproved(run, id, { recordId: 'd:2', mode: 'agent-judged', at: now })).toBe(0);
    expect(getDraft(run, id)).toMatchObject({
      outcome: 'approved',
      recordId: 'd:1',
      approvalMode: 'approved',
    });
  });
});

describe('expiry is computed when read (7 days or 3 session starts)', () => {
  const created = (daysAgo: number) => ({
    createdAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
  });

  it('expires at 7 days whatever the starts', () => {
    expect(DRAFT_EXPIRY_DAYS).toBe(7);
    expect(isExpired(created(6.9), 0)).toBe(false);
    expect(isExpired(created(7.01), 0)).toBe(true);
  });

  it('expires once three sessions have started since it was drafted', () => {
    expect(DRAFT_EXPIRY_STARTS).toBe(3);
    expect(isExpired(created(0), 2)).toBe(false);
    expect(isExpired(created(0), 3)).toBe(true);
  });

  it('treats an unreadable creation time as expired, never as fresh', () => {
    expect(isExpired({ createdAt: 'not a time' }, 0)).toBe(true);
  });
});
