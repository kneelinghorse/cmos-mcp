# Agent Configuration Guide

**Purpose**: Understand how to configure AI agent instructions for CMOS-managed projects.

---

## Architecture Overview

CMOS projects use **two layers** of AI configuration:

### 1. Project Root agents.md (YOUR APPLICATION)

**Location**: `project-root/agents.md`

**Purpose**: Instructions for building YOUR APPLICATION CODE

**Contains**:

- Your project tech stack (React, FastAPI, etc.)
- Your build commands (npm start, pytest, etc.)
- Your coding standards and style guides
- Your test requirements and coverage targets
- Your deployment and CI/CD process
- Your security requirements
- Your API design patterns

**Used when**: Agent is writing code in `src/`, `tests/`, `app/`, etc.

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
| **General** | `cmos/tiers/general.md` | Lightweight — notes and decisions only             |

**Tier selection**: Set via `cmos_project(action="update", projectType="general|managed|build")`.

**Loaded automatically**: `cmos_agent_onboard()` reads the active tier config and adjusts the onboard payload accordingly — hiding irrelevant fields and filtering suggested actions.

---

## Critical Boundaries

**When working on YOUR APPLICATION**:

```
Agent reads: project-root/agents.md
Agent writes to: src/, tests/, docs/ (YOUR CODE)
Agent ignores: cmos/ (management layer)
```

**When working on MISSIONS/PLANNING**:

```
Agent reads: cmos/tiers/{tier}.md (loaded automatically via onboard)
Agent writes to: cmos/db/ (via MCP tools only)
Agent ignores: src/ (application code)
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

The markdown body below the frontmatter provides the behavioral guide text that gets included in onboard output.

### Choosing a Tier

- **Build** (default): Full CMOS workflow with sprints, missions, sessions, and decisions. Best for structured engineering projects.
- **Managed**: Mission tracking without sprint overhead. Good for ongoing work without sprint cadence.
- **General**: Lightweight note-taking and decision capture. Best for exploration, research, or projects that don't need mission tracking.

---

## Directory Structure

```
project/
├── agents.md              # YOUR APPLICATION instructions
└── cmos/
    ├── db/
    │   └── cmos.sqlite    # All CMOS state
    ├── tiers/             # Tier behavioral guides
    │   ├── build.md
    │   ├── general.md
    │   └── managed.md
    └── docs/              # Optional documentation
```

---

## Quick Start Summary

1. **Project root agents.md** — Instructions for YOUR CODE
2. **Tier guides in cmos/tiers/** — CMOS behavioral configuration (loaded automatically)
3. **Clear boundaries** — Never mix application and management concerns
4. **Be specific** — Give real commands and examples in agents.md
5. **Keep updated** — Evolve agents.md with your project

---

**Last Updated**: 2026-03-13
**See Also**: `cmos/docs/getting-started.md` for full setup flow
