# AI Agent Configuration

**Instructions**: Copy this file to your project root and customize for YOUR project.

**Location**: This file should live at `project-root/agents.md` (NOT in cmos/)

**Purpose**: Guide AI agents when building YOUR APPLICATION CODE.

---

## Hard Operating Rules

**Foundational — preserve this block when customizing the rest of this file.**

**These rules are not optional.**

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work.

### Rule 0 — CMOS is the only durable state

All planning state, sprint/mission cadence, decisions, learnings, and project trajectories live in CMOS — the strategic_decisions table, learnings table, sessions, and the `cmos/foundational-docs/` files registered in `projectIdentity.foundational_docs`.

Never write to `~/.claude/projects/.../memory/` or any hidden `.claude` directory. Those files are agent-local and invisible to other agents working on this project — storing plans, cadence, or process there hides them from the audit trail and from fresh-context agents.

If you think a `.claude` file is required: stop. Explain to the operator (a) what specific information needs to persist, (b) why CMOS cannot hold it, and (c) why a hidden `.claude` file is the only fit. Get explicit operator approval before writing.

### Rule 1 — Think Before Coding

State assumptions explicitly. Ask rather than guess.
Push back when a simpler approach exists. Stop when confused.

### Rule 2 — Simplicity First

Minimum code that solves the problem. Nothing speculative.
No abstractions for single-use code.

### Rule 3 — Surgical Changes

Touch only what you must. Don't improve adjacent code.
Match existing style. Don't refactor what isn't broken.

### Rule 4 — Goal-Driven Execution

Define success criteria. Loop until verified.
Strong success criteria let Claude loop independently.

### Rule 5 — Capture decisions and learnings

Non-trivial choices belong in CMOS. Decisions to `cmos_decisions`, cross-cutting patterns to `cmos_learnings`.
If future-you needs to know why, capture it now.

### Rule 6 — Commit at coherent boundaries

Commit at mission close, sprint close, or day boundary. Per-mission commits only when a sprint surfaces a real bisection need.

### Rule 7 — Surface conflicts, don't average them

If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.

### Rule 8 — Read before you write

Before adding code, read exports, immediate callers, shared utilities.
If unsure why existing code is structured a certain way, ask.

### Rule 9 — Tests verify intent, not just behavior

Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

### Rule 10 — Checkpoint after every significant step

Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.

### Rule 11 — Match the codebase's conventions, even if you disagree

Conformance > taste inside the codebase.
If you think a convention is harmful, surface it. Don't fork silently.

### Rule 12 — Fail loud

"Completed" is wrong if anything was skipped silently. "Tests pass" is wrong if any were skipped.
Flag uncertainty before stating a fact, statistic, date, or technical detail — never fill gaps with plausible-sounding information.

### Rule 13 — No filler openings

Start with the answer. No "Great question!", "Of course!", "Certainly!", or warmup acknowledgments.

### Rule 14 — Match response length to task

Simple questions get short answers. Complex tasks get full responses.
Don't pad with restatements or closing sentences that repeat what was just said.

---

## Project Overview
**Project Name**: [Your Project Name]  
**Project Type**: [Web API, Web App, CLI Tool, Library, etc.]  
**Primary Language**: [Python, TypeScript, JavaScript, Go, etc.]  
**Framework**: [FastAPI, React, Next.js, Express, etc.]

