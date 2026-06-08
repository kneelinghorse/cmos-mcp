# CMOS System and CMOS-MCP Whitepaper

## 1. Executive Summary

CMOS (Context + Mission Orchestration System) is a project management system optimized for AI-assisted delivery. It models work as missions, organizes them into sprints, and maintains project memory through contexts and strategic decisions. CMOS-MCP is the Model Context Protocol server that exposes this system to AI agents with typed, safe, SQLite-backed tools. Mission Protocol provides mission authoring and domain packs; TraceLab provides research knowledge storage and synthesis. Together, these systems create an end-to-end pipeline from research to decisions to build execution, with traceability and guardrails.

Key outcomes

- CMOS uses SQLite as the source of truth for missions, sprints, sessions, contexts, and decisions.
- CMOS-MCP provides a direct, tool-based interface to CMOS for agents, with consistent structured responses.
- Mission Protocol handles mission authoring and quality scoring; CMOS handles execution tracking.
- TraceLab integration adds research provenance to CMOS decisions and missions.
- Orchestration patterns (rsip, delegation, boomerang) are standardized in mission templates and runtime assets.

## 2. System Landscape

### Roles and Responsibilities

- CMOS: project management system of record for build work.
- CMOS-MCP: MCP server that exposes CMOS database operations to agents.
- Mission Protocol: mission authoring, domain packs, quality scoring, and mission splitting.
- TraceLab: research repository and synthesis engine.

### High-Level Flow

```
TraceLab (research) -> Reports -> CMOS (decisions + missions) -> Build output
          |                                   |
          |                                   +-> Context snapshots and session history
          +-> Reference docs and evidence links

CMOS-MCP sits on top of CMOS and exposes all database operations as MCP tools.
```

## 3. Evolution: Flat Files to SQLite to MCP-First

### Legacy Flat File Model

Earlier CMOS deployments stored work in flat files:

- missions/backlog.yaml
- PROJECT_CONTEXT.json and context/MASTER_CONTEXT.json
- SESSIONS.jsonl

This enabled simple workflows but made queries, analytics, and cross-references difficult.

### SQLite-First Model

The current CMOS architecture uses `cmos/db/cmos.sqlite` as the source of truth. Files are treated as export views generated on demand. Migration scripts convert legacy files into the SQLite schema and preserve full history.

Key migration tooling

- `python cmos/scripts/seed_sqlite.py`
- `python cmos/scripts/migrate_cmos_memory.py`
- `./cmos/cli.py db export backlog`

### MCP-First Operation

CMOS-MCP exposes CMOS to agents via MCP tools, eliminating shell or direct SQL use for most workflows. CLI remains available for human operators and legacy workflows, but MCP is the preferred interface for agents.

## 4. CMOS System Deep Dive

### 4.1 Core Components

- `cmos/cli.py`: operational CLI for missions, contexts, sessions, and decisions.
- `cmos/db/cmos.sqlite`: authoritative store for all mission and context data.
- `cmos/context/`: Python helpers for mission runtime and context management.
- `cmos/missions/`: backlog and templates (file views and inputs).
- `cmos/workers/`: delegation manifest and worker definitions.
- `cmos/runtime/`: orchestration state (boomerang checkpoints, runtime artifacts).
- `cmos/telemetry/`: event logs and metrics.

Boundary note

- CMOS manages project management data only (missions, sprints, contexts, sessions).
- Application code lives outside `cmos/` and is not modified by CMOS workflows.

### 4.2 Data Model (Summary)

Core tables include sprints, missions, mission_dependencies, sessions, session_events, contexts, context_snapshots, strategic_decisions, and metadata. Views such as `mission_details` and `sprint_summary` provide analytics-friendly access.

See `docs/whitepaper/Appendix-Schema.md` for full table summaries.

### 4.3 Mission Lifecycle

Mission status flow:

- Queued -> Current -> In Progress -> Completed (or Blocked)

Selection priority:

1. First mission with status In Progress
2. Otherwise first mission with status Current
3. Otherwise first mission with status Queued

Lifecycle operations are recorded in SQLite and mirrored to session events. Mission dependencies are stored in `mission_dependencies` and can be queried to enforce ordering.

### 4.4 Context Management

Two contexts are maintained in the database:

