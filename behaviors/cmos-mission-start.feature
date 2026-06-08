Feature: Start a mission
  As an agent or developer
  I want to start a mission
  So that it transitions to In Progress and I can begin work

  # --- Happy path ---

  Scenario: Start a queued mission
    Given a mission "work-m01" exists with status "Queued"
    When I call cmos_mission_start with missionId "work-m01"
    Then the mission status transitions to "In Progress"
    And the response includes previousStatus "Queued" and currentStatus "In Progress"
    And started_at is set on the mission

  Scenario: Start a current mission
    Given a mission "work-m02" exists with status "Current"
    When I call cmos_mission_start with missionId "work-m02"
    Then the mission status transitions to "In Progress"
    And the response includes previousStatus "Current" and currentStatus "In Progress"

  Scenario: Start a mission with notes
    Given a mission "work-m03" exists with status "Queued"
    When I call cmos_mission_start with missionId "work-m03" and notes "Starting fresh approach"
    Then the mission status transitions to "In Progress"
    And the mission notes field contains "[Started] Starting fresh approach"
    And any pre-existing notes are preserved with a " | " separator

  Scenario: Re-starting preserves the original start time
    Given a mission "work-m04" was previously started and has a started_at timestamp
    And the mission has been returned to "Queued" status
    When I call cmos_mission_start with missionId "work-m04"
    Then the mission transitions to "In Progress"
    And the started_at timestamp is unchanged from its original value

  Scenario: Starting a mission auto-activates a Planned parent sprint
    Given a mission "work-m05" exists with status "Queued"
    And its parent sprint has status "Planned"
    When I call cmos_mission_start with missionId "work-m05"
    Then the mission transitions to "In Progress"
    And the parent sprint transitions from "Planned" to "Active"

  Scenario: Relevant strategic decisions are surfaced on start
    Given a mission "work-m06" exists with status "Queued" and a meaningful objective
    And active strategic decisions exist that match the mission's objective
    When I call cmos_mission_start with missionId "work-m06"
    Then the response includes a relevantDecisions list with up to 5 matching decisions
    And each decision includes decisionText, category, and evidence

  Scenario: No decisions surfaced when none match
    Given a mission "work-m07" exists with status "Queued" and an objective
    And no strategic decisions match that objective
    When I call cmos_mission_start with missionId "work-m07"
    Then the mission transitions to "In Progress"
    And the response does not include a relevantDecisions field

  # --- State transition failures ---

  Scenario: Reject starting a mission already In Progress
    Given a mission "work-m08" exists with status "In Progress"
    When I call cmos_mission_start with missionId "work-m08"
    Then the call fails with error code "MISSION_INVALID_STATE"
    And the error describes the current status
    And the error suggests using cmos_mission_complete or cmos_mission_block

  Scenario: Reject starting a Blocked mission
    Given a mission "work-m09" exists with status "Blocked"
    When I call cmos_mission_start with missionId "work-m09"
    Then the call fails with error code "MISSION_INVALID_TRANSITION"
    And the error instructs to use cmos_mission_unblock first with a resolution

  Scenario: Reject starting a Completed mission
    Given a mission "work-m10" exists with status "Completed"
    When I call cmos_mission_start with missionId "work-m10"
    Then the call fails with error code "MISSION_INVALID_TRANSITION"

  # --- Other failures ---

  Scenario: Reject missing missionId
    When I call cmos_mission_start with an empty missionId
    Then the call fails with error code "MISSING_PARAMETER"

  Scenario: Reject when mission does not exist
    Given no mission with id "ghost-m01" exists
    When I call cmos_mission_start with missionId "ghost-m01"
    Then the call fails with error code "MISSION_NOT_FOUND"

  Scenario: Database failure is transactionally safe
    Given a mission "work-m11" exists with status "Queued"
    When the database write fails after the transaction has begun
    Then the transaction is rolled back
    And the mission status remains "Queued"
    And the call fails with error code "DB_QUERY_FAILED"

  # --- Side effects ---

  Scenario: Starting a mission is recorded in the audit log
    Given a mission "work-m12" exists with status "Queued"
    When I call cmos_mission_start with missionId "work-m12" successfully
    Then a row is inserted into the session_events table for the start action
    And updated_at is set to the current timestamp on the mission