**Description**: [Brief 1-2 sentence description of what you're building]

---

## Build & Development Commands

### Installation & Setup
```bash
# Install dependencies
[your install command]

# Setup database/environment
[your setup commands]

# First-time setup
[any initialization needed]
```

### Development
```bash
# Start development server
[your dev command]

# Watch mode (if applicable)
[your watch command]
```

### Building
```bash
# Build for production
[your build command]

# Build for staging (if applicable)
[your staging build]
```

### Testing
```bash
# Run all tests
[your test command]

# Run unit tests
[your unit test command]

# Run integration tests
[your integration test command]

# Generate coverage
[your coverage command]
```

### Linting & Formatting
```bash
# Lint code
[your lint command]

# Format code
[your format command]

# Type checking (if applicable)
[your type check command]
```

---

## Project Structure & Navigation

### Directory Layout
```
project-root/
├── [your source directory]/      # Application code
├── tests/                         # Application tests
├── docs/                          # Project documentation
├── [config directory]/            # Configuration files
├── [scripts directory]/           # Build and utility scripts
└── cmos/                          # Project management (DO NOT write code here!)
```

### Key Files
- `[main entry point]` - [description]
- `[config file]` - [description]
- `[important files]` - [description]

**Critical**: Never write application code in `cmos/` directory. That's for project management only.

---

## Coding Standards & Style

### [Language] Guidelines
- [Specific coding standards for your primary language]
- [Naming conventions]
- [Code organization patterns]
- [Formatting rules]

**Examples**:
```[language]
// Show an example of your preferred style
```

### File Organization
- [How files should be organized]
- [Naming conventions for files]
- [Module/package structure]

### Comments & Documentation
- [When to write comments]
- [Documentation string requirements]
- [Inline documentation style]

---

## Testing Preferences

### Framework & Tools
- **Framework**: [pytest, Jest, Mocha, etc.]
- **Coverage target**: [80%, 90%, etc.]
- **Coverage tool**: [pytest-cov, Istanbul, etc.]

### Test Structure
- **Test location**: `tests/` directory (NOT in cmos/)
- **Test naming**: [test_*.py, *.test.js, etc.]
- **Test organization**: [by feature, by module, etc.]

### Testing Requirements
- [ ] [Specific requirement 1]
- [ ] [Specific requirement 2]
- [ ] All features must have tests
- [ ] Critical paths need integration tests
- [ ] Run full suite before marking missions complete

**Example test**:
```[language]
// Show an example test in your preferred style
```

---

## Security & Quality Guardrails

### Security Rules
- Never commit API keys or secrets
- Use environment variables for sensitive data
- [Your specific security requirements]
- [Authentication/authorization patterns]
- [Data protection requirements]

### Code Quality Gates
- [Linting must pass]
- [Type checking must pass (if applicable)]
- [Coverage must meet threshold]
- [Code review requirements]

### Forbidden Patterns
- ❌ [Pattern 1 you want to avoid]
- ❌ [Pattern 2 you want to avoid]
- ❌ Hardcoded credentials
- ❌ Raw SQL queries (use ORM/query builder)

---

## Architecture Patterns

### Preferred Design Patterns
- **[Pattern 1]**: [When and how to use it]
- **[Pattern 2]**: [When and how to use it]

**Examples**:
```[language]
// Show example implementation of preferred pattern
```

### Database Access
- **ORM/Tool**: [SQLAlchemy, Prisma, TypeORM, etc.]
- **Migration tool**: [Alembic, Knex, Prisma, etc.]
- **Connection pattern**: [Connection pooling, etc.]

### API Design (if applicable)
- **Style**: [REST, GraphQL, gRPC, etc.]
- **Response format**: [JSON structure, error format, etc.]
- **Authentication**: [JWT, OAuth, API keys, etc.]

---

## Project-Specific Configuration

### Environment Variables
```bash
# Development
[YOUR_ENV_VAR]=value
[ANOTHER_VAR]=value

# Production
[PROD_VARS]=value
```

### External Services
- **[Service 1]**: [Purpose and configuration]
- **[Service 2]**: [Purpose and configuration]

### Deployment
- **Platform**: [Vercel, Railway, AWS, etc.]
- **Process**: [Deployment steps or CI/CD info]
- **Environment**: [Staging, production setup]

---

## CMOS Integration Notes

### When Working on Application Code
1. Read THIS agents.md (project-root/agents.md)
2. Write code to `src/`, `app/`, or your source directory
3. Write tests to `tests/` directory
4. Never write application code to `cmos/`

### When Working on CMOS Operations
1. Read `cmos/tiers/build.md` for CMOS-specific instructions
2. Use mission runtime scripts
3. Update missions and contexts in `cmos/`
4. Keep application code and CMOS management separate

### Before Completing Missions
- [ ] All application tests pass
- [ ] Code meets standards defined above
- [ ] Documentation updated if needed
- [ ] Mission status verified in database

---

## Development Workflow

### Branch Strategy (if using Git)
- **Main**: [Your main branch strategy]
- **Development**: [Your dev branch strategy]
- **Features**: [Your feature branch naming]

### Commit Messages
```
[type]([scope]): [description]

Examples:
feat(api): add user authentication endpoint
fix(db): resolve connection pool timeout
docs(readme): update installation instructions
test(auth): add integration tests for OAuth
```

---

## Notes for AI Agents

### Context Loading Priority
1. Load `project-root/agents.md` (THIS FILE) for application work
2. Load `cmos/tiers/build.md` for CMOS operations
3. Call `cmos_context(action="view")` for current state and project history

The `cmos/context/*.json` files are seed snapshots written once at init. The database is the
source of truth from the first write onward — read state through the tools, not those files.

### Output Standards
- Use [Markdown, reStructuredText, etc.] for documentation
- Use [your preferred format] for reports
- Include code examples with syntax highlighting
- Keep explanations [concise/detailed/etc.]

### Communication Style
- [Your preference: concise, detailed, technical, etc.]
- [How to present options]
- [When to ask clarifying questions]

---

## Customization Checklist

Before using this template, update:

- [ ] All `[bracketed placeholders]` with your actual values
- [ ] Project overview with real project details
- [ ] Build commands with your actual commands
- [ ] Project structure with your actual directories
- [ ] Coding standards with your actual rules
- [ ] Testing requirements with your actual framework
- [ ] Security rules with your specific requirements
- [ ] Remove this checklist section when done

---

**Template Version**: 2.0  
**Last Updated**: 2025-11-08  
**Copy to**: `project-root/agents.md` (NOT cmos/)  
**Customize**: Replace all [placeholders] with your project details