- Project context: current state and working memory.
- Master context: long-term project history, decisions, constraints, and learnings.

Snapshots provide a historical timeline of master context changes. Strategic decisions are indexed for queryability in `strategic_decisions` while full context remains in JSON content.

### 4.5 Orchestration Patterns

CMOS defines a single orchestration mode per mission, configured in mission templates:

- none: linear execution
- rsip: refinement loops
- delegation: worker distribution
- boomerang: checkpointed execution with fallbacks

Pattern state and checkpoints are stored under `cmos/runtime/`. Worker configuration is stored in `cmos/workers/manifest.yaml`.

### 4.6 Build Missions (Operational Loop)

Agents are expected to run a strict loop when executing build missions:

1. Onboard: `cmos_agent_onboard()`
2. Queue: `cmos_mission_status()`
3. Start: `cmos_mission_start(missionId)`
4. Execute: implement and test
5. Complete: `cmos_mission_complete(missionId, notes)`
6. Verify: `cmos_mission_status()`

If blocked, record a blocker and required dependencies with `cmos_mission_block`.

### 4.7 Sprint Planning and Review

Planning sessions capture intent and set the next sprint:

- Review foundational docs and roadmaps (often sourced from `cmos/foundational-docs` templates).
- Start session: `cmos_session_start(type="planning", title="...")`
- Capture decisions, constraints, and next steps
- Create sprints and missions via MCP tools

Review sessions capture outcomes and update project memory:

- `cmos_session_start(type="review", title="Sprint X Review")`
- `cmos_decisions_list(sprintId="sprint-X")`
- `cmos_session_complete(summary, nextSteps)`
- `cmos_context_snapshot(contextType="master_context", source="Sprint X completed")`

### 4.8 Guardrails and Validation

CMOS uses explicit guardrails:

- SQLite as the source of truth
- Append-only session events and snapshots
- Structured error responses for agents
- Test suites covering security, quality, and integration

Key commands

- `./cmos/cli.py db show current`
- `./cmos/cli.py validate docs`
- `node cmos/context/integration_test_runner.js`

## 5. CMOS-MCP Deep Dive

### 5.1 MCP Server Architecture

The MCP server is implemented in TypeScript and registers tools via the MCP SDK. Tool definitions live in `src/tools/cmos` and are wired in `src/index.ts`. The server uses MCP stdio transport for local agent integrations.

Tool modes

- Default: Mission Protocol tools + CMOS tools
- `MISSION_PROTOCOL_SLIM_MODE=1`: core Mission Protocol tools only

### 5.2 CmosDatabaseClient

`CmosDatabaseClient` wraps `better-sqlite3` and provides:

- Auto-detection of `cmos/db/cmos.sqlite` via CmosDetector
- WAL mode and foreign key enforcement
- Statement caching for performance
- Structured error translation into `CmosToolResult`

Project root resolution

1. Explicit `projectRoot` parameter
2. `CMOS_PROJECT_ROOT` environment variable
3. `process.cwd()`

### 5.3 Tool Response Pattern

All CMOS tools return a structured response:

```
interface CmosToolResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    suggestion?: string;
    valid_values?: any[];
    current_state?: any;
  };
  warnings?: string[];
}
```

This keeps agent behavior deterministic and self-correcting.

### 5.4 Project ID Self-Protection

Database self-protection prevents cross-project contamination:

- If the database has `metadata.project_id`, mutation tools require `CMOS_PROJECT_ID` to match.
- Read-only tools remain available without the env var.
- `withClientValidated` enforces this for mutation tools.

### 5.5 Tool Catalog (Summary)

CMOS-MCP exposes tools grouped by category:

- Database reads: mission list, show, status, session list
- Lifecycle mutations: start, complete, block, unblock, update
- Context operations: view, snapshot, history
- Session management: start, capture, complete
- Sprint management: list, show, add, update
- Mission creation: add, depends
- Agent utilities: onboard, decisions list/search
- Admin: db health

See `docs/whitepaper/Appendix-Tools.md` for the full catalog and tool status.

### 5.6 LLM Formatting

Each tool provides an LLM-friendly formatter that transforms structured results into concise, readable output. This is separate from the underlying data return so both machine and human outputs remain clean.

## 6. How CMOS and CMOS-MCP Work Together

