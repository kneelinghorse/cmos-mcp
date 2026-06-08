/**
 * Test Helpers for CMOS Tool Tests
 *
 * Provides utilities for creating and managing test databases
 * with consistent sample data.
 *
 * @module tests/tools/cmos/fixtures/test-helpers
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDetector } from '../../../../src/intelligence/cmos-detector';

/**
 * Creates a temporary test database with the standard CMOS schema.
 *
 * @returns Object with tempDir, dbPath, and cleanup function
 */
export function createTestDatabase(): {
  tempDir: string;
  dbPath: string;
  cleanup: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-test-'));
  const dbPath = path.join(tempDir, 'cmos.sqlite');

  const db = new Database(dbPath);
  db.exec(getTestSchema());
  db.close();

  // Reset CmosDetector cache
  CmosDetector.resetInstance();

  return {
    tempDir,
    dbPath,
    cleanup: () => {
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Seeds a test database with comprehensive sample data for testing.
 *
 * @param dbPath - Path to the SQLite database
 */
export function seedTestData(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(getSampleData());
  db.close();
}

/**
 * Returns the standard CMOS test schema SQL.
 */
export function getTestSchema(): string {
  return `
    -- Sprints table
    CREATE TABLE IF NOT EXISTS sprints (
      id TEXT PRIMARY KEY,
      title TEXT,
      focus TEXT,
      status TEXT,
      start_date TEXT,
      end_date TEXT,
      total_missions INTEGER,
      completed_missions INTEGER
    );

    -- Missions table (matches production schema)
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
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

    -- Contexts table
    CREATE TABLE IF NOT EXISTS contexts (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT
    );

    -- Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      sprint_id TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      agent TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL,
      captures TEXT,
      next_steps TEXT,
      metadata TEXT
    );
  `;
}

/**
 * Returns comprehensive sample data for testing mission status queries.
 */
export function getSampleData(): string {
  return `
    -- Insert test sprints
    INSERT INTO sprints (id, title, focus, status, total_missions, completed_missions)
    VALUES
      ('sprint-11', 'Sprint 11 - Stability', 'Bug fixes and stability', 'Completed', 5, 5),
      ('sprint-12', 'Sprint 12 - CMOS Tools', 'Implement CMOS MCP tools', 'In Progress', 10, 3);

    -- Insert test missions with various statuses
    INSERT INTO missions (id, sprint_id, name, status, objective, context, success_criteria, deliverables, reference_docs, notes)
    VALUES
      -- In Progress missions
      (
        's12-m08',
        'sprint-12',
        'Tool Registration & Tests',
        'In Progress',
        'Register CMOS tools in MCP server and write tests',
        'Tools need to be registered when CMOS is detected',
        '["CMOS tools registered", "Tests pass"]',
        '["src/index.ts", "tests/"]',
        '["cmos/planning/roadmap.md"]',
        'Currently implementing'
      ),
      -- Current missions (ready to start)
      (
        's12-m09',
        'sprint-12',
        'Context View Tool',
        'Current',
        'Implement cmos_context_view tool',
        'Agents need to read aggregated contexts',
        '["Context view works", "Returns aggregated data"]',
        '["src/tools/cmos/cmos-context-view.ts"]',
        NULL,
        'Next up after current mission'
      ),
      -- Queued missions
      (
        's12-m10',
        'sprint-12',
        'Session Management',
        'Queued',
        'Implement session start/capture/complete tools',
        'Session lifecycle needs tool support',
        '["Session tools work", "Captures logged"]',
        '["src/tools/cmos/cmos-session-*.ts"]',
        NULL,
        NULL
      ),
      (
        's12-m11',
        'sprint-12',
        'Admin Tools',
        'Queued',
        'Implement backup and restore tools',
        'Database safety operations',
        '["Snapshot works", "Restore works"]',
        NULL,
        NULL,
        NULL
      ),
      (
        's12-m12',
        'sprint-12',
        'Export Tools',
        'Queued',
        'Implement export missions to YAML',
        'Export capabilities for backup',
        '["Export to YAML works"]',
        NULL,
        NULL,
        NULL
      ),
      -- Blocked mission
      (
        's12-blocked',
        'sprint-12',
        'External Integration',
        'Blocked',
        'Integrate with external service',
        'Waiting on API access',
        '["Integration complete"]',
        NULL,
        NULL,
        'Blocked: waiting for external API credentials'
      ),
      -- Completed missions
      (
        's12-m05',
        'sprint-12',
        'Mission List Tool',
        'Completed',
        'Implement cmos_mission_list',
        'Query missions with filters',
        '["List works", "Filtering works"]',
        '["src/tools/cmos/cmos-mission-list.ts"]',
        NULL,
        'Delivered with full test coverage'
      ),
      (
        's12-m06',
        'sprint-12',
        'Mission Show Tool',
        'Completed',
        'Implement cmos_mission_show',
        'Show full mission details',
        '["Show works", "Sprint context included"]',
        '["src/tools/cmos/cmos-mission-show.ts"]',
        NULL,
        'Completed on schedule'
      ),
      (
        's12-m07',
        'sprint-12',
        'Mission Status Tool',
        'Completed',
        'Implement cmos_mission_status',
        'Show work queue status',
        '["Status works", "Priority order correct"]',
        '["src/tools/cmos/cmos-mission-status.ts"]',
        NULL,
        'Work queue view implemented'
      ),
      -- Previous sprint completed mission
      (
        's11-m05',
        'sprint-11',
        'Bug Fix Task',
        'Completed',
        'Fix critical parser bug',
        NULL,
        '["Bug fixed", "Tests pass"]',
        '["src/parser.ts"]',
        NULL,
        'Hotfix delivered'
      ),
      -- Standalone mission (no sprint)
      (
        'standalone-01',
        NULL,
        'Standalone Task',
        'Queued',
        'A mission without a sprint',
        'Testing standalone handling',
        NULL,
        NULL,
        NULL,
        NULL
      );

    -- Insert test context
    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES
      ('project_context', 'context/PROJECT_CONTEXT.json', '{"sprint": "sprint-12", "activeMission": "s12-m08"}', '2024-01-15');

    -- Insert test session
    INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status)
    VALUES
      ('session-01', 'build', 'CMOS Tools Development', 'sprint-12', '2024-01-15T09:00:00Z', 'opus', 'active');
  `;
}
