Feature: Start a session
  As an agent or developer
  I want to start a planning, research, or review session
  So that I can capture insights and decisions outside of mission build work

  # Note: only one session can be active at a time — this is a hard system constraint.

  # --- Happy path ---

  Scenario: Start a session with no currently active session
    Given no session is currently active
    When I call cmos_session_start with type "planning" and title "Sprint review"
    Then a new session is created with status "active"
    And the response includes sessionId, type, title, startedAt, agent, sprintId, sprintAutoTagged, contextAutoRefresh, contextFreshness, and message

  Scenario: Session ID increments within the same day
    Given no session is currently active
    And two sessions already exist for today
    When I call cmos_session_start
    Then the generated sessionId has a counter of 3 for today (e.g. PS-2026-03-25-003)

  Scenario: Start a session with an explicit sprint
    Given no session is currently active
    And a sprint "sprint-ops-02" exists
    When I call cmos_session_start with sprintId "sprint-ops-02"
    Then the session is tagged to "sprint-ops-02"
    And sprintAutoTagged is false

  Scenario: Sprint is auto-detected when not provided
    Given no session is currently active
    And at least one sprint with status "Active" exists
    When I call cmos_session_start without a sprintId
    Then the session is tagged to the most recently started active sprint
    And sprintAutoTagged is true
    And the confirmation message notes the auto-tagged sprint

  Scenario: Session starts without a sprint when none are active
    Given no session is currently active
    And no sprints with status "Active" exist
    When I call cmos_session_start without a sprintId
    Then the session is created with sprintId null
    And sprintAutoTagged is false

  Scenario: Master context is refreshed on session start by default
    Given no session is currently active
    And autoRefreshMasterContext is not specified
    When I call cmos_session_start
    Then master_context is refreshed from recent completed missions and sprints
    And the response includes contextAutoRefresh with enabled true and counts of missionsAdded and sprintsAdded

  Scenario: Master context refresh is skipped when disabled
    Given no session is currently active
    When I call cmos_session_start with autoRefreshMasterContext false
    Then master_context is not refreshed
    And the response includes contextAutoRefresh with enabled false and refreshed false

  Scenario: Stale context warning is included when context lags behind activity
    Given no session is currently active
    And the master context has not been updated recently
    When I call cmos_session_start
    Then the session is created successfully
    And the response includes a warning about stale context
    And the warning notes whether auto-refresh ran or was disabled

  # --- Constraint failures ---

  Scenario: Reject when a session is already active
    Given a session "PS-2026-03-25-001" is currently active
    When I call cmos_session_start
    Then the call fails with error code "SESSION_ALREADY_ACTIVE"
    And the error identifies the active session by ID
    And the error suggests completing the active session or using cmos_session_capture

  # --- Validation failures ---

  Scenario: Reject empty title
    Given no session is currently active
    When I call cmos_session_start with an empty or whitespace-only title
    Then the call fails with error code "MISSING_PARAMETER"
    And the error identifies "title" as the missing field

  Scenario: Reject title exceeding 255 characters
    Given no session is currently active
    When I call cmos_session_start with a title longer than 255 characters
    Then the call is rejected before reaching the handler
    And the error describes the title length constraint

  Scenario: Reject invalid session type
    Given no session is currently active
    When I call cmos_session_start with type "brainstorm"
    Then the call is rejected before reaching the handler
    And the error lists the valid session types: onboarding, planning, review, research, check-in, custom

  # --- Side effects ---

  Scenario: Session start is recorded in the audit log
    Given no session is currently active
    When I call cmos_session_start successfully
    Then a row is inserted into the sessions table with status "active"
    And a row is inserted into the session_events table for the start action
