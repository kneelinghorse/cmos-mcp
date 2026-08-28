# CMOS Documentation

**Documentation for the Context + Mission Orchestration System (MCP-first architecture).**

---

## Quick Start

**New to CMOS?** Start here:

1. [Getting Started](./getting-started.md) - Quick setup guide
2. [Build Session Prompt](./build-session-prompt.md) - Template for build sessions
3. [Session Management Guide](./session-management-guide.md) - Planning, reviews, research

---

## Core Documentation

| Document                                                  | Description                          |
| --------------------------------------------------------- | ------------------------------------ |
| [Getting Started](./getting-started.md)                   | Day 0 setup from fresh install       |
| [Build Session Prompt](./build-session-prompt.md)         | Template for starting build sessions |
| [Session Management Guide](./session-management-guide.md) | Planning, onboarding, reviews        |
| [SQLite Schema Reference](./sqlite-schema-reference.md)   | Database structure and queries       |

---

## Documentation by Use Case

### "I'm setting up CMOS for the first time"

1. Read [Getting Started](./getting-started.md)
2. Use `cmos_project(action="init")` to initialize

### "I'm starting a build session"

1. Use [Build Session Prompt](./build-session-prompt.md) as your template
2. Follow: onboard → status → start → execute → complete

### "I'm planning a sprint"

1. Read [Session Management Guide](./session-management-guide.md)
2. Use `cmos_session(action="start", type="planning")`

### "I need database information"

1. See [SQLite Schema Reference](./sqlite-schema-reference.md)
2. Use `cmos_db(action="health")` for quick status

---

## Key Concepts

### Sessions

Non-build work: planning, onboarding, reviews. Managed via the `cmos_session` tool.

**Types:** planning, onboarding, review, research, check-in, custom

### Missions

Build work: implementing features, writing code. Managed via `cmos_mission` (queries) and `cmos_mission_transition` (state changes).

**Lifecycle:** Queued → Current → In Progress → Completed (or Blocked)

### Contexts

- **project_context**: Current session state, working memory
- **master_context**: Project history, decisions, constraints

### Database

SQLite at `cmos/db/cmos.sqlite` is source of truth. All operations via MCP tools.

---

## MCP Tools Quick Reference

CMOS-MCP provides **15 consolidated tools** for complete project management. Every tool
below selects its operation with an `action` parameter, except `cmos_review`,
`cmos_agent_onboard` and `cmos_status`, which take only `projectRoot`.

```
# Onboarding
cmos_review()                                                 # Session-opener digest
cmos_agent_onboard()                                          # Cold-start project state
cmos_project(action="init", ...)                              # Initialize new project

# Missions — queries on cmos_mission, state changes on cmos_mission_transition
cmos_mission(action="status")                                 # View work queue
cmos_mission(action="show", missionId="...")                  # Mission details
cmos_mission(action="add", ...)                               # Create mission
cmos_mission(action="update", missionId="...")                # Update fields
cmos_mission(action="depends", ...)                           # Add dependency
cmos_mission_transition(action="start", missionId="...")      # Begin mission
cmos_mission_transition(action="complete", missionId="...")   # Mark done
cmos_mission_transition(action="block", missionId="...")      # Block mission
cmos_mission_transition(action="unblock", missionId="...")    # Unblock mission

# Sessions
cmos_session(action="start", type="...", title="...")
cmos_session(action="capture", category="...", content="...")
cmos_session(action="complete", summary="...")
cmos_session(action="list")                                   # List sessions
cmos_session(action="search", query="...")                    # Search sessions

# Sprints
cmos_sprint(action="list")                                    # List sprints
cmos_sprint(action="show", sprintId="...")                    # Sprint details
cmos_sprint(action="add", ...)                                # Create sprint
cmos_sprint(action="update", ...)                             # Update sprint
cmos_sprint(action="complete", sprintId="...")                # Close a sprint

# Context
cmos_context(action="view")                                   # View context
cmos_context(action="snapshot", ...)                          # Create snapshot
cmos_context(action="history")                                # View timeline
cmos_context(action="update")                                 # Aggregate sessions into context

# Decisions and learnings
cmos_decisions(action="list")                                 # List decisions
cmos_decisions(action="search", query="...")                  # Search decisions
cmos_learnings(action="list")                                 # List learnings

# Health
cmos_db(action="health")                                      # Check database
cmos_db(action="snapshot")                                    # Snapshot the database
```

---

**Last Updated**: 2025-12-29
**Schema Version**: 2.1 (MCP-first)
**Tool Count**: 15 consolidated tools
