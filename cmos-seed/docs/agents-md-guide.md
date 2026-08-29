# Agent Configuration Guide

**Purpose**: Understand how to configure AI agent instructions for CMOS-managed projects.

---

## Architecture Overview

CMOS projects use **two complementary layers** of AI configuration:

### 1. Project Root agents.md (REPOSITORY-WIDE CONTRACT)

**Location**: `project-root/agents.md`

**Purpose**: Hard operating rules, code/build/test conventions, and project-specific workflow for
every task in the repository.

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
# AI Agent Configuration

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

| Tier        | File                    | Description                                        |
| ----------- | ----------------------- | -------------------------------------------------- |
| **Build**   | `cmos/tiers/build.md`   | Full mission/sprint workflow for structured builds |
| **Managed** | `cmos/tiers/managed.md` | Mission tracking without sprint overhead           |
| **General** | `cmos/tiers/general.md` | Sessions, context, notes, decisions; no missions   |

**Tier selection**: Set via `cmos_project(action="update", projectType="general|managed|build")`.

**Loaded automatically**: `cmos_review()` is the normal bounded opener and uses tier-shaped
onboarding internally. Use `cmos_agent_onboard()` for a cold start or the full long-form payload.
The active tier filters suggested actions and shapes onboarding fields.

---

## Critical Boundaries

**Repository and implementation boundary**:

```
Agent reads: project-root/agents.md for every task
Implementation missions may write: src/, tests/, app/, and project docs
Agent never puts application code in: cmos/
```

**CMOS state boundary**:

```
Agent opens normal work with: cmos_review()
Agent reads tier detail from: cmos/tiers/{tier}.md
Agent changes database-backed CMOS state: through MCP tools only
Agent does not edit cmos/db/cmos.sqlite or generated exports directly
```

**NEVER**:

- Write application code in `cmos/`
- Write application tests in `cmos/tests/` (those are CMOS tests)
- Put mission management in project root

---

## Writing Effective agents.md (Project Root)

### Structure

Use this template structure:

```markdown
# AI Agent Configuration

## Project Overview

- Project name, type, tech stack
- Brief description

## Build & Development Commands

- Installation
- Development server
- Build process
- Testing

## Project Structure & Navigation

- Directory layout
- Key files and their purposes

## Coding Standards & Style

- Language-specific guidelines
- Naming conventions
- Code organization patterns

## Testing Preferences

- Framework to use
- Coverage requirements
- Test structure

## Security & Quality Guardrails

- Security rules
- Code review requirements
- Quality gates

## Architecture Patterns

- Preferred design patterns
- Integration approaches

## Project-Specific Configuration

- Environment variables
- External services
- Special requirements
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

### Choosing a Tier

- **Build** (default): Full CMOS workflow with sprints, missions, sessions, and decisions. Best for structured engineering projects.
- **Managed**: Mission tracking without sprint overhead. Good for ongoing work without sprint cadence.
- **General**: Sessions, context, note-taking, decisions, and messaging without mission tracking.
  Best for exploration, research, or lightweight projects.

---

## Directory Structure

```
project/
├── agents.md              # Repository-wide operating and application rules
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

1. **Project root agents.md** — Repository-wide hard rules and project conventions
2. **Tier guides in cmos/tiers/** — Additional CMOS behavior for the active tier
3. **Clear boundaries** — Never mix application and management concerns
4. **Be specific** — Give real commands and examples in agents.md
5. **Keep updated** — Evolve agents.md with your project

---

**Last Updated**: 2026-08-28
**See Also**: `cmos/docs/getting-started.md` for full setup flow
