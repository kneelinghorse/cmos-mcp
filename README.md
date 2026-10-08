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
- Database snapshots on demand, and automatically before a restore, before and after a sprint close,
  and before a snapshot prune
- Per-project credential store and device-code auth (RFC 8628)

The dashboard at [cmos.aquex.ai](https://cmos.aquex.ai) is **optional**. You can run cmos-mcp standalone forever — sign-up unlocks sync (SQLite ↔ Postgres mirror), the project registry (`cmos://you/*` addresses), and cross-project messaging. Without it, every other tool still works locally.

## Install

Recommended: a global install of this release. The server then starts from disk, with no registry
lookup on launch:

```bash
npm install -g @aquex/cmos-mcp@3.2.0
```

Or run it on demand with `npx`. Pin the version and prefer the local cache: an unpinned `npx -y`
can look the package up again on every launch.

```bash
npx --prefer-offline -y @aquex/cmos-mcp@3.2.0
```

Semantic (vector) search is optional. Without it, retrieval is keyword-only, and the install is
about 45 MB instead of about 306 MB. To add a vector term to retrieval, install
`@xenova/transformers` next to cmos-mcp. `cmos_db(action="health")` reports whether it is on.

Requires Node.js 20 or newer.

## Configure your MCP client

Each example below runs a pinned version through `npx`, preferring the local cache; to upgrade,
change the version. With the global install, use `"command": "cmos-mcp"` and drop the `npx`
arguments (keep `--project-root` where an example has it).

### Claude Code

```bash
claude mcp add-json cmos-mcp '{"command":"npx","args":["--prefer-offline","-y","@aquex/cmos-mcp@3.2.0"]}'
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on Windows/Linux:

```json
{
  "mcpServers": {
    "cmos-mcp": {
      "command": "npx",
      "args": [
        "--prefer-offline",
        "-y",
        "@aquex/cmos-mcp@3.2.0",
        "--project-root",
        "/absolute/path/to/your/project"
      ]
    }
  }
}
```

Claude Desktop starts servers with no project context (on macOS, from `/` with no workspace roots),
so name the project in the config. `--project-root` applies only to this server entry, and only to
calls with no project context: no `projectRoot`, no workspace roots, and a working directory of `/`,
your home directory or the server's install directory. A client that starts the server from any
other folder should pass `projectRoot` instead.

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cmos-mcp": {
      "command": "npx",
      "args": ["--prefer-offline", "-y", "@aquex/cmos-mcp@3.2.0"]
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
      "args": ["--prefer-offline", "-y", "@aquex/cmos-mcp@3.2.0"]
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
      "args": ["--prefer-offline", "-y", "@aquex/cmos-mcp@3.2.0"]
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
      "args": ["--prefer-offline", "-y", "@aquex/cmos-mcp@3.2.0"]
    }
  }
}
```

## First call

Project tools work on a folder that has a CMOS database, so a new project starts with init:

```
cmos_project(action="init", projectRoot="/absolute/path/to/your/project")
```

`init` creates `cmos/db/cmos.sqlite`, the seed files, and an `AGENTS.md` at the project root (unless
one is already there). In a folder without that database, the tools that read or write a project
refuse and name `init`; registry and sign-in actions need no project.

Then run `cmos_agent_onboard` once: on a new project it walks the first-session setup. Open every
later session with the session digest:

```
Run cmos_review to see the project state.
```

`cmos_review` returns a ≤4 KB digest — project identity, current sprint, work queue, recent decisions, freshness, and the top next actions — in one call.

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
| `cmos_session`            | Work sessions (optional) — start, capture insights, complete, list, search    |
| `cmos_context`            | Master/project context — view, update, condense, snapshot, and search         |
| `cmos_decisions`          | Strategic decisions — record, show, list, search, update, staleness review    |
| `cmos_learnings`          | Cross-cutting learnings — list, search, show, update, and reaffirm            |
| `cmos_db`                 | Database ops — health, snapshot/restore, sync, and a context-snapshot prune   |
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

`CMOS_DASHBOARD_URL` defaults to `https://cmos.aquex.ai`. Until you sign in, the dashboard tools (`cmos_message`, sync, registry) return a structured `DASHBOARD_NOT_CONFIGURED` error that names `cmos_auth(action="login_init")`; a paid-tier feature on a free account returns `DASHBOARD_UPGRADE_REQUIRED`. Local tools never depend on the dashboard.

Once any dashboard credential exists, every `cmos_session(action="complete")` and `cmos_sprint(action="complete")` uploads the whole SQLite file to the dashboard (see [SECURITY.md](SECURITY.md#outbound-network)). Set `CMOS_CHECKPOINT_SYNC=off` to stop that upload.

## Project resolution

cmos-mcp never acts on a project you did not name. For each tool call it picks one project, in this
order, and refuses rather than falling back when that project cannot be used:

1. The `projectRoot` parameter on the call. A folder that is not a CMOS project is refused.
2. The workspace roots your MCP client advertises: the first one inside a CMOS project.
3. The working directory, or the nearest folder above it that is a CMOS project — one holding
   `cmos/db/`; a plain folder named `cmos` does not count (the search stops below your home
   directory).
4. Only when the server has no project context at all — no `projectRoot`, no roots, and a working
   directory of `/`, your home directory or the server's install directory (how Claude Desktop starts
   servers): the `--project-root <dir>` argument in that server's config, then a registry default set
   with `cmos_project(action="register", projectRoot="...", setAsDefault=true)`.
5. Otherwise the call is refused. In a folder that is not a CMOS project, a write names
   `cmos_project(action="init")` and a read answers "No CMOS project in '<dir>'".

Every successful response names the project it used (`projectRoot` and `resolvedBy` in its data), and
says so in its text whenever the project came from workspace roots, `--project-root` or the registry
default. A registry default set before 3.2.0 is not applied until you re-run `setAsDefault`; the
server, `cmos_message(action="whoami")` and `cmos_review` say so when one exists.

## Environment variables

```bash
# Optional — connects to the hosted dashboard. Defaults to https://cmos.aquex.ai
# when unset; treat empty string as unset.
CMOS_DASHBOARD_URL=https://cmos.aquex.ai

# Optional — the directory the server reads its own .env from. It does NOT select a project:
# use the projectRoot parameter, or --project-root in a server's config.
CMOS_PROJECT_ROOT=/path/to/your/project

# Optional — override the credential + registry directory. Default: ~/.config/cmos-mcp
CMOS_CONFIG_DIR=/custom/path

# Snapshot retention (default shown)
CMOS_MAX_SNAPSHOTS=50

# Optional — stop the whole-database upload that session and sprint closes make once you have
# signed in to the dashboard.
CMOS_CHECKPOINT_SYNC=off
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

- **Append-only audit.** Session events and mission transitions are append-only rows. Context snapshots keep their rows, ids and events, but `cmos_db(action="prune_snapshots")` can empty the content of copies CMOS wrote on its own.
- **Atomic credential writes.** `credentials.json` is written via temp-file + rename with 0600 permissions.
- **Database snapshots.** `cmos_db(action="snapshot")` copies the database on demand. CMOS also takes one before and after every `cmos_sprint(action="complete")` and before `cmos_db(action="prune_snapshots")` applies, and `cmos_db(action="restore")` first copies the live database to `cmos/db/snapshots/pre-restore/`. `CMOS_MAX_SNAPSHOTS` caps how many are kept: taking one deletes the oldest beyond it, automatic ones included. Nothing else snapshots first, and there is no soft-delete net — `cmos_db(action="purge")` deletes this project's data from the dashboard mirror. See [SECURITY.md](SECURITY.md#backups--deletion--the-honest-reality).
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
