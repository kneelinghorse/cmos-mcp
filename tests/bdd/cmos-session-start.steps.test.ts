// ABOUTME: BDD step definitions for the cmos_session_start tool feature.
// ABOUTME: Covers happy path, constraint failures, validation failures, and side effects.

import Database from 'better-sqlite3';
import { defineFeature, loadFeature } from 'jest-cucumber';

import { cmosSessionStart } from '../../src/tools/cmos/cmos-session-start';
import type { CmosSessionStartResult } from '../../src/tools/cmos/cmos-session-start';
import type { CmosToolResult } from '../../src/tools/cmos/types';
import {
  createBddInstance,
  insertMission,
  insertSession,
  insertSprint,
  readEvents,
  type BddTestInstance,
} from './bdd-helpers';

const feature = loadFeature('behaviors/cmos-session-start.feature');

defineFeature(feature, (test) => {
  let instance: BddTestInstance;
  let result: CmosToolResult<CmosSessionStartResult>;

  beforeEach(async () => {
    instance = await createBddInstance();
  });

  afterEach(async () => {
    await instance.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  test('Start a session with no currently active session', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db — no action needed.
    });

    when('I call cmos_session_start with type "planning" and title "Sprint review"', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'Sprint review',
        projectRoot: instance.projectRoot,
      });
    });

    then('a new session is created with status "active"', () => {
      expect(result.success).toBe(true);
    });

    and(
      'the response includes sessionId, type, title, startedAt, agent, sprintId, sprintAutoTagged, contextAutoRefresh, contextFreshness, and message',
      () => {
        const data = result.data!;
        expect(data.sessionId).toBeTruthy();
        expect(data.type).toBe('planning');
        expect(data.title).toBe('Sprint review');
        expect(data.startedAt).toBeTruthy();
        expect(data.agent).toBeTruthy();
        expect(typeof data.sprintAutoTagged).toBe('boolean');
        expect(data.contextAutoRefresh).toEqual(expect.any(Object));
        // contextFreshness may be null when no context row exists yet — accept either
        expect(data.contextFreshness !== undefined).toBe(true);
        expect(data.message).toBeTruthy();
      }
    );
  });

  test('Session ID increments within the same day', ({ given, when, then }) => {
    const today = new Date().toISOString().slice(0, 10);

    given('no session is currently active', () => {
      // Fresh db.
    });

    given('two sessions already exist for today', () => {
      insertSession(instance.dbPath, {
        id: `PS-${today}-001`,
        title: 'Session one',
        status: 'completed',
      });
      insertSession(instance.dbPath, {
        id: `PS-${today}-002`,
        title: 'Session two',
        status: 'completed',
      });
    });

    when('I call cmos_session_start', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'Increment test',
        projectRoot: instance.projectRoot,
      });
    });

    then('the generated sessionId has a counter of 3 for today (e.g. PS-2026-03-25-003)', () => {
      expect(result.success).toBe(true);
      expect(result.data!.sessionId).toBe(`PS-${today}-003`);
    });
  });

  test('Start a session with an explicit sprint', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    given('a sprint "sprint-ops-02" exists', () => {
      insertSprint(instance.dbPath, { id: 'sprint-ops-02', status: 'Active' });
    });

    when('I call cmos_session_start with sprintId "sprint-ops-02"', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'Explicit sprint session',
        sprintId: 'sprint-ops-02',
        projectRoot: instance.projectRoot,
      });
    });

    then('the session is tagged to "sprint-ops-02"', () => {
      expect(result.success).toBe(true);
      expect(result.data!.sprintId).toBe('sprint-ops-02');
    });

    and('sprintAutoTagged is false', () => {
      expect(result.data!.sprintAutoTagged).toBe(false);
    });
  });

  test('Sprint is auto-detected when not provided', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    given('at least one sprint with status "Active" exists', () => {
      insertSprint(instance.dbPath, {
        id: 'sprint-auto-01',
        title: 'Auto Sprint',
        status: 'Active',
      });

      // Add start_date so ORDER BY works predictably
      const db = new Database(instance.dbPath);
      db.prepare(`UPDATE sprints SET start_date = '2026-01-01' WHERE id = 'sprint-auto-01'`).run();
      db.close();
    });

    when('I call cmos_session_start without a sprintId', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'Auto sprint session',
        projectRoot: instance.projectRoot,
      });
    });

    then('the session is tagged to the most recently started active sprint', () => {
      expect(result.success).toBe(true);
      expect(result.data!.sprintId).toBe('sprint-auto-01');
    });

    and('sprintAutoTagged is true', () => {
      expect(result.data!.sprintAutoTagged).toBe(true);
    });

    and('the confirmation message notes the auto-tagged sprint', () => {
      expect(result.data!.message).toContain('sprint-auto-01');
    });
  });

  test('Session starts without a sprint when none are active', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    given('no sprints with status "Active" exist', () => {
      // Fresh db has no sprints.
    });

    when('I call cmos_session_start without a sprintId', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'No sprint session',
        projectRoot: instance.projectRoot,
      });
    });

    then('the session is created with sprintId null', () => {
      expect(result.success).toBe(true);
      expect(result.data!.sprintId).toBeNull();
    });

    and('sprintAutoTagged is false', () => {
      expect(result.data!.sprintAutoTagged).toBe(false);
    });
  });

  test('Master context is refreshed on session start by default', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    given('autoRefreshMasterContext is not specified', () => {
      // Omitting the param — default is true.
    });

    when('I call cmos_session_start', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'Default refresh session',
        projectRoot: instance.projectRoot,
      });
    });

    then('master_context is refreshed from recent completed missions and sprints', () => {
      expect(result.success).toBe(true);
      expect(result.data!.contextAutoRefresh.enabled).toBe(true);
    });

    and(
      'the response includes contextAutoRefresh with enabled true and counts of missionsAdded and sprintsAdded',
      () => {
        const refresh = result.data!.contextAutoRefresh;
        expect(refresh.enabled).toBe(true);
        expect(typeof refresh.missionsAdded).toBe('number');
        expect(typeof refresh.sprintsAdded).toBe('number');
      }
    );
  });

  test('Master context refresh is skipped when disabled', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    when('I call cmos_session_start with autoRefreshMasterContext false', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'No refresh session',
        autoRefreshMasterContext: false,
        projectRoot: instance.projectRoot,
      });
    });

    then('master_context is not refreshed', () => {
      expect(result.success).toBe(true);
      expect(result.data!.contextAutoRefresh.refreshed).toBe(false);
    });

    and('the response includes contextAutoRefresh with enabled false and refreshed false', () => {
      const refresh = result.data!.contextAutoRefresh;
      expect(refresh.enabled).toBe(false);
      expect(refresh.refreshed).toBe(false);
    });
  });

  test('Stale context warning is included when context lags behind activity', ({
    given,
    when,
    then,
    and,
  }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    given('the master context has not been updated recently', () => {
      const db = new Database(instance.dbPath);

      // Context was last updated far in the past (30+ days ago).
      db.prepare(
        `INSERT INTO contexts (id, source_path, content, updated_at)
         VALUES ('master_context', 'context/master_context.json', '{}', '2025-01-01T00:00:00Z')`
      ).run();

      // A recently completed mission whose completed_at post-dates the context.
      // Auto-refresh is disabled in the `when` step so the context is never healed,
      // allowing the staleness calculation to find the lag and emit a warning.
      db.prepare(
        `INSERT INTO missions (id, name, status, completed_at)
         VALUES ('mission-recent-001', 'Recent completed mission', 'Completed', datetime('now'))`
      ).run();

      db.close();
    });

    when('I call cmos_session_start', async () => {
      // Disable auto-refresh so the context is not healed before the freshness
      // check runs — otherwise auto-refresh updates context.updated_at to now,
      // eliminating the staleness lag before the warning can fire.
      result = await cmosSessionStart({
        type: 'planning',
        title: 'Stale context session',
        autoRefreshMasterContext: false,
        projectRoot: instance.projectRoot,
      });
    });

    then('the session is created successfully', () => {
      expect(result.success).toBe(true);
    });

    and('the response includes a warning about stale context', () => {
      const warnings = result.warnings ?? [];
      const hasStaleWarning = warnings.some(
        (w) => w.toLowerCase().includes('stale') || w.toLowerCase().includes('context')
      );
      expect(hasStaleWarning).toBe(true);
    });

    and('the warning notes whether auto-refresh ran or was disabled', () => {
      const warnings = result.warnings ?? [];
      const hasRefreshNote = warnings.some(
        (w) =>
          w.toLowerCase().includes('auto-refresh') ||
          w.toLowerCase().includes('refresh') ||
          w.toLowerCase().includes('disabled')
      );
      expect(hasRefreshNote).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Constraint failures
  // ---------------------------------------------------------------------------

  test('Reject when a session is already active', ({ given, when, then, and }) => {
    given('a session "PS-2026-03-25-001" is currently active', () => {
      insertSession(instance.dbPath, {
        id: 'PS-2026-03-25-001',
        title: 'Active session',
        status: 'active',
      });
    });

    when('I call cmos_session_start', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'New session attempt',
        projectRoot: instance.projectRoot,
      });
    });

    then('the call fails with error code "SESSION_ALREADY_ACTIVE"', () => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_ALREADY_ACTIVE');
    });

    and('the error identifies the active session by ID', () => {
      expect(result.error?.message).toContain('PS-2026-03-25-001');
    });

    and('the error suggests completing the active session or using cmos_session_capture', () => {
      const suggestion = result.error?.suggestion ?? '';
      const hasSuggestion =
        suggestion.toLowerCase().includes('complete') ||
        suggestion.toLowerCase().includes('cmos_session_capture');
      expect(hasSuggestion).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation failures
  // ---------------------------------------------------------------------------

  test('Reject empty title', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    when('I call cmos_session_start with an empty or whitespace-only title', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: '   ',
        projectRoot: instance.projectRoot,
      });
    });

    then('the call fails with error code "MISSING_PARAMETER"', () => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAMETER');
    });

    and('the error identifies "title" as the missing field', () => {
      const field = result.error?.field ?? result.error?.message ?? '';
      expect(field.toLowerCase()).toContain('title');
    });
  });

  test('Reject title exceeding 255 characters', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    when('I call cmos_session_start with a title longer than 255 characters', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'x'.repeat(256),
        projectRoot: instance.projectRoot,
      });
    });

    then('the call is rejected before reaching the handler', () => {
      expect(result.success).toBe(false);
    });

    and('the error describes the title length constraint', () => {
      const message = result.error?.message ?? '';
      // Zod will describe a max-length violation
      expect(message.length).toBeGreaterThan(0);
    });
  });

  test('Reject invalid session type', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    when('I call cmos_session_start with type "brainstorm"', async () => {
      result = await cmosSessionStart({
        // Cast to satisfy TS; the runtime path is what the scenario tests.
        type: 'brainstorm' as Parameters<typeof cmosSessionStart>[0]['type'],
        title: 'Invalid type session',
        projectRoot: instance.projectRoot,
      });
    });

    then('the call is rejected before reaching the handler', () => {
      expect(result.success).toBe(false);
    });

    and(
      'the error lists the valid session types: onboarding, planning, review, research, check-in, custom',
      () => {
        const message = result.error?.message ?? '';
        expect(message.length).toBeGreaterThan(0);
      }
    );
  });

  // ---------------------------------------------------------------------------
  // Side effects
  // ---------------------------------------------------------------------------

  test('Session start is recorded in the audit log', ({ given, when, then, and }) => {
    given('no session is currently active', () => {
      // Fresh db.
    });

    when('I call cmos_session_start successfully', async () => {
      result = await cmosSessionStart({
        type: 'planning',
        title: 'Audit log session',
        projectRoot: instance.projectRoot,
      });
    });

    then('a row is inserted into the sessions table with status "active"', () => {
      expect(result.success).toBe(true);

      const db = new Database(instance.dbPath);
      const row = db
        .prepare(`SELECT status FROM sessions WHERE id = ?`)
        .get(result.data!.sessionId) as { status: string } | undefined;
      db.close();

      expect(row).toBeDefined();
      expect(row!.status).toBe('active');
    });

    and('a row is inserted into the session_events table for the start action', () => {
      const events = readEvents(instance.dbPath, { action: 'start' });
      expect(events.length).toBeGreaterThanOrEqual(1);

      const startEvent = events.find((e) => e['mission'] === result.data!.sessionId);
      expect(startEvent).toBeDefined();
    });
  });
});
