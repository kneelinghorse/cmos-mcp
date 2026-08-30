# cmos-mcp

[![npm version](https://img.shields.io/npm/v/@aquex/cmos-mcp)](https://www.npmjs.com/package/@aquex/cmos-mcp)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)

A local-first Model Context Protocol server for CMOS — Context, Missions, Operations, Sessions. Gives AI agents typed, SQLite-backed project operations without fragile CLI parsing.

## What it is

cmos-mcp is the protocol + client. It runs locally on your machine, owns a SQLite database under `cmos/db/cmos.sqlite`, and exposes 15 typed tools to any MCP-capable agent (Claude Code, Claude Desktop, Cursor, Zed, VS Code, Windsurf).

Out of the box you get:

- Sprint and mission state machines with auditable transitions
- Session capture for decisions, learnings, constraints, next-steps
- Strategic context that condenses across sprints, with FTS5 retrieval
- Full-text search across decisions, learnings, missions, sessions
- Snapshot-backed safety on destructive operations
- Per-project credential store and device-code auth (RFC 8628)

The dashboard at [cmos.aquex.ai](https://cmos.aquex.ai) is **optional**. You can run cmos-mcp standalone forever — sign-up unlocks sync (SQLite ↔ Postgres mirror), the project registry (`cmos://you/*` addresses), and cross-project messaging. Without it, every other tool still works locally.

## Install

```bash
npm install -g @aquex/cmos-mcp
```

Or run on demand without a global install:

```bash
npx -y @aquex/cmos-mcp
```

Requires Node.js 18+.

## Configure your MCP client

### Claude Code

```bash
claude mcp add-json cmos-mcp '{"command":"npx","args":["-y","@aquex/cmos-mcp"]}'
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on Windows/Linux:

```json
{
  "mcpServers": {
    "cmos-mcp": {
      "command": "npx",
      "args": ["-y", "@aquex/cmos-mcp"]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cmos-mcp": {
      "command": "npx",
      "args": ["-y", "@aquex/cmos-mcp"]
    }
  }
}
```

### Zed

```json
{
  "context_servers": {
    "cmos-mcp": {
      "command": "npx",
      "args": ["-y", "@aquex/cmos-mcp"]
    }
  }
}
```

### VS Code (Claude extension)

```json
{
  "mcp.servers": {
    "cmos-mcp": {
      "command": "npx",
      "args": ["-y", "@aquex/cmos-mcp"]
    }
  }
}
```

### Windsurf

```json
{
  "mcpServers": {
    "cmos-mcp": {
      "command": "npx",
      "args": ["-y", "@aquex/cmos-mcp"]
    }
  }
}
```

## First call

In your MCP client, open the project with the session digest:

```
Run cmos_review to see the project state.
```

`cmos_review` returns a ≤4 KB digest — project identity, current sprint, work queue, recent decisions, freshness, and the top next actions — in one call. (For a brand-new project's cold start, or to carry the operational tier, use `cmos_agent_onboard`; it surfaces the fresh-project pathway when there's no database yet.)

The full walkthrough — install → config → init → first sprint/mission/session loop — lives in [docs/getting-started.md](docs/getting-started.md).

## Tool surface

cmos-mcp exposes 15 consolidated tools. 12 use an `action` parameter to select the operation; `cmos_agent_onboard`, `cmos_status` and `cmos_review` take no `action`. [TOOL_REFERENCE.md](TOOL_REFERENCE.md) publishes one parameter table per action, so it says which parameters actually apply to a given call.

| Tool                      | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `cmos_review`             | ≤4 KB session-opener digest: identity, current sprint, work queue, decisions  |
| `cmos_agent_onboard`      | Cold-start payload: identity, active sprint, missions, decisions, suggestions |
| `cmos_status`             | Diagnostic snapshot: cmos_address, dashboard_url, auth_tier, sync timestamps  |
| `cmos_mission`            | Missions — create, update, query, and link dependencies                       |
| `cmos_mission_transition` | Mission state machine — start, complete, block, unblock, drop, defer          |
| `cmos_sprint`             | Sprints — CRUD, closeout, retro, and cross-sprint analytics                   |
| `cmos_session`            | Work sessions — start, capture insights, complete, list, and search           |
| `cmos_context`            | Master/project context — view, update, condense, snapshot, and search         |
| `cmos_decisions`          | Strategic decisions — list, full-text search, update, and staleness review    |
| `cmos_learnings`          | Cross-cutting learnings — list, search, update, and reaffirm                  |
| `cmos_db`                 | Database ops — health, snapshot/restore, and sync (backfill, reconcile, pull) |
| `cmos_project`            | Project registry — init, register, list, validate                             |
| `cmos_auth`               | Dashboard credential lifecycle — device-code login, rotate, revoke            |
| `cmos_message`            | Cross-project messaging (requires the hosted dashboard)                       |
| `cmos_feedback`           | Agent-feedback channel — list, triage, resolve, archive                       |

See **[TOOL_REFERENCE.md](TOOL_REFERENCE.md)** for the exact per-action parameter reference — it is generated from the tool definitions on every build, so it never drifts from the shipped surface.

## Optional: hosted dashboard

The dashboard is a separate service. Sign up at [cmos.aquex.ai](https://cmos.aquex.ai) to unlock:

- **Sync** — your local SQLite mirrors to a Postgres replica; survives machine swaps and IDE reinstalls.
- **Project registry** — addressable `cmos://you/project-name` URIs across machines.
- **Messaging** — `cmos_message(action="send")` to your own projects (free) or, on the paid tier, to other users.

To connect:

```bash
export CMOS_DASHBOARD_URL=https://cmos.aquex.ai
```

Then run `cmos_auth(action="login_init")` from your agent. It returns a one-time `userCode` and `verificationUri` — paste the code at the URL in your browser, then run `cmos_auth(action="login_complete", deviceCode=...)` to finish. Credentials persist atomically to `~/.config/cmos-mcp/credentials.json` (mode 0600).

If `CMOS_DASHBOARD_URL` is unset or unreachable, the dashboard-relay tools (`cmos_message`, sync, registry) return a structured `DASHBOARD_NOT_CONFIGURED` or `DASHBOARD_UPGRADE_REQUIRED` error pointing at the sign-up URL. Local tools never depend on the dashboard.

## Project resolution

When an MCP tool is called, cmos-mcp resolves the target project root in this order:

1. Explicit `projectRoot` parameter on the tool call (highest trust).
2. `CMOS_PROJECT_ROOT` environment variable (CI/CD).
3. Auto-discovery from the current working directory (looks for `cmos/db/cmos.sqlite`).
4. Default project from the registry at `~/.config/cmos-mcp/project-registry.json`.
5. Structured error pointing at `cmos_project(action="register")`.

This is what makes Claude Code "just work" from a workspace, while Claude Desktop (no CWD context) needs an explicit `cmos_project(action="register", setAsDefault=true)` once.

## Environment variables

```bash
# Optional — connects to the hosted dashboard. Defaults to https://cmos.aquex.ai
# when unset; treat empty string as unset.
CMOS_DASHBOARD_URL=https://cmos.aquex.ai

# Optional — explicit project root (CI/CD). Otherwise auto-discovered.
CMOS_PROJECT_ROOT=/path/to/your/project

# Optional — override the credential + registry directory. Default: ~/.config/cmos-mcp
CMOS_CONFIG_DIR=/custom/path

# Snapshot retention (default shown)
CMOS_MAX_SNAPSHOTS=50
```

## Error response shape

Every tool returns a uniform envelope:

```json
{
  "success": false,
  "error": {
    "code": "MISSION_NOT_FOUND",
    "message": "Mission 's99-m01' not found",
    "suggestion": "Use cmos_mission(action=\"list\") to see available missions"
  }
}
```

`code` is machine-readable, `message` is human-readable, `suggestion` is a concrete next step. Validation errors carry `validValues` (a `string[]`). State errors can carry `currentState`: generally a status string when the relevant mission, session, or sprint state is available, and — on `SESSION_ALREADY_ACTIVE` only — an object `{ id, type, title, startedAt, captureCount }`. Branch on `code` before reading it.

## Safety

- **Append-only audit.** Session events, context snapshots, and mission history are immutable rows.
- **Atomic credential writes.** `credentials.json` is written via temp-file + rename with 0600 permissions.
- **Manual snapshots.** `cmos_db(action="snapshot")` copies the database on demand; `CMOS_MAX_SNAPSHOTS` caps how many are kept. There is no automatic snapshot before destructive operations, and no soft-delete net — `cmos_db(action="purge")` and `cmos_db(action="restore")` are genuinely destructive. See [SECURITY.md](SECURITY.md#backups--deletion--the-honest-reality).
- **Dry-run where it exists.** `cmos_context(action="condense")` and `cmos_db(action="backfill")` accept `dryRun` to preview without committing. It is not a general property of mutating tools.

## Known limits

- Sync is checkpoint-driven, not continuous — manual `cmos_db(action="backfill")` flushes pending events to the dashboard.
- SQLite is the source of truth and the Postgres mirror is a mirror. To bring state down, `cmos_db(action="clone")` bootstraps a fresh machine from dashboard state and `cmos_db(action="pull")` merges events since your last cursor.
- Cross-user messaging on the dashboard is paid-tier; same-user (multi-device) messaging is free.

## Documentation

- [Getting started](docs/getting-started.md) — install through first onboard, no dashboard required.
- [Tool reference](TOOL_REFERENCE.md) — every tool, action, and parameter (generated from the tool definitions).
- [Changelog](CHANGELOG.md) — release notes and tool-surface changes.

## Development

```bash
git clone https://github.com/kneelinghorse/cmos-mcp
cd cmos-mcp
npm install
npm run build
npm test
```

Pre-commit hooks run lint + format via husky/lint-staged. This public repository is a code mirror;
release validation and npm publishing run from the private source.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
