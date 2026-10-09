# Agent Configuration Guide

**Purpose**: Understand how to configure AI agent instructions for CMOS-managed projects.

---

## Architecture Overview

CMOS projects use **two complementary layers** of AI configuration:

### 1. Project Root AGENTS.md (REPOSITORY-WIDE CONTRACT)

**Location**: `project-root/AGENTS.md`, which `cmos_project(action="init", projectRoot="...")` writes from the
template when the root has none (an existing lowercase `agents.md` works too)

**Purpose**: Hard operating rules, learned practices, code/build/test conventions, and
project-specific workflow for every task in the repository. It carries one CMOS line, naming the
project's level and how to turn CMOS's hooks off; how to use CMOS arrives through its tools, hooks
and tier guides, not through this file. Init also writes a `CLAUDE.md` that imports it
(`@AGENTS.md`), so Claude Code reads the same rules as every other agent.

**Contains**:

- Your project tech stack (React, FastAPI, etc.)
- Your build commands (npm start, pytest, etc.)
- Your coding standards and style guides
- Your test requirements and coverage targets
- Your deployment and CI/CD process
- Your security requirements
- Your API design patterns

**Used when**: Every task. Implementation missions commonly edit `src/`, `tests/`, `app/`, and
project documentation while CMOS records their state.

**Example**:

```markdown
# Agent Rules

## Project Overview

**Project Name**: TraceLab API
**Primary Language**: Python
**Framework**: FastAPI + PostgreSQL

## Build Commands

python -m uvicorn app.main:app --reload
pytest tests/ -v

## Coding Standards

- Follow PEP 8
- 80%+ test coverage required
- Type hints on all functions
```

### 2. Tier Behavioral Guides (CMOS OPERATIONS)

**Location**: `cmos/tiers/{tier}.md`

**Purpose**: Behavioral guidance for how agents interact with CMOS tools

**Available tiers**:

| Level (tier)            | File                    | Description                                            |
| ----------------------- | ----------------------- | ------------------------------------------------------ |
| **Ledger** (`general`)  | `cmos/tiers/general.md` | Decisions, lessons and notes; no tasks (the default)   |
| **Planner** (`managed`) | `cmos/tiers/managed.md` | Also next steps, as tasks in cycles; no sprints        |
| **Builder** (`build`)   | `cmos/tiers/build.md`   | Full mission and sprint workflow for structured builds |

**Tier selection**: Set via `cmos_project(action="update", projectType="general|managed|build")`.

**Loaded automatically**: `cmos_review()` is the normal bounded opener and uses tier-shaped
onboarding internally. Use `cmos_agent_onboard()` for a cold start or the full long-form payload.
The active tier filters suggested actions and shapes onboarding fields.

---

## Critical Boundaries

**Repository and implementation boundary**:

```
Agent reads: project-root/AGENTS.md for every task
Implementation missions may write: src/, tests/, app/, and project docs
Agent never puts application code in: cmos/
```

**CMOS state boundary**:

```
Agent opens normal work with: cmos_review()
Agent reads tier detail from: cmos/tiers/{tier}.md
Agent changes database-backed CMOS state: through MCP tools only
Agent does not edit cmos/db/cmos.sqlite directly
```

**NEVER**:

- Write application code in `cmos/`
- Write application tests in `cmos/tests/` (those are CMOS tests)
- Put mission management in project root

---

## Writing Effective AGENTS.md (Project Root)

### Structure

The template init writes keeps to about 150 lines, in this structure:

```markdown
# Agent Rules

(one CMOS line: the project's level and how to turn the hooks off)

## Hard Operating Rules

- Universal rules for every task; keep them

## Learned Practices

- About a dozen one-line practices learned from real failures; keep them

## Project Overview

- Project name, what it is, stack

## Commands

- Install, run, test, lint, build

## Structure

- Directory layout and the files to read first

## Conventions

- Code, comments, tests, commits

## Security

- Secrets, auth, forbidden patterns

## Outward Actions

- Who runs deploys, pushes to the main branch and releases

## Communication

- How the operator likes options presented
```

### Best Practices

**Be Specific**:

```markdown
Bad: "Write good tests"
Good: "Use pytest with fixtures. Minimum 80% coverage. Test file naming: test\_\*.py"
```

**Give Examples**:

```markdown
## API Design

All endpoints return JSON:
{
"data": {...},
"meta": {"timestamp": "...", "version": "..."}
}
```

**State Constraints**:

```markdown
## Security Rules

- Never commit API keys
- Use environment variables for secrets
- All database queries must use parameterized statements
```

**Define Success**:

```markdown
## Testing Requirements

- All features need integration tests
- Critical paths need E2E tests
- Run full suite before marking mission complete
```

---

## Tier Configuration

Each tier file uses YAML frontmatter to declare its behavioral surface:

```yaml
---
tier: build
label: Build
tools_use: [cmos_mission, cmos_sprint, cmos_session, ...]
tools_skip: []
vocabulary:
  task: mission
  note: decision
onboard_fields_show: [currentSprint, pendingMissions, blockedMissions]
onboard_fields_hide: []
---
```

The markdown body below the frontmatter provides the behavioral guide text included in onboarding
output. `tools_use` is human-readable documentation, not a permission list; tiers never disable
tools. `tools_skip` filters suggested actions, and the onboard field lists shape presentation.

### Choosing a Level

The init question is: should CMOS keep just the decisions and lessons for this project, also a
list of next steps, or full sprints and missions? `cmos-mcp init --level ledger|planner|builder`
and `cmos_project(action="init", projectRoot="...", projectType="general")` take the answer.
The answer sets the level, stored as the tier:

- **Ledger** (`general`, the default for a new project, unless its folder's AGENTS.md already
  names a level, which init keeps): decisions, lessons and notes, without task tracking. Best
  for exploration, research, or lightweight projects.
- **Planner** (`managed`): also next steps, as tasks in cycles, without sprint ceremony.
- **Builder** (`build`): the full workflow with sprints, missions, sessions, and decisions. Best
  for structured engineering projects.

Step up later with `cmos_project(action="update", projectType="managed")` (or `"build"`).

---

## Directory Structure

```
project/
├── AGENTS.md              # Repository-wide operating and application rules
├── CLAUDE.md              # Imports AGENTS.md for Claude Code
└── cmos/
    ├── db/
    │   └── cmos.sqlite    # All CMOS state
    ├── tiers/             # Tier behavioral guides
    │   ├── build.md
    │   ├── general.md
    │   └── managed.md
    └── docs/              # CMOS documentation
```

---

## Quick Start Summary

1. **Project root AGENTS.md** — Repository-wide hard rules and project conventions
2. **Tier guides in cmos/tiers/** — Additional CMOS behavior for the active tier
3. **Clear boundaries** — Never mix application and management concerns
4. **Be specific** — Give real commands and examples in AGENTS.md
5. **Keep updated** — Evolve AGENTS.md with your project

---

**Last Updated**: 2026-10-08
**See Also**: `cmos/docs/getting-started.md` for full setup flow
