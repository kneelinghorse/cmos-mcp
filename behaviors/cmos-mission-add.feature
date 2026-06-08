Feature: Create a mission
  As an agent or developer
  I want to create a new mission in a sprint
  So that I can track a unit of work with full context

  Background:
    Given a sprint "sprint-test-01" exists in the database

  # --- Happy path ---

  Scenario: Create a mission with required fields only
    Given no mission with id "test-m01" exists
    When I call cmos_mission_add with missionId "test-m01", name "Test mission", and sprintId "sprint-test-01"
    Then the mission is created with status "Queued"
    And the response includes id "test-m01", name "Test mission", sprintId "sprint-test-01", and a confirmation message

  Scenario: Create a mission with all optional fields
    Given no mission with id "test-m02" exists
    When I call cmos_mission_add with all fields populated including objective, context, successCriteria, deliverables, referenceDocs, domainFields, and notes
    Then the mission is created successfully
    And the returned mission object includes all provided fields

  Scenario: Create a mission with an explicit status
    Given no mission with id "test-m03" exists
    When I call cmos_mission_add with status "In Progress"
    Then the mission is created with status "In Progress"
    And the status is not defaulted to "Queued"

  Scenario: Create a mission with context as an object
    Given no mission with id "test-m04" exists
    When I call cmos_mission_add with a context field provided as a JSON object
    Then the mission is created successfully
    And the stored context is the JSON-serialized form of the object

  # --- Validation failures ---

  Scenario: Reject missing missionId
    When I call cmos_mission_add with an empty missionId
    Then the call fails with error code "MISSING_PARAMETER"
    And the error identifies "missionId" as the missing field

  Scenario: Reject missing name
    When I call cmos_mission_add with an empty name
    Then the call fails with error code "MISSING_PARAMETER"
    And the error identifies "name" as the missing field

  Scenario: Reject missing sprintId
    When I call cmos_mission_add with an empty sprintId
    Then the call fails with error code "MISSING_PARAMETER"
    And the error identifies "sprintId" as the missing field

  Scenario: Reject invalid status value
    Given no mission with id "test-m05" exists
    When I call cmos_mission_add with status "Done"
    Then the call fails with error code "INVALID_PARAMETER"
    And the error lists the valid status values

  # --- Precondition failures ---

  Scenario: Reject when sprint does not exist
    Given no sprint with id "sprint-ghost" exists
    When I call cmos_mission_add with sprintId "sprint-ghost"
    Then the call fails with error code "SPRINT_NOT_FOUND"

  Scenario: Reject duplicate mission ID
    Given a mission with id "test-m06" already exists
    When I call cmos_mission_add with missionId "test-m06"
    Then the call fails with error code "MISSION_ID_EXISTS"
    And the error suggests choosing a different ID or using cmos_mission_update

  # --- Side effects ---

  Scenario: Mission creation is recorded in the audit log
    Given no mission with id "test-m07" exists
    When I call cmos_mission_add successfully
    Then a row is inserted into the session_events table for the create action
    And created_at and updated_at are set to the same timestamp on the new mission
