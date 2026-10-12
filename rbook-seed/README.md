# Reasonbook seed

**Minimal seed for Reasonbook (Context + Mission Orchestration System) projects.**

Reasonbook is a project management layer for AI-assisted development. This seed provides the minimal structure for MCP-based project initialization.

---

## What's Included

```
rbook-seed/
├── context/             # Seed context snapshots (database wins after initialization)
├── db/
│   └── schema.sql      # Full Reasonbook SQLite schema
├── foundational-docs/  # Planning documents registered in project identity
├── templates/           # Project README and AGENTS.md templates
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

### Option 1: The init tool (Recommended)

The `rbook_project(action="init", projectRoot="...", projectType="build")` MCP tool creates Reasonbook structure directly, at the Builder level this README uses:

```
rbook_project({
  action: "init",
  projectRoot: "/path/to/your/project",
  projectName: "My Project",   // the id is generated once and kept for life
  projectType: "build",        // Builder: sprints and missions; without it, a Ledger unless AGENTS.md names a level
  initialSprint: {             // optional
    id: "sprint-01",
    title: "Initial Sprint"
  },
  initialMissions: [           // optional
    { id: "s01-m01", name: "First mission", sprintId: "sprint-01" }
  ]
})
```

This creates:

- `rbook/db/rbook.sqlite` - Initialized database with full schema
- `rbook/tiers/` - All tier behavioral guides
- `rbook/context/`, `rbook/foundational-docs/`, and `rbook/templates/`
- `rbook/docs/` - Documentation (the Builder level's; a Ledger or Planner project gets its own short `rbook/README.md` instead)

### Option 2: Manual Setup

1. Copy this seed into your project:

   ```bash
   cp -r rbook-seed/ yourproject/rbook/
   ```

2. Initialize the database:

   ```bash
   sqlite3 yourproject/rbook/db/rbook.sqlite < yourproject/rbook/db/schema.sql
   ```

3. Use MCP tools to manage the project.

---

## Using Reasonbook

Day-to-day database-backed operations are performed via MCP tools. No Python CLI is required.

### Core Workflow

```
# 1. Open a normal work session
rbook_review()

# 2. Check work queue
rbook_mission(action="status")

# 3. Start mission
rbook_mission_transition(action="start", missionId="s01-m01")

# 4. Execute work
# (actually implement the mission)

# 5. Complete mission
rbook_mission_transition(action="complete", missionId="s01-m01", notes="What was done")
```

### Available MCP Tools

| Tool                       | Actions                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `rbook_review`             | _(no action — the session-opener digest)_                                                             |
| `rbook_agent_onboard`      | _(no action — cold-start project state)_                                                              |
| `rbook_project`            | init, register, list, unregister, validate, prune, update, sweep                                      |
| `rbook_status`             | _(no action — identity and dashboard diagnostics)_                                                    |
| `rbook_db`                 | health, snapshot, restore, backfill, reconcile, purge, pull, clone, identify_orphans, prune_snapshots |
| `rbook_mission`            | list, show, status, add, update, move, depends, undepends                                             |
| `rbook_mission_transition` | start, complete, block, unblock, drop, defer                                                          |
| `rbook_sprint`             | list, show, add, update, complete, retro, carry_forward, analytics                                    |
| `rbook_session`            | list, start, capture, complete, search                                                                |
| `rbook_context`            | view, update, condense, snapshot, history, next_steps, constraints, search                            |
| `rbook_decisions`          | list, search, show, update, review, batch_update, record                                              |
| `rbook_learnings`          | list, search, show, update, reaffirm                                                                  |
| `rbook_feedback`           | list, triage, resolve, archive                                                                        |
| `rbook_auth`               | login_init, login_complete, login, logout, rotate, revoke, list, reissue                              |
| `rbook_message`            | send, list, get, respond, ack, directory, whoami                                                      |

---

## Key Concepts

### Mission Lifecycle

```
Queued → Current → In Progress → Completed
                 ↘ Blocked ↗
```

### Context Layers

- **project_identity**: Stable project identity and registered foundational documents
- **project_context**: Current session state and next steps
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
2. **Database is source of truth**: SQLite at `rbook/db/rbook.sqlite`
3. **Session captures**: Record decisions and learnings during work
4. **Context snapshots**: Preserve strategic milestones
5. **Clear boundaries**: Reasonbook manages work, not application code

---

**Schema Version**: 2.1
**Last Updated**: 2026-10-12
