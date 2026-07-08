// ABOUTME: Tests for cmos_review — sprint-64 m03 bundled session-opener digest.
// ABOUTME: Verifies ≤4KB budget, flat top-level next_actions, project-only scope, and bundling behavior.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosReview,
  cmosReviewToolDefinition,
  formatReviewForLLM,
  type CmosReviewResult,
} from '../../../src/tools/cmos/cmos-review';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('cmos_review', () => {
  let tempDir: string;
  let dbPath: string;

  function seedMinimalDb(): void {
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT REFERENCES sprints(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT
      );

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
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

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT
      );

      INSERT INTO sprints (id, title, status, focus)
      VALUES ('sprint-64', 'Foundation propagation', 'Active', 'Walkthrough round-trip');

      INSERT INTO missions (id, sprint_id, name, status, objective)
      VALUES
        ('s64-m01', 'sprint-64', 'Hard rules propagation', 'Completed', 'Propagate'),
        ('s64-m02', 'sprint-64', 'Refresh prompt', 'Queued', 'Refresh build-session-prompt.md'),
        ('s64-m03', 'sprint-64', 'Ship cmos_review', 'In Progress', 'Implement bundled tool');

      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'master_context',
        'context/MASTER_CONTEXT.json',
        '{"project_identity":{"name":"CMOS-MCP Pro","description":"Bundled session-opener test","status":"active_development"}}',
        '2026-05-25T10:00:00Z'
      ),
      (
        'project_context',
        'context/PROJECT_CONTEXT.json',
        '{"working_memory":{"next_steps":["Ship cmos_review","Run lint"]}}',
        '2026-05-25T11:00:00Z'
      );

      INSERT INTO sessions (id, type, title, started_at, status, captures)
      VALUES ('PS-2026-05-25-001', 'review', 'Walkthrough', '2026-05-25T09:00:00Z', 'completed', '[]');

      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id)
      VALUES
        ('Decision one — bundled tool', '2026-05-25T10:00:00Z', 'sprint-64'),
        ('Decision two — project-only', '2026-05-24T10:00:00Z', 'sprint-64'),
        ('Decision three — top-level next_actions', '2026-05-23T10:00:00Z', 'sprint-64');
    `);
    db.close();
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-review-test-'));
    seedMinimalDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── Tool definition shape ──────────────────────────────────────────────

  describe('tool definition', () => {
    it('registers under name cmos_review with describing schema', () => {
      expect(cmosReviewToolDefinition.name).toBe('cmos_review');
      expect(cmosReviewToolDefinition.description.length).toBeGreaterThan(20);
      expect(cmosReviewToolDefinition.inputSchema.type).toBe('object');
      expect(cmosReviewToolDefinition.inputSchema.properties).toHaveProperty('projectRoot');
      // Sprint 56 m02 — additionalProperties: false hardens against misspelled fields.
      expect(cmosReviewToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  // ─── Digest shape ───────────────────────────────────────────────────────

  describe('digest payload', () => {
    it('returns a digest with the required flat top-level fields', async () => {
      const result = await cmosReview({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const digest = result.data as CmosReviewResult;

      // Flat top-level surface — none of these may be nested.
      expect(digest).toHaveProperty('next_actions');
      expect(digest).toHaveProperty('project');
      expect(digest).toHaveProperty('sprint');
      expect(digest).toHaveProperty('workQueue');
      expect(digest).toHaveProperty('recentDecisions');
      expect(digest).toHaveProperty('freshness');
      expect(digest).toHaveProperty('warnings');
      expect(digest).toHaveProperty('digestSizeBytes');
    });

    it('exposes next_actions as a flat top-level array (not buried inside suggestedActions)', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      expect(Array.isArray(digest.next_actions)).toBe(true);
      // Promoted to top — must NOT live inside a suggestedActions wrapper.
      expect((digest as unknown as Record<string, unknown>).suggestedActions).toBeUndefined();
    });

    it('limits next_actions to at most 3 entries', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;
      expect(digest.next_actions.length).toBeLessThanOrEqual(3);
    });

    it('includes compact project identity (name + cmos_address + status + tier)', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      expect(digest.project.name).toBe('CMOS-MCP Pro');
      expect(digest.project).toHaveProperty('cmos_address');
      expect(typeof digest.project.cmos_address).toBe('string');
      expect(digest.project).toHaveProperty('status');
      expect(digest.project).toHaveProperty('tier');
    });

    it('includes current sprint summary when one exists', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      expect(digest.sprint).not.toBeNull();
      expect(digest.sprint?.id).toBe('sprint-64');
      expect(digest.sprint?.title).toBe('Foundation propagation');
    });

    it('caps sprint focus to ~280 chars', async () => {
      const longFocus = 'X'.repeat(600);
      const db = new Database(dbPath);
      db.prepare('UPDATE sprints SET focus = ? WHERE id = ?').run(longFocus, 'sprint-64');
      db.close();

      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      expect(digest.sprint?.focus).not.toBeNull();
      expect((digest.sprint?.focus ?? '').length).toBeLessThanOrEqual(280);
    });
  });

  // ─── Project-only scope (no cross-project status) ───────────────────────

  describe('project-only scope', () => {
    it('does not expose cross-project status fields in the default response', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as unknown as Record<string, unknown>;

      // The whole point of cmos_review (s64-m03 decision #672) is that it
      // does NOT walk the project registry. Guard against accidental
      // reintroduction by failing if any cross-project-shaped field appears.
      expect(digest.crossProjectStatus).toBeUndefined();
      expect(digest.crossProject).toBeUndefined();
      expect(digest.projects).toBeUndefined();
      expect(digest.allProjects).toBeUndefined();
    });

    it('workQueue counts reflect this project only', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      // Seeded: 1 In Progress, 1 Queued, 0 Current, 0 Blocked
      expect(digest.workQueue.inProgress.count).toBe(1);
      expect(digest.workQueue.queued.count).toBe(1);
      expect(digest.workQueue.current.count).toBe(0);
      expect(digest.workQueue.blocked.count).toBe(0);
    });

    it('workQueue surfaces top-3 mission entries per bucket (or fewer)', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      expect(digest.workQueue.inProgress.top.length).toBeLessThanOrEqual(3);
      expect(digest.workQueue.queued.top.length).toBeLessThanOrEqual(3);
      expect(digest.workQueue.current.top.length).toBeLessThanOrEqual(3);

      // Each top entry must be a compact {id, name} shape.
      for (const item of digest.workQueue.inProgress.top) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('name');
      }
    });
  });

  // ─── Size budget ────────────────────────────────────────────────────────

  describe('size budget', () => {
    it('keeps the digest ≤4KB under realistic load (10 sprints, 50 missions, 100 decisions)', async () => {
      const db = new Database(dbPath);

      // Wipe seed-fixture rows so we can add a deterministic realistic load.
      db.exec(`
        DELETE FROM missions;
        DELETE FROM strategic_decisions;
        DELETE FROM sprints;
      `);

      // 10 sprints
      const insertSprint = db.prepare(
        'INSERT INTO sprints (id, title, status, focus) VALUES (?, ?, ?, ?)'
      );
      for (let i = 1; i <= 10; i++) {
        const status = i === 10 ? 'Active' : 'Completed';
        insertSprint.run(
          `sprint-${i}`,
          `Sprint ${i} - realistic title with descriptive name`,
          status,
          `Focus area for sprint ${i} that describes the body of work in this cycle`
        );
      }

      // 50 missions across sprints — distribute statuses
      const insertMission = db.prepare(
        'INSERT INTO missions (id, sprint_id, name, status, objective) VALUES (?, ?, ?, ?, ?)'
      );
      for (let i = 1; i <= 50; i++) {
        const sprintNum = Math.min(10, Math.ceil(i / 5));
        const status =
          i === 49 ? 'In Progress' : i === 50 ? 'Queued' : i % 7 === 0 ? 'Blocked' : 'Completed';
        insertMission.run(
          `s${sprintNum}-m${String(i).padStart(2, '0')}`,
          `sprint-${sprintNum}`,
          `Mission ${i} with a moderately descriptive name`,
          status,
          `Objective text for mission ${i}`
        );
      }

      // 100 decisions
      const insertDecision = db.prepare(
        'INSERT INTO strategic_decisions (decision_text, created_at, sprint_id) VALUES (?, ?, ?)'
      );
      for (let i = 1; i <= 100; i++) {
        const sprintNum = Math.min(10, Math.ceil(i / 10));
        const ts = `2026-05-${String(Math.min(28, i)).padStart(2, '0')}T10:00:00Z`;
        insertDecision.run(
          `Strategic decision number ${i} — moderately long body text simulating a realistic captured decision`,
          ts,
          `sprint-${sprintNum}`
        );
      }
      db.close();

      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      const payloadBytes = Buffer.byteLength(JSON.stringify(digest), 'utf8');
      expect(payloadBytes).toBeLessThanOrEqual(4096);
      // Tool also self-reports the size — must match what we measured externally.
      expect(digest.digestSizeBytes).toBe(payloadBytes);
    });
  });

  // ─── Projection of recent decisions ─────────────────────────────────────

  describe('recent decisions', () => {
    it('returns at most 5 recent decisions in {text, createdAt} compact shape', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      expect(digest.recentDecisions.length).toBeLessThanOrEqual(5);
      for (const d of digest.recentDecisions) {
        expect(d).toHaveProperty('text');
        expect(d).toHaveProperty('createdAt');
        // Compact form must not carry full domain/category/etc fields.
        const keys = Object.keys(d).sort();
        expect(keys).toEqual(['createdAt', 'text']);
      }
    });
  });

  // ─── Freshness signal ───────────────────────────────────────────────────

  describe('freshness', () => {
    it('exposes lagDays and isStale as the only freshness fields', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      const keys = Object.keys(digest.freshness).sort();
      expect(keys).toEqual(['isStale', 'lagDays']);
      expect(typeof digest.freshness.lagDays).toBe('number');
      expect(typeof digest.freshness.isStale).toBe('boolean');
    });
  });

  // ─── Build freshness (Sprint 67 m03) ────────────────────────────────────

  describe('buildFreshness signal', () => {
    function writeSrcFile(relativePath: string, mtime?: Date): void {
      const fullPath = path.join(tempDir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `// ${relativePath}\n`);
      if (mtime) fs.utimesSync(fullPath, mtime, mtime);
    }

    function writeDistManifest(buildTime: Date): void {
      const distDir = path.join(tempDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, '.build-manifest.json'),
        JSON.stringify({ buildHash: 'x', buildTime: buildTime.toISOString(), fileCount: 1 })
      );
    }

    it('omits buildFreshness when src is missing (dist-only install path)', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;
      expect(digest.buildFreshness).toBeUndefined();
    });

    it('omits buildFreshness when dist/ is fresh relative to src/', async () => {
      const oldSrc = new Date(Date.now() - 60_000);
      writeSrcFile('src/foo.ts', oldSrc);
      writeDistManifest(new Date());

      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;
      expect(digest.buildFreshness).toBeUndefined();
    });

    it('attaches buildFreshness AND promotes a priority-1 next_action when stale', async () => {
      const buildTime = new Date(Date.now() - 60_000);
      writeDistManifest(buildTime);
      writeSrcFile('src/foo.ts', new Date());

      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      expect(digest.buildFreshness).toBeDefined();
      expect(digest.buildFreshness?.stale).toBe(true);
      // The freshness action must be first in next_actions with priority=1.
      expect(digest.next_actions.length).toBeGreaterThan(0);
      expect(digest.next_actions[0].priority).toBe(1);
      expect(digest.next_actions[0].command).toBe('npm run build');
      expect(digest.next_actions.length).toBeLessThanOrEqual(3);
    });

    it('attaches buildFreshness with dist-missing reason when dist/ is absent entirely', async () => {
      writeSrcFile('src/foo.ts');

      const result = await cmosReview({ projectRoot: tempDir });
      const digest = result.data as CmosReviewResult;

      expect(digest.buildFreshness?.stale).toBe(true);
      expect(digest.buildFreshness?.reason).toBe('dist-missing');
      expect(digest.next_actions[0].action).toContain('build output missing');
    });
  });

  // ─── Format helper ──────────────────────────────────────────────────────

  describe('formatReviewForLLM', () => {
    it('returns a human-readable string for a success result', async () => {
      const result = await cmosReview({ projectRoot: tempDir });
      const formatted = formatReviewForLLM(result);
      expect(formatted).toContain('CMOS-MCP Pro');
      expect(formatted).toContain('sprint-64');
    });

    it('formats error results with the actionable message', () => {
      const formatted = formatReviewForLLM({
        success: false,
        error: { code: 'DB_NOT_FOUND', message: 'no db', suggestion: 'run cmos_project init' },
      });
      expect(formatted).toContain('no db');
      expect(formatted).toContain('run cmos_project init');
    });
  });
});
