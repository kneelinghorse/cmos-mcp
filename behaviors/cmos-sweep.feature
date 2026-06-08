Feature: Sweep open items across all registered CMOS instances
  As an agent or developer
  I want to call cmos_project sweep
  So that I can see all open missions and sessions across my entire CMOS network in one call

  # --- Envelope contract ---
  #
  # Each item in the sweep result conforms to:
  #   instance_id  : registry name (e.g. "vault-minerva")
  #   path         : absolute path to the instance root
  #   item_type    : "mission" | "session"
  #   id           : mission ID or session ID
  #   summary      : mission name or session title
  #   status       : current status string
  #   sprint_id    : sprint association, or null
  #
  # Open mission statuses: Queued, Current, In Progress, Blocked
  # Open session status  : active

  # --- Happy path ---

  Scenario: Sweep returns open missions from all registered instances
    Given the registry contains instances "vault-minerva" and "code-deety"
    And "vault-minerva" has missions with statuses "In Progress", "Queued", "Completed"
    And "code-deety" has a mission with status "Blocked"
    When I call cmos_project with action "sweep"
    Then the result contains 3 items (In Progress, Queued, Blocked)
    And the Completed mission is not included
    And each item includes instance_id, path, item_type, id, summary, status, sprint_id

  Scenario: Sweep includes open sessions
    Given the registry contains instance "vault-minerva"
    And "vault-minerva" has one active session with title "Morning planning"
    And "vault-minerva" has one completed session
    When I call cmos_project with action "sweep"
    Then the result includes the active session with item_type "session"
    And the completed session is not included

  Scenario: Sweep groups results by instance
    Given the registry contains instances "vault-minerva" and "cmos-mcp"
    And each instance has at least one open mission
    When I call cmos_project with action "sweep"
    Then the response groups items under their respective instance_id
    And vault-minerva items appear separately from cmos-mcp items

  Scenario: Sweep with no open items returns empty result
    Given the registry contains instance "code-deety"
    And "code-deety" has no open missions and no active sessions
    When I call cmos_project with action "sweep"
    Then the result is an empty list
    And the response is successful (not an error)

  # --- Filtering ---

  Scenario: Sweep filtered by instance name
    Given the registry contains instances "vault-minerva" and "code-deety"
    And both instances have open missions
    When I call cmos_project with action "sweep" and instances ["vault-minerva"]
    Then only items from "vault-minerva" are returned
    And no items from "code-deety" appear in the result

  Scenario: Sweep filtered by status
    Given the registry contains instance "vault-minerva"
    And "vault-minerva" has missions with statuses "In Progress", "Queued", "Blocked"
    When I call cmos_project with action "sweep" and statusFilter ["Blocked"]
    Then only the Blocked mission is returned

  Scenario: Sweep filtered to missions only
    Given the registry contains instance "vault-minerva"
    And "vault-minerva" has one open mission and one active session
    When I call cmos_project with action "sweep" and itemType "mission"
    Then only the mission is returned
    And no sessions appear in the result

  Scenario: Sweep filtered to sessions only
    Given the registry contains instance "vault-minerva"
    And "vault-minerva" has one open mission and one active session
    When I call cmos_project with action "sweep" and itemType "session"
    Then only the session is returned
    And no missions appear in the result

  # --- Ordering ---

  Scenario: Blocked items appear before other statuses in sweep output
    Given the registry contains instance "vault-minerva"
    And "vault-minerva" has missions with statuses "Queued", "In Progress", "Blocked"
    When I call cmos_project with action "sweep"
    Then the Blocked mission appears first in the vault-minerva group
    And In Progress appears before Queued

  # --- Resilience ---

  Scenario: Inaccessible instance is skipped with a warning
    Given the registry contains instances "vault-minerva" and "missing-project"
    And "missing-project" has no cmos/db/cmos.sqlite on disk
    And "vault-minerva" has one open mission
    When I call cmos_project with action "sweep"
    Then the result includes the vault-minerva mission
    And the response includes a warnings list noting "missing-project" was unreachable
    And no error is thrown

  Scenario: Sweep with an empty registry returns empty result
    Given the registry contains no registered instances
    When I call cmos_project with action "sweep"
    Then the result is an empty list
    And the response is successful (not an error)

  # --- Read-only contract ---

  Scenario: Sweep never writes to foreign instances
    Given the registry contains instances "vault-minerva" and "code-deety"
    And "code-deety" has one open mission
    When I call cmos_project with action "sweep"
    Then no write operations are performed against "code-deety"
    And the "code-deety" database modified-at timestamp is unchanged
