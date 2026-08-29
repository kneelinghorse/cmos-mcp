# CMOS Seed

**Minimal seed for CMOS (Context + Mission Orchestration System) projects.**

CMOS is a project management layer for AI-assisted development. This seed provides the minimal structure for MCP-based project initialization.

---

## What's Included

```
cmos-seed/
├── context/             # Seed context snapshots (database wins after initialization)
├── db/
│   └── schema.sql      # Full CMOS SQLite schema
├── foundational-docs/  # Planning documents registered in project identity
├── templates/           # Project README and agents.md templates
├── tiers/
│   ├── build.md        # Build tier behavioral guide
│   ├── general.md      # General tier behavioral guide
│   └── managed.md      # Managed tier behavioral guide
└── docs/
    ├── README.md                  # Documentation index
    ├── agents-md-guide.md         # Project rules and tier guidance
    ├── getting-started.md         # Quick setup guide
    ├── build-session-prompt.md    # Build session template
    ├── session-management-guide.md # Session workflows
    └── sqlite-schema-reference.md # Database schema docs
```

---

## Quick Start

### Option 1: Use cmos_project(action="init") (Recommended)

The `cmos_project(action="init")` MCP tool creates CMOS structure directly:

```
cmos_project({
  action: "init",
  projectRoot: "/path/to/your/project",
  projectName: "My Project",
  projectId: "my-project-id",  // optional, auto-generated if omitted
  initialSprint: {             // optional
    id: "sprint-01",
    title: "Initial Sprint"
  }
})
```

This creates:

- `cmos/db/cmos.sqlite` - Initialized database with full schema
- `cmos/tiers/` - All tier behavioral guides
- `cmos/context/`, `cmos/foundational-docs/`, and `cmos/templates/`
- `cmos/docs/` - Documentation (always copied)

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

Day-to-day database-backed operations are performed via MCP tools. No Python CLI is required.

### Core Workflow

```
# 1. Open a normal work session
cmos_review()

# 2. Check work queue
cmos_mission(action="status")

# 3. Start mission
cmos_mission_transition(action="start", missionId="s01-m01")

# 4. Execute work
# (actually implement the mission)

# 5. Complete mission
cmos_mission_transition(action="complete", missionId="s01-m01", notes="What was done")
```

### Available MCP Tools

| Tool                      | Actions                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `cmos_review`             | _(no action — the session-opener digest)_                                            |
| `cmos_agent_onboard`      | _(no action — cold-start project state)_                                             |
| `cmos_project`            | init, register, list, unregister, validate, prune, update, sweep                     |
| `cmos_status`             | _(no action — identity and dashboard diagnostics)_                                   |
| `cmos_db`                 | health, snapshot, restore, backfill, reconcile, purge, pull, clone, identify_orphans |
| `cmos_mission`            | list, show, status, add, update, move, depends, undepends                            |
| `cmos_mission_transition` | start, complete, block, unblock, drop, defer                                         |
| `cmos_sprint`             | list, show, add, update, complete, retro, carry_forward, analytics                   |
| `cmos_session`            | list, start, capture, complete, search                                               |
| `cmos_context`            | view, update, condense, snapshot, history, next_steps, constraints, search           |
| `cmos_decisions`          | list, search, update, review, batch_update                                           |
| `cmos_learnings`          | list, search, update, reaffirm                                                       |
| `cmos_feedback`           | list, triage, resolve, archive                                                       |
| `cmos_auth`               | login_init, login_complete, login, logout, rotate, revoke, list, reissue             |
| `cmos_message`            | send, list, get, respond, ack, directory, whoami                                     |

---

## Key Concepts

### Mission Lifecycle

```
Queued → Current → In Progress → Completed
                 ↘ Blocked ↗
```

### Context Layers

- **project_identity**: Stable project identity and registered foundational documents
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

1. **MCP-first**: Database-backed operations use MCP tools; foundational docs remain registered files
2. **Database is source of truth**: SQLite at `cmos/db/cmos.sqlite`
3. **Session captures**: Record decisions and learnings during work
4. **Context snapshots**: Preserve strategic milestones
5. **Clear boundaries**: CMOS manages work, not application code

---

**Schema Version**: 2.1
**Last Updated**: 2026-08-28
