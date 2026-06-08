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
2. Use `cmos_project_init()` to initialize

### "I'm starting a build session"

1. Use [Build Session Prompt](./build-session-prompt.md) as your template
2. Follow: onboard → status → start → execute → complete

### "I'm planning a sprint"

1. Read [Session Management Guide](./session-management-guide.md)
2. Use `cmos_session_start(type="planning")`

### "I need database information"

1. See [SQLite Schema Reference](./sqlite-schema-reference.md)
2. Use `cmos_db_health()` for quick status

---

## Key Concepts

### Sessions

Non-build work: planning, onboarding, reviews. Managed via `cmos_session_*` tools.

**Types:** planning, onboarding, review, research, check-in, custom

### Missions

Build work: implementing features, writing code. Managed via `cmos_mission_*` tools.

**Lifecycle:** Queued → Current → In Progress → Completed (or Blocked)

### Contexts

- **project_context**: Current session state, working memory
- **master_context**: Project history, decisions, constraints

### Database

SQLite at `cmos/db/cmos.sqlite` is source of truth. All operations via MCP tools.

---

## MCP Tools Quick Reference

CMOS-MCP provides **27+ tools** for complete project management:

```
# Onboarding
cmos_agent_onboard()                    # Get project state
cmos_project_init()                     # Initialize new project

# Missions
cmos_mission_status()                   # View work queue
cmos_mission_start(missionId="...")     # Begin mission
cmos_mission_complete(missionId="...")  # Mark done
cmos_mission_block(missionId="...")     # Block mission
cmos_mission_unblock(missionId="...")   # Unblock mission
cmos_mission_update(missionId="...")    # Update fields
cmos_mission_add(...)                   # Create mission
cmos_mission_depends(...)               # Add dependency

# Sessions
cmos_session_start(type="...", title="...")
cmos_session_capture(category="...", content="...")
cmos_session_complete(summary="...")
cmos_session_list()                     # List sessions
cmos_session_search(query="...")        # Search sessions

# Sprints
cmos_sprint_list()                      # List sprints
cmos_sprint_show(sprintId="...")        # Sprint details
cmos_sprint_add(...)                    # Create sprint
cmos_sprint_update(...)                 # Update sprint

# Context
cmos_context_view()                     # View context
cmos_context_snapshot(...)              # Create snapshot
cmos_context_history()                  # View timeline
cmos_context_update()                   # Aggregate sessions into context

# Decisions
cmos_decisions_list()                   # List decisions
cmos_decisions_search(query="...")      # Search decisions

# Health
cmos_db_health()                        # Check database
cmos_backlog_export()                   # Export backlog
```

---

**Last Updated**: 2025-12-29
**Schema Version**: 2.0 (MCP-first)
**Tool Count**: 27+
