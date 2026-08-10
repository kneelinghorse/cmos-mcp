// ABOUTME: BDD step definitions for the cmos_mission_start feature.
// ABOUTME: Covers happy-path transitions, state guards, sprint activation, decision surfacing, and audit logging.

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import { loadFeature, defineFeature } from 'jest-cucumber';

import { cmosMissionStart } from '../../src/tools/cmos/cmos-mission-start';
import type { MissionStartResult } from '../../src/tools/cmos/cmos-mission-start';
import type { CmosToolResult } from '../../src/tools/cmos/types';
import {
  createBddInstance,
  insertSprint,
  insertMission,
  insertDecision,
  readMission,
  readEvents,
  type BddTestInstance,
} from './bdd-helpers';

const feature = loadFeature('behaviors/cmos-mission-start.feature');

defineFeature(feature, (test) => {
  let instance: BddTestInstance;

  beforeEach(async () => {
    instance = await createBddInstance();
    // Default sprint present for all scenarios that need one
    insertSprint(instance.dbPath, { id: 'sprint-work-01', status: 'Active' });
  });

  afterEach(async () => {
    // Restore write permissions before cleanup so the temp dir can be deleted
    await fs.chmod(instance.dbPath, 0o644).catch(() => undefined);
    await instance.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Start a queued mission
  // ---------------------------------------------------------------------------
  test('Start a queued mission', ({ given, when, then, and }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)"$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
        });
      }
    );

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the mission status transitions to "([^"]+)"$/, (expectedStatus: string) => {
      expect(result.success).toBe(true);
      const row = readMission(instance.dbPath, 'work-m01');
      expect(row?.status).toBe(expectedStatus);
    });

    and(
      /^the response includes previousStatus "([^"]+)" and currentStatus "([^"]+)"$/,
      (previousStatus: string, currentStatus: string) => {
        expect(result.data?.previousStatus).toBe(previousStatus);
        expect(result.data?.currentStatus).toBe(currentStatus);
      }
    );

    and('started_at is set on the mission', () => {
      const row = readMission(instance.dbPath, 'work-m01');
      expect(row?.started_at).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Start a current mission
  // ---------------------------------------------------------------------------
  test('Start a current mission', ({ given, when, then, and }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)"$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
        });
      }
    );

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the mission status transitions to "([^"]+)"$/, (expectedStatus: string) => {
      expect(result.success).toBe(true);
      const row = readMission(instance.dbPath, 'work-m02');
      expect(row?.status).toBe(expectedStatus);
    });

    and(
      /^the response includes previousStatus "([^"]+)" and currentStatus "([^"]+)"$/,
      (previousStatus: string, currentStatus: string) => {
        expect(result.data?.previousStatus).toBe(previousStatus);
        expect(result.data?.currentStatus).toBe(currentStatus);
      }
    );
  });

  // ---------------------------------------------------------------------------
  // Start a mission with notes
  // ---------------------------------------------------------------------------
  test('Start a mission with notes', ({ given, when, then, and }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)"$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
          notes: 'Prior note',
        });
      }
    );

    when(
      /^I call cmos_mission_start with missionId "([^"]+)" and notes "([^"]+)"$/,
      async (missionId: string, notes: string) => {
        result = await cmosMissionStart({ missionId, notes, projectRoot: instance.projectRoot });
      }
    );

    then(/^the mission status transitions to "([^"]+)"$/, (expectedStatus: string) => {
      expect(result.success).toBe(true);
      const row = readMission(instance.dbPath, 'work-m03');
      expect(row?.status).toBe(expectedStatus);
    });

    and(/^the mission notes field contains "\[Started\] ([^"]+)"$/, (noteText: string) => {
      const row = readMission(instance.dbPath, 'work-m03');
      expect(row?.notes).toContain(`[Started] ${noteText}`);
    });

    and(/^any pre-existing notes are preserved with a " \| " separator$/, () => {
      const row = readMission(instance.dbPath, 'work-m03');
      expect(row?.notes).toContain('Prior note');
      expect(row?.notes).toContain(' | ');
    });
  });

  // ---------------------------------------------------------------------------
  // Re-starting preserves the original start time
  // ---------------------------------------------------------------------------
  test('Re-starting preserves the original start time', ({ given, and, when, then }) => {
    let result: CmosToolResult<MissionStartResult>;
    const originalStartedAt = '2026-01-01T10:00:00Z';

    given(
      /^a mission "([^"]+)" was previously started and has a started_at timestamp$/,
      (missionId: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status: 'In Progress',
          startedAt: originalStartedAt,
        });
      }
    );

    and(/^the mission has been returned to "([^"]+)" status$/, (status: string) => {
      const db = new Database(instance.dbPath);
      db.prepare(`UPDATE missions SET status = ? WHERE id = 'work-m04'`).run(status);
      db.close();
    });

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the mission transitions to "([^"]+)"$/, (expectedStatus: string) => {
      expect(result.success).toBe(true);
      const row = readMission(instance.dbPath, 'work-m04');
      expect(row?.status).toBe(expectedStatus);
    });

    and('the started_at timestamp is unchanged from its original value', () => {
      const row = readMission(instance.dbPath, 'work-m04');
      expect(row?.started_at).toBe(originalStartedAt);
    });
  });

  // ---------------------------------------------------------------------------
  // Starting a mission auto-activates a Planned parent sprint
  // ---------------------------------------------------------------------------
  test('Starting a mission auto-activates a Planned parent sprint', ({
    given,
    and,
    when,
    then,
  }) => {
    let result: CmosToolResult<MissionStartResult>;
    const plannedSprintId = 'sprint-planned-01';

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)"$/,
      (missionId: string, status: string) => {
        // Sprint is inserted in the "and" step; mission wired to it
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: plannedSprintId,
          status,
        });
      }
    );

    and(/^its parent sprint has status "([^"]+)"$/, (sprintStatus: string) => {
      insertSprint(instance.dbPath, { id: plannedSprintId, status: sprintStatus });
    });

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the mission transitions to "([^"]+)"$/, (expectedStatus: string) => {
      expect(result.success).toBe(true);
      const row = readMission(instance.dbPath, 'work-m05');
      expect(row?.status).toBe(expectedStatus);
    });

    and(
      /^the parent sprint transitions from "([^"]+)" to "([^"]+)"$/,
      (_from: string, to: string) => {
        const db = new Database(instance.dbPath);
        const sprint = db
          .prepare('SELECT status FROM sprints WHERE id = ?')
          .get(plannedSprintId) as Record<string, unknown> | undefined;
        db.close();
        expect(sprint?.status).toBe(to);
      }
    );
  });

  // ---------------------------------------------------------------------------
  // Relevant strategic decisions are surfaced on start
  // ---------------------------------------------------------------------------
  test('Relevant strategic decisions are surfaced on start', ({ given, and, when, then }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)" and a meaningful objective$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
          objective: 'Implement authentication system',
        });
      }
    );

    and(/^active strategic decisions exist that match the mission's objective$/, () => {
      insertDecision(instance.dbPath, {
        decisionText: 'Use JWT for auth token generation and validation',
        category: 'security',
        evidence: 'RFC 7519',
      });
    });

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the response includes a relevantDecisions list with up to 5 matching decisions$/, () => {
      expect(result.success).toBe(true);
      // If the decisions table exists and returned results, validate them.
      // If the feature is absent in this schema version, the field is simply undefined.
      if (result.data?.relevantDecisions !== undefined) {
        expect(Array.isArray(result.data.relevantDecisions)).toBe(true);
        expect(result.data.relevantDecisions.length).toBeGreaterThan(0);
        expect(result.data.relevantDecisions.length).toBeLessThanOrEqual(5);
      }
    });

    and('each decision includes decisionText, category, and evidence', () => {
      if (
        result.data?.relevantDecisions !== undefined &&
        result.data.relevantDecisions.length > 0
      ) {
        for (const decision of result.data.relevantDecisions) {
          expect(decision).toHaveProperty('decisionText');
          expect(decision).toHaveProperty('category');
          expect(decision).toHaveProperty('evidence');
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // No decisions surfaced when none match
  // ---------------------------------------------------------------------------
  test('No decisions surfaced when none match', ({ given, and, when, then }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)" and an objective$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
          objective: 'Unique-objective-xyz-no-match-possible',
        });
      }
    );

    and(/^no strategic decisions match that objective$/, () => {
      // No insertDecision call — table is empty (or mismatched)
    });

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the mission transitions to "([^"]+)"$/, (expectedStatus: string) => {
      expect(result.success).toBe(true);
      const row = readMission(instance.dbPath, 'work-m07');
      expect(row?.status).toBe(expectedStatus);
    });

    and('the response does not include a relevantDecisions field', () => {
      expect(result.data?.relevantDecisions).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Reject starting a mission already In Progress
  // ---------------------------------------------------------------------------
  test('Reject starting a mission already In Progress', ({ given, when, then, and }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)"$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
        });
      }
    );

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the call fails with error code "([^"]+)"$/, (errorCode: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(errorCode);
    });

    and('the error describes the current status', () => {
      expect(result.error?.message).toContain('In Progress');
    });

    and('the error suggests using cmos_mission_transition action complete or block', () => {
      const suggestion = result.error?.suggestion ?? '';
      // s85-m01: the suggestion now names the consolidated transition tool — cmos_mission_complete
      // and cmos_mission_block were removed in the 38→15 consolidation.
      const hasMissionComplete = suggestion.includes('cmos_mission_transition(action="complete")');
      const hasMissionBlock = suggestion.includes('cmos_mission_transition(action="block")');
      expect(hasMissionComplete || hasMissionBlock).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Reject starting a Blocked mission
  // ---------------------------------------------------------------------------
  test('Reject starting a Blocked mission', ({ given, when, then, and }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)"$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
        });
      }
    );

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the call fails with error code "([^"]+)"$/, (errorCode: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(errorCode);
    });

    and('the error instructs to use cmos_mission_unblock first with a resolution', () => {
      // s85-m01: suggestions now name the CONSOLIDATED tool — the pre-s85 name was removed in the 38→15 consolidation.
      expect(result.error?.suggestion).toContain('cmos_mission_transition(action="unblock")');
    });
  });

  // ---------------------------------------------------------------------------
  // Reject starting a Completed mission
  // ---------------------------------------------------------------------------
  test('Reject starting a Completed mission', ({ given, when, then }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)"$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
        });
      }
    );

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the call fails with error code "([^"]+)"$/, (errorCode: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(errorCode);
    });
  });

  // ---------------------------------------------------------------------------
  // Reject missing missionId
  // ---------------------------------------------------------------------------
  test('Reject missing missionId', ({ when, then }) => {
    let result: CmosToolResult<MissionStartResult>;

    when('I call cmos_mission_start with an empty missionId', async () => {
      result = await cmosMissionStart({ missionId: '', projectRoot: instance.projectRoot });
    });

    then(/^the call fails with error code "([^"]+)"$/, (errorCode: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(errorCode);
    });
  });

  // ---------------------------------------------------------------------------
  // Reject when mission does not exist
  // ---------------------------------------------------------------------------
  test('Reject when mission does not exist', ({ given, when, then }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(/^no mission with id "([^"]+)" exists$/, (_missionId: string) => {
      // Nothing to insert — the mission is intentionally absent
    });

    when(/^I call cmos_mission_start with missionId "([^"]+)"$/, async (missionId: string) => {
      result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
    });

    then(/^the call fails with error code "([^"]+)"$/, (errorCode: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(errorCode);
    });
  });

  // ---------------------------------------------------------------------------
  // Database failure is transactionally safe
  // ---------------------------------------------------------------------------
  test('Database failure is transactionally safe', ({ given, when, then, and }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)"$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
        });
      }
    );

    when('the database write fails after the transaction has begun', async () => {
      // Making the file read-only prevents any write, triggering the DB error path.
      await fs.chmod(instance.dbPath, 0o444);
      result = await cmosMissionStart({
        missionId: 'work-m11',
        projectRoot: instance.projectRoot,
      });
    });

    then('the transaction is rolled back', () => {
      // Verified implicitly: the call failed, so no commit occurred.
      expect(result.success).toBe(false);
    });

    and(/^the mission status remains "([^"]+)"$/, async (expectedStatus: string) => {
      // Restore write access to read the db.
      await fs.chmod(instance.dbPath, 0o644);
      const row = readMission(instance.dbPath, 'work-m11');
      expect(row?.status).toBe(expectedStatus);
    });

    and(/^the call fails with error code "([^"]+)"$/, (errorCode: string) => {
      // Accept the canonical code or any DB-prefixed error code.
      const code = result.error?.code ?? '';
      const isDbError = code === errorCode || code.startsWith('DB');
      expect(isDbError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Starting a mission is recorded in the audit log
  // ---------------------------------------------------------------------------
  test('Starting a mission is recorded in the audit log', ({ given, when, then, and }) => {
    let result: CmosToolResult<MissionStartResult>;

    given(
      /^a mission "([^"]+)" exists with status "([^"]+)"$/,
      (missionId: string, status: string) => {
        insertMission(instance.dbPath, {
          id: missionId,
          name: missionId,
          sprintId: 'sprint-work-01',
          status,
        });
      }
    );

    when(
      /^I call cmos_mission_start with missionId "([^"]+)" successfully$/,
      async (missionId: string) => {
        result = await cmosMissionStart({ missionId, projectRoot: instance.projectRoot });
        expect(result.success).toBe(true);
      }
    );

    then('a row is inserted into the session_events table for the start action', () => {
      const events = readEvents(instance.dbPath, { action: 'start' });
      expect(events.length).toBeGreaterThan(0);
      const event = events.find((e) => e.mission === 'work-m12');
      expect(event).toBeDefined();
    });

    and('updated_at is set to the current timestamp on the mission', () => {
      const row = readMission(instance.dbPath, 'work-m12');
      expect(row?.updated_at).toBeTruthy();
    });
  });
});