### Shared Source of Truth

Both the CLI and MCP tools operate on the same SQLite database. This enables a mixed workflow:

- Agents use MCP tools for automation
- Humans use the CLI for ad hoc inspection
- File exports remain optional views of database state

### When to Use MCP vs CLI

- MCP: agent-native workflows, structured responses, tool chaining
- CLI: human operations, maintenance, or when Python scripts are required

### Data Flow Example

1. Mission Protocol generates a mission template with `create_mission`
2. Agent converts it into a CMOS mission via `cmos_mission_add`
3. Execution follows the mission lifecycle via MCP
4. Review decisions are captured and indexed in `strategic_decisions`

## 7. Mission Protocol Foundation

Mission Protocol provides the authoring layer:

- Domain packs define mission schemas and prompts
- `create_mission` generates structured mission YAML or JSON
- `get_mission_quality_score` evaluates clarity and completeness
- `create_mission_splits` decomposes large missions

CMOS consumes the resulting mission definitions for execution tracking.

## 8. TraceLab Integration

TraceLab is the research knowledge system that feeds evidence into CMOS decisions and missions.

Integration patterns

- Link the TraceLab project to CMOS via `metadata.tracelab_project_id`.
- Use TraceLab URIs in `reference_docs` to preserve provenance.
- Store evidence links for decisions via `source_chunk_ids` (planned schema extension).

Example reference URIs

```
tracelab://project/{project_id}
tracelab://report/{report_id}
tracelab://collection/{collection_id}
tracelab://chunk/{chunk_id}
```

A proposed MCP tool, `cmos_resolve_references`, can resolve these into TraceLab content for agents. This keeps research and build phases connected without copying documents into CMOS.

## 9. End-to-End Workflows

### Build Mission Execution (MCP)

1. `cmos_agent_onboard()`
2. `cmos_db_health()`
3. `cmos_mission_status()`
4. `cmos_mission_start(missionId)`
5. Implement and test
6. `cmos_mission_complete(missionId, notes)`
7. `cmos_mission_status()`

### Sprint Planning

1. `cmos_context_view()`
2. `cmos_session_start(type="planning", title="Sprint X Planning")`
3. Capture decisions and constraints
4. `cmos_sprint_add(...)`
5. `cmos_mission_add(...)` and `cmos_mission_depends(...)`
6. `cmos_session_complete(summary, nextSteps)`

### Sprint Review

1. `cmos_sprint_show(sprintId)`
2. `cmos_decisions_list(sprintId)`
3. `cmos_session_start(type="review", title="Sprint X Review")`
4. Capture learnings and decisions
5. `cmos_session_complete(summary, nextSteps)`
6. `cmos_context_snapshot(contextType="master_context", source="Sprint X completed")`

### Research to Build Traceability

1. TraceLab research mission produces a report
2. CMOS mission references the report in `reference_docs`
3. Decisions capture `source_chunk_ids` for evidence
4. Mission deliverables link back to decisions

## 10. Security, Quality, and Governance

Operational guardrails

- Use `agents.md` and `cmos/agents.md` as the authoritative playbooks
- Record decisions and constraints in master context
- Run validation checks before closing missions
- Prefer MCP tools over ad hoc SQL or file edits

Environment variables

- `CMOS_PROJECT_ROOT`: explicit project root for MCP tools
- `CMOS_PROJECT_ID`: project ID validation for mutation tools
- `CMOS_AUTO_SNAPSHOT`, `CMOS_SNAPSHOT_RETENTION_DAYS`, `CMOS_MAX_SNAPSHOTS` for snapshot control

## 11. Roadmap and Future Enhancements

Areas under consideration (implemented or proposed in discovery docs)

- `cmos_project_init`: MCP-based project seeding
- `cmos_backlog_export`: MCP export of backlog to YAML or JSON
- `cmos_session_search`: search sessions directly via MCP
- `cmos_context_update`: structured context updates with snapshots
- `cmos_resolve_references`: resolve TraceLab references inside missions
- Auto snapshot rules tied to sprint completion
- Decision extraction pipeline from session captures

## 12. Appendix Links

- Tool catalog summary: `docs/whitepaper/Appendix-Tools.md`
- Schema summary: `docs/whitepaper/Appendix-Schema.md`
