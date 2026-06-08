# CMOS Seed

**Minimal seed for CMOS (Context + Mission Orchestration System) projects.**

CMOS is a project management layer for AI-assisted development. This seed provides the minimal structure for MCP-based project initialization.

---

## What's Included

```
cmos-seed/
├── db/
│   └── schema.sql      # Full CMOS SQLite schema
├── tiers/
│   ├── build.md        # Build tier behavioral guide
│   ├── general.md      # General tier behavioral guide
│   └── managed.md      # Managed tier behavioral guide
└── docs/
    ├── README.md                  # Documentation index
    ├── getting-started.md         # Quick setup guide
    ├── build-session-prompt.md    # Build session template
    ├── session-management-guide.md # Session workflows
    └── sqlite-schema-reference.md # Database schema docs
```

---

## Quick Start

### Option 1: Use cmos_project_init (Recommended)

The `cmos_project_init` MCP tool creates CMOS structure directly:

```
cmos_project_init({
  projectRoot: "/path/to/your/project",
  projectName: "My Project",
  projectId: "my-project-id",  // optional, auto-generated if omitted
  createDocs: true,            // optional, creates docs/ directory
  initialSprint: {             // optional
    id: "sprint-01",
    title: "Initial Sprint"
  }
})
```

This creates:

- `cmos/db/cmos.sqlite` - Initialized database with full schema
- `cmos/tiers/build.md` - Build tier behavioral guide
- `cmos/docs/` - Documentation (if createDocs=true)

### Option 2: Manual Setup

1. Copy this seed into your project:

   ```bash
   cp -r cmos-seed/ yourproject/cmos/
   ```

2. Initialize the database:

   ```bash
   sqlite3 yourproject/cmos/db/cmos.sqlite < yourproject/cmos/db/schema.sql
   ```

3. Use MCP tools to manage the project.

---

## Using CMOS

All operations are performed via MCP tools. No Python CLI required.

### Core Workflow

```
# 1. Get project state
cmos_agent_onboard()

# 2. Check work queue
cmos_mission_status()

# 3. Start mission
cmos_mission_start(missionId="s01-m01")

# 4. Execute work
# (actually implement the mission)

# 5. Complete mission
cmos_mission_complete(missionId="s01-m01", notes="What was done")
```

### Available MCP Tools

| Category      | Tools                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup**     | `cmos_project_init`, `cmos_db_health`, `cmos_agent_onboard`                                                                                                                                                                     |
| **Missions**  | `cmos_mission_status`, `cmos_mission_list`, `cmos_mission_show`, `cmos_mission_start`, `cmos_mission_complete`, `cmos_mission_block`, `cmos_mission_unblock`, `cmos_mission_update`, `cmos_mission_add`, `cmos_mission_depends` |
| **Sprints**   | `cmos_sprint_list`, `cmos_sprint_show`, `cmos_sprint_add`, `cmos_sprint_update`                                                                                                                                                 |
| **Sessions**  | `cmos_session_start`, `cmos_session_capture`, `cmos_session_complete`, `cmos_session_list`                                                                                                                                      |
| **Context**   | `cmos_context_view`, `cmos_context_snapshot`, `cmos_context_history`                                                                                                                                                            |
| **Decisions** | `cmos_decisions_list`, `cmos_decisions_search`                                                                                                                                                                                  |

---

## Key Concepts

### Mission Lifecycle

```
Queued → Current → In Progress → Completed
                 ↘ Blocked ↗
```

### Two Contexts

- **project_context**: Current session state, working memory
- **master_context**: Project history, strategic decisions, constraints

### Sessions

Non-build work (planning, research, reviews) captured via session tools:

- Types: planning, onboarding, review, research, check-in, custom
- Lifecycle: start → capture → complete

---

## Documentation

See `docs/` for complete documentation:

- [Getting Started](docs/getting-started.md) - Quick setup guide
- [Build Session Prompt](docs/build-session-prompt.md) - Template for build sessions
- [Session Management Guide](docs/session-management-guide.md) - Planning, reviews, research
- [SQLite Schema Reference](docs/sqlite-schema-reference.md) - Database structure

---

## Key Principles

1. **MCP-first**: All operations via MCP tools, no CLI required
2. **Database is source of truth**: SQLite at `cmos/db/cmos.sqlite`
3. **Session captures**: Record decisions and learnings during work
4. **Context snapshots**: Preserve strategic milestones
5. **Clear boundaries**: CMOS manages work, not application code

---

**Schema Version**: 2.0
**Last Updated**: 2025-12-28
