# Getting Started with CMOS

**Day 0 Setup**: From fresh project to CMOS-enabled in minutes.

---

## What is CMOS?

**CMOS** (Context + Mission Orchestration System) is a project management layer for AI-assisted development. It provides:

- **SQLite-backed mission tracking** - History, sprints, dependencies
- **Context management** - PROJECT_CONTEXT, MASTER_CONTEXT with snapshots
- **Mission-based workflow** - Research → Plan → Build → Ship
- **Session management** - Capture planning, onboarding, reviews
- **MCP integration** - All operations via MCP tools, no CLI required

**Critical Principle**: CMOS is **project management**, NOT your application code.

---

## Quick Start

### 1. Initialize with cmos_project_init

```
cmos_project_init({
  projectRoot: "/path/to/your/project",
  projectName: "My Project",
  initialSprint: {
    id: "sprint-01",
    title: "Initial Sprint"
  }
})
```

This creates:

```
yourproject/
└── cmos/
    ├── db/
    │   └── cmos.sqlite  # All CMOS state
    ├── tiers/           # Tier behavioral guides
    └── docs/            # Documentation (optional)
```

### 2. Onboard

```
cmos_agent_onboard()
```

Get project state, pending missions, and recent decisions.

### 3. Start Working

```
cmos_mission_status()  # See work queue
cmos_mission_start(missionId="s01-m01")  # Begin work
```

---

## Project Structure

```
yourproject/                    # Project root
├── README.md                   # About YOUR PROJECT
├── agents.md                   # AI instructions for YOUR CODE (optional)
│
├── src/                        # YOUR APPLICATION CODE
├── tests/                      # YOUR APPLICATION TESTS
│
└── cmos/                       # PROJECT MANAGEMENT (separate!)
    ├── db/
    │   └── cmos.sqlite         # Mission tracking database
    ├── tiers/                  # Tier behavioral guides (general/managed/build)
    └── docs/                   # CMOS documentation
```

**Golden Rule**:

- Write YOUR CODE in project root
- Manage YOUR WORK in cmos/
- NEVER write application code in cmos/

---

## Core MCP Tools

| Tool                    | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `cmos_project_init`     | Initialize new CMOS project                    |
| `cmos_agent_onboard`    | Get project context for cold-start             |
| `cmos_db_health`        | Check database status                          |
| `cmos_mission_status`   | View work queue                                |
| `cmos_mission_start`    | Begin mission                                  |
| `cmos_mission_complete` | Mark mission done                              |
| `cmos_session_start`    | Start planning session                         |
| `cmos_session_capture`  | Record decisions                               |
| `cmos_session_complete` | Complete session                               |
| `cmos_context_update`   | Aggregate session insights into master_context |
| `cmos_context_view`     | View project or master context                 |

---

## Build Session Workflow

1. **Onboard**: `cmos_agent_onboard()`
2. **Check Queue**: `cmos_mission_status()`
3. **Start Mission**: `cmos_mission_start(missionId="...")`
4. **Execute Work**: Write code, create tests
5. **Complete**: `cmos_mission_complete(missionId="...", notes="...")`
6. **Repeat**: Continue with next mission

---

## Session Workflow

For planning, research, or review (not mission execution):

1. **Start**: `cmos_session_start(type="planning", title="Sprint Planning")`
2. **Capture**: `cmos_session_capture(category="decision", content="...")`
3. **Complete**: `cmos_session_complete(summary="...")`

---

## Keeping Context Fresh

After multiple sessions, aggregate captured decisions and learnings into master_context:

```
cmos_context_update()
```

This keeps your project's strategic memory up-to-date. Run periodically or at sprint boundaries.

---

## Next Steps

1. Run `cmos_agent_onboard()` to see project state
2. Run `cmos_mission_status()` to see work queue
3. Start your first mission with `cmos_mission_start()`
4. See `cmos/tiers/build.md` for build session behavioral guide

---

**Last Updated**: 2025-12-29
**Schema Version**: 2.0
