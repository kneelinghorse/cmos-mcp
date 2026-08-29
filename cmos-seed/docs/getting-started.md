# Getting Started with CMOS

**Day 0 Setup**: From fresh project to CMOS-enabled in minutes.

---

## What is CMOS?

**CMOS** (Context + Mission Orchestration System) is a project management layer for AI-assisted development. It provides:

- **SQLite-backed mission tracking** - History, sprints, dependencies
- **Context management** - PROJECT_IDENTITY, PROJECT_CONTEXT, MASTER_CONTEXT with snapshots
- **Mission-based workflow** - Research → Plan → Build → Ship
- **Session management** - Capture planning, onboarding, reviews
- **MCP integration** - Database-backed operations via MCP tools, no CLI required

**Critical Principle**: CMOS is **project management**, NOT your application code.

---

## Quick Start

### 1. Initialize with cmos_project(action="init")

```
cmos_project({
  action: "init",
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
    ├── context/         # Seed snapshots; database wins after initialization
    ├── foundational-docs/
    ├── templates/       # Project README and agents.md templates
    ├── tiers/           # Tier behavioral guides
    └── docs/            # Documentation (always copied)
```

### 2. Onboard a New Project

```
cmos_agent_onboard()
```

Use this long-form payload for a first-run cold start. Returning work sessions normally open with
`cmos_review()` for the bounded project digest.

### 3. Start Working

```
cmos_mission(action="status")  # See work queue
cmos_mission_transition(action="start", missionId="s01-m01")  # Begin work
```

---

## Project Structure

```
yourproject/                    # Project root
├── README.md                   # About YOUR PROJECT
├── agents.md                   # Repository-wide AI rules; copy/customize cmos/templates/agents.md
│
├── src/                        # YOUR APPLICATION CODE
├── tests/                      # YOUR APPLICATION TESTS
│
└── cmos/                       # PROJECT MANAGEMENT (separate!)
    ├── db/
    │   └── cmos.sqlite         # Mission tracking database
    ├── context/                # Seed snapshots only
    ├── foundational-docs/      # Registered durable planning documents
    ├── templates/              # Customizable project templates
    ├── tiers/                  # Tier behavioral guides (general/managed/build)
    └── docs/                   # CMOS documentation
```

**Golden Rule**:

- Write YOUR CODE in project root
- Manage YOUR WORK in cmos/
- NEVER write application code in cmos/

---

## Core MCP Tools

| Call                                         | Purpose                                         |
| -------------------------------------------- | ----------------------------------------------- |
| `cmos_review()`                              | Session-opener digest (start here)              |
| `cmos_project(action="init")`                | Initialize new CMOS project                     |
| `cmos_agent_onboard()`                       | Get project context for cold-start              |
| `cmos_db(action="health")`                   | Check database status                           |
| `cmos_mission(action="status")`              | View work queue                                 |
| `cmos_mission_transition(action="start")`    | Begin mission                                   |
| `cmos_mission_transition(action="complete")` | Mark mission done                               |
| `cmos_session(action="start")`               | Start planning session                          |
| `cmos_session(action="capture")`             | Record decisions                                |
| `cmos_session(action="complete")`            | Complete session                                |
| `cmos_context(action="update")`              | Recover constraint captures into master_context |
| `cmos_context(action="view")`                | View project or master context                  |

---

## Build Session Workflow

1. **Review**: `cmos_review()`
2. **Check Queue**: `cmos_mission(action="status")`
3. **Start Mission**: `cmos_mission_transition(action="start", missionId="...")`
4. **Execute Work**: Write code, create tests
5. **Complete**: `cmos_mission_transition(action="complete", missionId="...", notes="...")`
6. **Repeat**: Continue with next mission

---

## Session Workflow

For planning, research, or review (not mission execution):

1. **Start**: `cmos_session(action="start", type="planning", title="Sprint Planning")`
2. **Capture**: `cmos_session(action="capture", category="decision", content="...")`
3. **Complete**: `cmos_session(action="complete", summary="...")`

---

## Keeping Context Fresh

Ordinary session completion already persists decisions, learnings, constraints, and context. Use
the aggregate update only as a recovery/backfill path for constraint captures:

```
cmos_context(action="update", since="<ISO timestamp>")
```

It creates a snapshot only when it changes `master_context`; it is not a routine post-session step.

---

## Next Steps

1. Run `cmos_review()` to open a normal work session (`cmos_agent_onboard()` is the cold-start path)
2. Run `cmos_mission(action="status")` to see work queue
3. Start your first mission with `cmos_mission_transition(action="start")`
4. See the active `cmos/tiers/{tier}.md` guide for tier-specific behavior

---

**Last Updated**: 2026-08-28
**Schema Version**: 2.1
