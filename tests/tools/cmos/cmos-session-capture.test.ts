/**
 * cmos_session_capture Tool Tests
 *
 * Tests for session capture functionality including auto-extraction of decisions
 * to the strategic_decisions table.
 *
 * @module tests/tools/cmos/cmos-session-capture
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSessionCapture,
  cmosSessionCaptureToolDefinition,
  formatSessionCaptureForLLM,
  VALID_CAPTURE_CATEGORIES,
  type CmosSessionCaptureResult,
} from '../../../src/tools/cmos/cmos-session-capture';
import { cmosDecisionsList } from '../../../src/tools/cmos/cmos-decisions-list';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('cmos_session_capture', () => {
  let tempDir: string;
  let dbPath: string;
  let projectRoot: string;
  let activeSessionId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-session-capture-test-'));
    projectRoot = tempDir;
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');
    activeSessionId = 'PS-2024-01-15-001';

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT REFERENCES sprints(id),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        agent TEXT,
        mission TEXT,
        action TEXT NOT NULL,
        status TEXT,
        summary TEXT,
        next_hint TEXT,
        raw_event TEXT
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT,
        session_id TEXT REFERENCES sessions(id),
        mission_id TEXT,
        source_chunk_ids TEXT,
        category TEXT,
        superseded_by INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        evidence TEXT
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT REFERENCES sprints(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT,
        notes TEXT,
        objective TEXT
      );

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- Insert test data
      INSERT INTO sprints (id, title, status, focus)
      VALUES ('sprint-14', 'Sprint 14 - Agent Tools', 'Current', 'Implement agent utility tools');

      INSERT INTO missions (id, sprint_id, name, status, objective)
      VALUES ('s14-m01', 'sprint-14', 'Test Mission 1', 'In Progress', 'Test objective');

      INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
      VALUES ('${activeSessionId}', 'planning', 'Sprint Planning', 'sprint-14', '2024-01-15T09:00:00Z', 'active', '[]');

      INSERT INTO sessions (id, type, title, sprint_id, started_at, status, completed_at, captures)
      VALUES ('PS-2024-01-14-001', 'review', 'Code Review', 'sprint-14', '2024-01-14T10:00:00Z', 'completed', '2024-01-14T11:00:00Z', '[]');

      INSERT INTO metadata (key, value)
      VALUES ('project_domain', 'cmos-mcp');
    `);
    db.close();

    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic capture functionality', () => {
    it('should capture a decision to active session', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Use TypeScript for all new tools',
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessionId).toBe(activeSessionId);
      expect(result.data?.category).toBe('decision');
      expect(result.data?.content).toBe('Use TypeScript for all new tools');
      expect(result.data?.captureCount).toBe(1);
    });

    it('should capture a learning', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'learning',
        content: 'SQLite is faster than expected',
      });

      expect(result.success).toBe(true);
      expect(result.data?.category).toBe('learning');
    });

    it('should capture a constraint', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'constraint',
        content: 'Max 100ms for onboard queries',
      });

      expect(result.success).toBe(true);
      expect(result.data?.category).toBe('constraint');
    });

    it('should capture context', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'context',
        content: 'Working on Sprint 14 tools',
      });

      expect(result.success).toBe(true);
      expect(result.data?.category).toBe('context');
    });

    it('should capture next-step', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'next-step',
        content: 'Implement cmos_backlog_export',
      });

      expect(result.success).toBe(true);
      expect(result.data?.category).toBe('next-step');
    });

    it('should increment capture count', async () => {
      await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'First decision',
      });

      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'learning',
        content: 'Second capture',
      });

      expect(result.success).toBe(true);
      expect(result.data?.captureCount).toBe(2);
    });
  });

  describe('auto-extraction for decisions', () => {
    it('should auto-extract decision to strategic_decisions table', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Use TypeScript for all new tools',
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisionExtractionCount).toBe(1);
      expect(result.data?.decisionAlreadyExtracted).toBe(false);

      // Verify decision was inserted into strategic_decisions
      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT * FROM strategic_decisions WHERE decision_text = ?')
        .get('Use TypeScript for all new tools') as
        | {
            decision_text: string;
            sprint_id: string | null;
            project_domain: string | null;
            author_session_id: string | null;
          }
        | undefined;
      db.close();

      expect(decision).toBeDefined();
      expect(decision?.decision_text).toBe('Use TypeScript for all new tools');
      expect(decision?.sprint_id).toBe('sprint-14');
      expect(decision?.project_domain).toBe('cmos-mcp');
      // The shipped schema names the session of origin author_session_id (formerly session_id).
      expect(decision?.author_session_id).toBe(activeSessionId);
    });

    it('should auto-tag with sprint_id from session', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Test decision with sprint',
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT sprint_id FROM strategic_decisions WHERE decision_text = ?')
        .get('Test decision with sprint') as
        | {
            sprint_id: string | null;
          }
        | undefined;
      db.close();

      expect(decision?.sprint_id).toBe('sprint-14');
    });

    it('should auto-tag with project_domain from metadata', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Test decision with domain',
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT project_domain FROM strategic_decisions WHERE decision_text = ?')
        .get('Test decision with domain') as
        | {
            project_domain: string | null;
          }
        | undefined;
      db.close();

      expect(decision?.project_domain).toBe('cmos-mcp');
    });

    it('should include session_id reference in decision record', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Test decision with session ref',
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT author_session_id FROM strategic_decisions WHERE decision_text = ?')
        .get('Test decision with session ref') as
        | {
            author_session_id: string | null;
          }
        | undefined;
      db.close();

      expect(decision?.author_session_id).toBe(activeSessionId);
    });

    it('should be idempotent - no duplicate decisions on retry', async () => {
      // First capture
      const result1 = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Same decision text',
      });

      expect(result1.success).toBe(true);
      expect(result1.data?.decisionExtractionCount).toBe(1);
      expect(result1.data?.decisionAlreadyExtracted).toBe(false);

      // Retry with same content
      const result2 = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Same decision text',
      });

      expect(result2.success).toBe(true);
      expect(result2.data?.decisionExtractionCount).toBe(0);
      expect(result2.data?.decisionAlreadyExtracted).toBe(true);

      // Verify only one decision exists
      const db = new Database(dbPath);
      const count = db
        .prepare('SELECT COUNT(*) as count FROM strategic_decisions WHERE decision_text = ?')
        .get('Same decision text') as {
        count: number;
      };
      db.close();

      expect(count.count).toBe(1);
    });

    it('should maintain existing session capture behavior', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Decision also stored in captures',
      });

      expect(result.success).toBe(true);

      // Verify capture is in session captures JSON
      const db = new Database(dbPath);
      const session = db
        .prepare('SELECT captures FROM sessions WHERE id = ?')
        .get(activeSessionId) as {
        captures: string;
      };
      db.close();

      const captures = JSON.parse(session.captures);
      expect(captures.length).toBe(1);
      expect(captures[0].category).toBe('decision');
      expect(captures[0].content).toBe('Decision also stored in captures');
    });

    it('should not extract non-decision categories', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'learning',
        content: 'This is a learning not a decision',
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisionExtractionCount).toBeUndefined();
      expect(result.data?.decisionAlreadyExtracted).toBeUndefined();

      // Verify no decision was inserted
      const db = new Database(dbPath);
      const count = db.prepare('SELECT COUNT(*) as count FROM strategic_decisions').get() as {
        count: number;
      };
      db.close();

      expect(count.count).toBe(0);
    });
  });

  describe('source_chunk_ids', () => {
    // s92-m10: the 3.1.0 copy this file used to test stored sourceChunkIds; the shipped capture has
    // no such input (provenance travels in `evidence`), so a caller-supplied list is not stored.
    it('the shipped capture never writes source_chunk_ids, even when a caller passes them', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Decision with chunk ids the tool does not take',
        sourceChunkIds: ['chunk-uuid-1'],
      });
      expect(result.success).toBe(true);
      expect(result.data?.sourceChunkIds).toBeUndefined();

      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT source_chunk_ids FROM strategic_decisions WHERE decision_text = ?')
        .get('Decision with chunk ids the tool does not take') as
        | { source_chunk_ids: string | null }
        | undefined;
      db.close();
      expect(decision).toBeDefined();
      expect(decision?.source_chunk_ids).toBeNull();
    });
  });

  describe('evidence references', () => {
    it('should store evidence array with decision', async () => {
      const evidence = [
        { type: 'collection', id: 'col-abc-123' },
        { type: 'document', id: 'doc-def-456' },
      ];
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Decision with evidence references',
        evidence,
      });

      expect(result.success).toBe(true);
      expect(result.data?.evidenceStored).toEqual(evidence);

      // Verify evidence was stored in database
      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT evidence FROM strategic_decisions WHERE decision_text = ?')
        .get('Decision with evidence references') as { evidence: string | null } | undefined;
      db.close();

      expect(decision).toBeDefined();
      expect(decision?.evidence).toBeDefined();
      const storedEvidence = JSON.parse(decision!.evidence!);
      expect(storedEvidence).toEqual(evidence);
      expect(storedEvidence[0].type).toBe('collection');
      expect(storedEvidence[0].id).toBe('col-abc-123');
    });

    it('should store null for decision without evidence', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Decision without evidence',
      });

      expect(result.success).toBe(true);
      expect(result.data?.evidenceStored).toBeUndefined();

      // Verify evidence is null in database
      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT evidence FROM strategic_decisions WHERE decision_text = ?')
        .get('Decision without evidence') as { evidence: string | null } | undefined;
      db.close();

      expect(decision).toBeDefined();
      expect(decision?.evidence).toBeNull();
    });

    it('should handle empty evidence array', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Decision with empty evidence',
        evidence: [],
      });

      expect(result.success).toBe(true);
      expect(result.data?.evidenceStored).toBeUndefined();

      // Verify evidence is null when empty array
      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT evidence FROM strategic_decisions WHERE decision_text = ?')
        .get('Decision with empty evidence') as { evidence: string | null } | undefined;
      db.close();

      expect(decision?.evidence).toBeNull();
    });

    it('should store evidence alongside the mission', async () => {
      const evidence = [{ type: 'chunk', id: 'chunk-xyz-789' }];
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Decision with all provenance fields',
        missionId: 's14-m01',
        evidence,
      });

      expect(result.success).toBe(true);
      expect(result.data?.evidenceStored).toEqual(evidence);
      expect(result.data?.missionId).toBe('s14-m01');

      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT evidence, mission_id FROM strategic_decisions WHERE decision_text = ?')
        .get('Decision with all provenance fields') as
        | { evidence: string | null; mission_id: string | null }
        | undefined;
      db.close();

      expect(decision).toBeDefined();
      expect(JSON.parse(decision!.evidence!)).toEqual(evidence);
      expect(decision!.mission_id).toBe('s14-m01');
    });

    it('should not store evidence for non-decision categories', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'learning',
        content: 'Learning with evidence should ignore it',
        evidence: [{ type: 'collection', id: 'col-ignored' }],
      });

      expect(result.success).toBe(true);
      expect(result.data?.evidenceStored).toBeUndefined();
    });
  });

  describe('mission association', () => {
    it('should store missionId in capture JSON', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Decision linked to mission',
        missionId: 's14-m01',
      });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('s14-m01');

      // Verify capture JSON includes missionId
      const db = new Database(dbPath);
      const session = db
        .prepare('SELECT captures FROM sessions WHERE id = ?')
        .get(activeSessionId) as { captures: string };
      db.close();

      const captures = JSON.parse(session.captures);
      expect(captures[0].missionId).toBe('s14-m01');
    });

    it('should create strategic_decisions with mission_id when category=decision', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Mission-linked decision',
        missionId: 's14-m01',
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisionExtractionCount).toBe(1);

      // Verify strategic_decisions record has mission_id
      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT mission_id, sprint_id FROM strategic_decisions WHERE decision_text = ?')
        .get('Mission-linked decision') as {
        mission_id: string | null;
        sprint_id: string | null;
      };
      db.close();

      expect(decision.mission_id).toBe('s14-m01');
      expect(decision.sprint_id).toBe('sprint-14');
    });

    it('should use mission sprint_id when missionId provided', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Decision with mission sprint',
        missionId: 's14-m01',
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT sprint_id FROM strategic_decisions WHERE decision_text = ?')
        .get('Decision with mission sprint') as { sprint_id: string | null };
      db.close();

      expect(decision.sprint_id).toBe('sprint-14');
    });

    it('should not store missionId for non-decision categories', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'learning',
        content: 'Learning with mission context',
        missionId: 's14-m01',
      });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('s14-m01');

      // But no strategic_decisions record created
      const db = new Database(dbPath);
      const count = db.prepare('SELECT COUNT(*) as count FROM strategic_decisions').get() as {
        count: number;
      };
      db.close();

      expect(count.count).toBe(0);
    });

    it('should still store capture without missionId', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Decision without mission',
      });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBeUndefined();
      expect(result.data?.decisionExtractionCount).toBe(1);

      // Verify no mission_id in strategic_decisions
      const db = new Database(dbPath);
      const decision = db
        .prepare('SELECT mission_id FROM strategic_decisions WHERE decision_text = ?')
        .get('Decision without mission') as { mission_id: string | null };
      db.close();

      expect(decision.mission_id).toBeNull();
    });
  });

  describe('sprint linkage through the real tool path', () => {
    it('captures review-session decisions without missionId and keeps them visible in sprint queries', async () => {
      const reviewSessionId = 'RS-2024-01-15-001';
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
         VALUES (?, 'review', 'Sprint Review', 'sprint-14', '2024-01-15T12:00:00Z', 'active', '[]')`
      ).run(reviewSessionId);
      db.close();

      const capture = await cmosSessionCapture({
        sessionId: reviewSessionId,
        category: 'decision',
        content: 'Review-session decision without mission link',
        projectRoot,
      });

      expect(capture.success).toBe(true);
      expect(capture.data?.missionId).toBeUndefined();
      expect(capture.data?.decisionExtractionCount).toBe(1);

      const listResult = await cmosDecisionsList({ sprintId: 'sprint-14', projectRoot });

      expect(listResult.success).toBe(true);
      const decision = listResult.data?.decisions.find(
        (entry) => entry.decision === 'Review-session decision without mission link'
      );
      expect(decision).toBeDefined();
      expect(decision?.sprintId).toBe('sprint-14');
    });

    it('infers sprint from active work when session sprint_id and missionId are both missing', async () => {
      const db = new Database(dbPath);
      db.prepare('UPDATE sessions SET sprint_id = NULL WHERE id = ?').run(activeSessionId);
      db.close();

      const capture = await cmosSessionCapture({
        sessionId: activeSessionId,
        category: 'decision',
        content: 'Decision with inferred sprint linkage',
        projectRoot,
      });

      expect(capture.success).toBe(true);
      expect(capture.data?.decisionExtractionCount).toBe(1);

      const verificationDb = new Database(dbPath);
      const decision = verificationDb
        .prepare('SELECT sprint_id FROM strategic_decisions WHERE decision_text = ?')
        .get('Decision with inferred sprint linkage') as
        | {
            sprint_id: string | null;
          }
        | undefined;
      verificationDb.close();

      expect(decision?.sprint_id).toBe('sprint-14');
    });
  });

  describe('error handling', () => {
    it('s92-m03: with no session open, the shipped handler lands the capture in an implicit session', async () => {
      // Close all sessions
      const db = new Database(dbPath);
      db.exec("UPDATE sessions SET status = 'completed'");
      db.close();

      // The SHIPPED handler, not this file's cmosSessionCaptureWithDb, which copies 3.1.0 logic
      // and would still refuse.
      const result = await cmosSessionCapture({
        category: 'decision',
        content: 'Test decision',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.implicitSession).toEqual({ opened: true });
    });

    it('should return error for empty content', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: '',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosSessionCaptureToolDefinition.name).toBe('cmos_session_capture');
    });

    it('should have description', () => {
      expect(cmosSessionCaptureToolDefinition.description).toBeTruthy();
      expect(cmosSessionCaptureToolDefinition.description.toLowerCase()).toContain('capture');
    });

    it('should have valid input schema', () => {
      expect(cmosSessionCaptureToolDefinition.inputSchema.type).toBe('object');
      expect(cmosSessionCaptureToolDefinition.inputSchema.required).toContain('category');
      expect(cmosSessionCaptureToolDefinition.inputSchema.required).toContain('content');
    });

    it('should have all valid categories', () => {
      expect(VALID_CAPTURE_CATEGORIES).toContain('decision');
      expect(VALID_CAPTURE_CATEGORIES).toContain('learning');
      expect(VALID_CAPTURE_CATEGORIES).toContain('constraint');
      expect(VALID_CAPTURE_CATEGORIES).toContain('context');
      expect(VALID_CAPTURE_CATEGORIES).toContain('next-step');
    });
  });

  describe('formatSessionCaptureForLLM', () => {
    it('should format decision capture with extraction info', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Test decision',
      });

      const formatted = formatSessionCaptureForLLM(result);

      expect(formatted).toContain('Decision Captured');
      expect(formatted).toContain('Test decision');
      expect(formatted).toContain('Auto-extracted');
    });

    it('should format duplicate decision with info', async () => {
      // First capture
      await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Duplicate decision',
      });

      // Second capture (duplicate)
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'decision',
        content: 'Duplicate decision',
      });

      const formatted = formatSessionCaptureForLLM(result);

      expect(formatted).toContain('Already exists');
    });

    it('should format non-decision category without extraction info', async () => {
      const result = await cmosSessionCaptureWithDb(dbPath, {
        category: 'learning',
        content: 'Test learning',
      });

      const formatted = formatSessionCaptureForLLM(result);

      expect(formatted).toContain('Learning Captured');
      expect(formatted).not.toContain('Auto-extracted');
      expect(formatted).not.toContain('Already exists');
    });
  });
});

/**
 * s92-m10: every case runs the SHIPPED handler. This helper used to hold a private copy of the
 * 3.1.0 capture handler, so these cases tested code that no longer shipped (an implicit session,
 * for one, never appeared). It now resolves the fixture's project root from its database path and
 * calls cmosSessionCapture.
 */
async function cmosSessionCaptureWithDb(
  dbPath: string,
  params: {
    sessionId?: string;
    category: 'decision' | 'learning' | 'constraint' | 'context' | 'next-step';
    content: string;
    context?: string;
    agent?: string;
    sourceChunkIds?: string[];
    missionId?: string;
    evidence?: Array<{ type: string; id: string }>;
  }
): ReturnType<typeof cmosSessionCapture> {
  return cmosSessionCapture({
    ...params,
    projectRoot: path.resolve(path.dirname(dbPath), '..', '..'),
  } as Parameters<typeof cmosSessionCapture>[0]);
}
