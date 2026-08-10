// ABOUTME: BDD step definitions for the cmos_mission_add tool feature spec.
// ABOUTME: Uses jest-cucumber to map Gherkin steps to production tool calls and db assertions.

import { loadFeature, defineFeature } from 'jest-cucumber';

import { cmosMissionAdd } from '../../src/tools/cmos/cmos-mission-add';
import type { MissionAddResult } from '../../src/tools/cmos/cmos-mission-add';
import { VALID_MISSION_STATUSES } from '../../src/tools/cmos/errors';
import type { CmosToolResult } from '../../src/tools/cmos/types';
import {
  createBddInstance,
  insertSprint,
  insertMission,
  readMission,
  readEvents,
  type BddTestInstance,
} from './bdd-helpers';

const feature = loadFeature('behaviors/cmos-mission-add.feature');

// Background: "Given a sprint 'sprint-test-01' exists in the database" is handled in
// beforeEach. Each test must still declare the step to satisfy jest-cucumber's step
// validation (the step body is a no-op since the sprint is already seeded).
const bgSprint = (given: (step: string, fn: () => void) => void): void => {
  given('a sprint "sprint-test-01" exists in the database', () => {
    // Handled by beforeEach
  });
};

defineFeature(feature, (test) => {
  let instance: BddTestInstance;
  let result: CmosToolResult<MissionAddResult>;

  beforeEach(async () => {
    instance = await createBddInstance();
    insertSprint(instance.dbPath, { id: 'sprint-test-01' });
  });

  afterEach(async () => {
    await instance.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  test('Create a mission with required fields only', ({ given, when, then, and }) => {
    bgSprint(given);
    given(/^no mission with id "(.*)" exists$/, (_id: string) => {
      // Fresh db — nothing to do
    });

    when(
      'I call cmos_mission_add with missionId "test-m01", name "Test mission", and sprintId "sprint-test-01"',
      async () => {
        result = await cmosMissionAdd({
          missionId: 'test-m01',
          name: 'Test mission',
          sprintId: 'sprint-test-01',
          projectRoot: instance.projectRoot,
        });
      }
    );

    then(/^the mission is created with status "(.*)"$/, (status: string) => {
      expect(result.success).toBe(true);
      expect(result.data?.status).toBe(status);
    });

    and(
      'the response includes id "test-m01", name "Test mission", sprintId "sprint-test-01", and a confirmation message',
      () => {
        expect(result.data?.id).toBe('test-m01');
        expect(result.data?.name).toBe('Test mission');
        expect(result.data?.sprintId).toBe('sprint-test-01');
        expect(result.data?.message).toBeTruthy();
      }
    );
  });

  test('Create a mission with all optional fields', ({ given, when, then, and }) => {
    bgSprint(given);
    given(/^no mission with id "(.*)" exists$/, (_id: string) => {
      // Fresh db
    });

    when(
      'I call cmos_mission_add with all fields populated including objective, context, successCriteria, deliverables, referenceDocs, domainFields, and notes',
      async () => {
        result = await cmosMissionAdd({
          missionId: 'test-m02',
          name: 'Full fields mission',
          sprintId: 'sprint-test-01',
          objective: 'Validate all optional fields are stored',
          context: 'Some background context',
          successCriteria: ['Criterion A', 'Criterion B'],
          deliverables: ['artifact.ts'],
          referenceDocs: ['docs/spec.md'],
          domainFields: { priority: 'high' },
          notes: 'Some notes here',
          projectRoot: instance.projectRoot,
        });
      }
    );

    then('the mission is created successfully', () => {
      expect(result.success).toBe(true);
    });

    and('the returned mission object includes all provided fields', () => {
      const mission = result.data?.mission;
      expect(mission?.objective).toBe('Validate all optional fields are stored');
      expect(mission?.context).toBe('Some background context');
      expect(mission?.successCriteria).toEqual(['Criterion A', 'Criterion B']);
      expect(mission?.deliverables).toEqual(['artifact.ts']);
      expect(mission?.referenceDocs).toEqual(['docs/spec.md']);
      expect(mission?.domainFields).toEqual({ priority: 'high' });
      expect(mission?.notes).toBe('Some notes here');
    });
  });

  test('Create a mission with an explicit status', ({ given, when, then, and }) => {
    bgSprint(given);
    given(/^no mission with id "(.*)" exists$/, (_id: string) => {
      // Fresh db
    });

    when('I call cmos_mission_add with status "In Progress"', async () => {
      result = await cmosMissionAdd({
        missionId: 'test-m03',
        name: 'In progress mission',
        sprintId: 'sprint-test-01',
        status: 'In Progress',
        projectRoot: instance.projectRoot,
      });
    });

    then(/^the mission is created with status "(.*)"$/, (status: string) => {
      expect(result.success).toBe(true);
      expect(result.data?.status).toBe(status);
    });

    and('the status is not defaulted to "Queued"', () => {
      expect(result.data?.status).not.toBe('Queued');
    });
  });

  test('Create a mission with context as an object', ({ given, when, then, and }) => {
    bgSprint(given);
    given(/^no mission with id "(.*)" exists$/, (_id: string) => {
      // Fresh db
    });

    when('I call cmos_mission_add with a context field provided as a JSON object', async () => {
      result = await cmosMissionAdd({
        missionId: 'test-m04',
        name: 'Context as object mission',
        sprintId: 'sprint-test-01',
        context: { key: 'value', nested: { flag: true } },
        projectRoot: instance.projectRoot,
      });
    });

    then('the mission is created successfully', () => {
      expect(result.success).toBe(true);
    });

    and('the stored context is the JSON-serialized form of the object', () => {
      const row = readMission(instance.dbPath, 'test-m04');
      expect(row).not.toBeNull();
      expect(row?.['context']).toBe(JSON.stringify({ key: 'value', nested: { flag: true } }));
    });
  });

  // ---------------------------------------------------------------------------
  // Validation failures
  // ---------------------------------------------------------------------------

  test('Reject missing missionId', ({ given, when, then, and }) => {
    bgSprint(given);
    when('I call cmos_mission_add with an empty missionId', async () => {
      result = await cmosMissionAdd({
        missionId: '',
        name: 'Some mission',
        sprintId: 'sprint-test-01',
        projectRoot: instance.projectRoot,
      });
    });

    then(/^the call fails with error code "(.*)"$/, (code: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
    });

    and(/^the error identifies "(.*)" as the missing field$/, (field: string) => {
      expect(result.error?.field).toBe(field);
    });
  });

  test('Reject missing name', ({ given, when, then, and }) => {
    bgSprint(given);
    when('I call cmos_mission_add with an empty name', async () => {
      result = await cmosMissionAdd({
        missionId: 'some-mission-id',
        name: '',
        sprintId: 'sprint-test-01',
        projectRoot: instance.projectRoot,
      });
    });

    then(/^the call fails with error code "(.*)"$/, (code: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
    });

    and(/^the error identifies "(.*)" as the missing field$/, (field: string) => {
      expect(result.error?.field).toBe(field);
    });
  });

  test('Reject missing sprintId', ({ given, when, then, and }) => {
    bgSprint(given);
    when('I call cmos_mission_add with an empty sprintId', async () => {
      result = await cmosMissionAdd({
        missionId: 'some-mission-id',
        name: 'Some mission',
        sprintId: '',
        projectRoot: instance.projectRoot,
      });
    });

    then(/^the call fails with error code "(.*)"$/, (code: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
    });

    and(/^the error identifies "(.*)" as the missing field$/, (field: string) => {
      expect(result.error?.field).toBe(field);
    });
  });

  test('Reject invalid status value', ({ given, when, then, and }) => {
    bgSprint(given);
    given(/^no mission with id "(.*)" exists$/, (_id: string) => {
      // Fresh db
    });

    when('I call cmos_mission_add with status "Done"', async () => {
      result = await cmosMissionAdd({
        missionId: 'test-m05',
        name: 'Bad status mission',
        sprintId: 'sprint-test-01',
        status: 'Done' as unknown as 'Queued',
        projectRoot: instance.projectRoot,
      });
    });

    then(/^the call fails with error code "(.*)"$/, (code: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
    });

    and('the error lists the valid status values', () => {
      const validValues = result.error?.validValues;
      expect(validValues).toBeDefined();
      for (const status of VALID_MISSION_STATUSES) {
        expect(validValues).toContain(status);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Precondition failures
  // ---------------------------------------------------------------------------

  test('Reject when sprint does not exist', ({ given, when, then }) => {
    bgSprint(given);
    given(/^no sprint with id "(.*)" exists$/, (_sprintId: string) => {
      // sprint-ghost is not inserted; fresh db only has sprint-test-01
    });

    when('I call cmos_mission_add with sprintId "sprint-ghost"', async () => {
      result = await cmosMissionAdd({
        missionId: 'test-m-ghost',
        name: 'Ghost sprint mission',
        sprintId: 'sprint-ghost',
        projectRoot: instance.projectRoot,
      });
    });

    then(/^the call fails with error code "(.*)"$/, (code: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
    });
  });

  test('Reject duplicate mission ID', ({ given, when, then, and }) => {
    bgSprint(given);
    given(/^a mission with id "(.*)" already exists$/, (id: string) => {
      insertMission(instance.dbPath, {
        id,
        name: 'Pre-existing mission',
        sprintId: 'sprint-test-01',
        status: 'Queued',
      });
    });

    when('I call cmos_mission_add with missionId "test-m06"', async () => {
      result = await cmosMissionAdd({
        missionId: 'test-m06',
        name: 'Duplicate mission',
        sprintId: 'sprint-test-01',
        projectRoot: instance.projectRoot,
      });
    });

    then(/^the call fails with error code "(.*)"$/, (code: string) => {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
    });

    and('the error suggests choosing a different ID or using cmos_mission action update', () => {
      expect(result.error?.suggestion).toMatch(/cmos_mission\(action="update"\)/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Side effects
  // ---------------------------------------------------------------------------

  test('Mission creation is recorded in the audit log', ({ given, when, then, and }) => {
    bgSprint(given);
    given(/^no mission with id "(.*)" exists$/, (_id: string) => {
      // Fresh db
    });

    when('I call cmos_mission_add successfully', async () => {
      result = await cmosMissionAdd({
        missionId: 'test-m07',
        name: 'Audit log mission',
        sprintId: 'sprint-test-01',
        projectRoot: instance.projectRoot,
      });
    });

    then('a row is inserted into the session_events table for the create action', () => {
      expect(result.success).toBe(true);
      const events = readEvents(instance.dbPath, { action: 'create' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      const event = events.find((e) => e['mission'] === 'test-m07');
      expect(event).toBeDefined();
    });

    and('created_at and updated_at are set to the same timestamp on the new mission', () => {
      const row = readMission(instance.dbPath, 'test-m07');
      expect(row).not.toBeNull();
      expect(row?.['created_at']).toBeTruthy();
      expect(row?.['updated_at']).toBeTruthy();
      expect(row?.['created_at']).toBe(row?.['updated_at']);
    });
  });
});
