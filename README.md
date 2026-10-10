# CMOS — decisions that survive the session

[![npm version](https://img.shields.io/npm/v/@aquex/cmos-mcp)](https://www.npmjs.com/package/@aquex/cmos-mcp)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)

CMOS is the project record your agents keep: what was decided, why, what was learned,
and what remains. The next session can pick up from that record, even in another tool.
You make the decisions; agents handle the bookkeeping. No dashboard account is required.

## Get a project digest in three steps

Requires Node.js 20 or newer.

1. Install the pinned CLI:

   ```sh
   npm install -g @aquex/cmos-mcp@3.4.0
   ```

   Ensure the global npm bin directory is on your PATH.

2. In the project folder you want to track, start a Ledger:

   ```sh
   cd /absolute/path/to/your/project
   cmos-mcp init --level ledger
   ```

3. Read its first digest:

   ```sh
   cmos-mcp review --format=context
   ```

The digest names this project and shows its decisions, lessons and open work. A new
Ledger starts empty. Planner adds next steps; Builder adds sprints and missions.

## Let Claude Code bring the record into each session

Once the public plugin release is available, run these in your project folder:

```sh
claude plugin marketplace add kneelinghorse/cmos-mcp
claude plugin install cmos@cmos --scope local
```

For candidate testing, replace `kneelinghorse/cmos-mcp` with this checkout's absolute
path. Start a new Claude Code session after installation. The plugin supplies the
MCP server, hooks and commands; its first cold session may report that CMOS is
installing and load the record from the next session. Use `/cmos:init` for a new
record, `/cmos:start` to read it, `/cmos:close-out` to finish work, `/cmos:plan` to plan,
and `/cmos:build` to execute. [Plugin installation](https://code.claude.com/docs/en/discover-plugins).
Other tools use the [harness adapters and coverage guide](docs/harnesses.md).

## The method

- One project, one record of decisions, lessons, constraints and next steps.
- Start from that record; supported hooks bring it into the session automatically.
- Record decisions deliberately, with reasons. Supersede a changed decision.
- Make expiry and supersession visible; closing a sprint keeps records active by default.
- Keep the record with the project so it survives a change of tools.

## What leaves your machine

The record stays in your project's SQLite file. With a stored user-scoped key or legacy
environment credentials, explicit session and sprint closes attempt a background
upload of the **whole file**, including pending and declined proposals. For a registered project,
MCP tool writes also schedule an upload after 5 quiet minutes or 30 minutes of continuous writes;
the next poll starts it within 60 seconds when no upload lease or failure backoff blocks it.
Transfer time follows. See the timing and failure details under [Optional: hosted dashboard](#optional-hosted-dashboard).
`CMOS_CHECKPOINT_SYNC=off` stops automatic uploads, not requested network actions or
shared-collaboration pushes. Implicit process-exit closes do not upload. [Full network and data disclosure](SECURITY.md#outbound-network).

## Technical reference

## What it is

cmos-mcp is the protocol + client. It runs locally on your machine, owns a SQLite database under `cmos/db/cmos.sqlite`, and exposes 15 typed tools to any MCP-capable agent (Claude Code, Claude Desktop, Cursor, Zed, VS Code, Windsurf).

Out of the box you get:

- Sprint and mission state machines with auditable transitions
- Session capture for decisions, learnings, constraints, next-steps
- Strategic context that condenses across sprints, with FTS5 retrieval
- Full-text search across decisions, learnings, missions, sessions
- Database snapshots on demand; backup attempts around sprint closes; required backups before
  a restore or a snapshot prune with selected rows
- Per-project credential store and device-code auth (RFC 8628)

The dashboard at [cmos.aquex.ai](https://cmos.aquex.ai) is **optional**. You can run cmos-mcp standalone forever — sign-up unlocks sync (SQLite ↔ Postgres mirror), the project registry (`cmos://you/*` addresses), and cross-project messaging. Without it, every other tool still works locally.

## Install

Recommended: a global install of this release. The server then starts from disk, with no registry
lookup on launch:

```bash
npm install -g @aquex/cmos-mcp@3.4.0
```

Or run it on demand with `npx`. Pin the version and prefer the local cache: an unpinned `npx -y`
can look the package up again on every launch.

```bash
npx --prefer-offline -y @aquex/cmos-mcp@3.4.0
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
claude mcp add-json cmos-mcp '{"command":"npx","args":["--prefer-offline","-y","@aquex/cmos-mcp@3.4.0"]}'
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
        "@aquex/cmos-mcp@3.4.0",
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
      "args": ["--prefer-offline", "-y", "@aquex/cmos-mcp@3.4.0"]
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
      "args": ["--prefer-offline", "-y", "@aquex/cmos-mcp@3.4.0"]
    }
  }
}
```

### VS Code (Claude extension)

Use the Claude Code command above from the integrated terminal, or add the server
through `/mcp` in the Claude panel. The extension and CLI share MCP configuration;
start a new conversation after changing it. The extension does not add `claude` to
your terminal PATH, so the terminal route needs the standalone Claude CLI.
[Claude Code in VS Code](https://code.claude.com/docs/en/vs-code#connect-to-external-tools-with-mcp)

### Windsurf

```json
{
  "mcpServers": {
    "cmos-mcp": {
      "command": "npx",
      "args": ["--prefer-offline", "-y", "@aquex/cmos-mcp@3.4.0"]
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

`cmos_review` returns the shared session digest: project identity, current sprint, open work and recent decisions. Its local text core is capped at 4,000 characters; appended portfolio context and the surrounding MCP response are outside that cap.

The full walkthrough — install → config → init → first sprint/mission/session loop — lives in [docs/getting-started.md](docs/getting-started.md).

## Tool surface

cmos-mcp exposes 15 consolidated tools. 12 use an `action` parameter to select the operation; `cmos_agent_onboard`, `cmos_status` and `cmos_review` take no `action`. [TOOL_REFERENCE.md](TOOL_REFERENCE.md) publishes one parameter table per action, so it says which parameters actually apply to a given call.

| Tool                      | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `cmos_review`             | Session digest: identity, current sprint, work queue, decisions               |
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

With a stored user-scoped dashboard key or legacy environment credentials, explicit `cmos_session(action="complete")` and `cmos_sprint(action="complete")` calls attempt a background upload and may register the project first. For a registered project, an MCP tool call that actually writes its store also schedules an upload. It becomes due after 5 quiet minutes or 30 minutes of continuous writes, and starts within the next 60 seconds when no upload lease or failure backoff blocks it. A running server must have opened the project; work owed by a short-lived process survives for the next server. Each upload sends a consistent snapshot of the whole SQLite file, including pending, declined and expired proposals. Transfer time is additional, and concurrent servers share one upload lease per project.

Upload results and failures appear in `cmos_status` and `cmos_review`. HTTP 401, 402 or 403 pauses automatic retries until an explicit close succeeds. A failed upload does not fail the local write or close. Implicit process-exit closes do not upload. Set `CMOS_CHECKPOINT_SYNC=off` in the server environment to disable automatic uploads; it does not disable explicit sync, messaging, sign-in, shared-collaboration pushes or other requested network actions. See [SECURITY.md](SECURITY.md#outbound-network).

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

## Move work out of a central planning folder

If you collect several efforts in one CMOS project, use `spin-out` when an effort needs its
own project folder. It copies selected missions, their linked decisions, learnings and next
steps, and any additional record IDs you name. The source remains a readable history with
pointers to the new project.

Create the destination folder first. The source must be registered, and the two stores must
have distinct project identities. Both roots are required; this command does not use an ambient
project or registry default. Omit `--apply` to preview the selection and mapping:

```sh
cmos-mcp spin-out --from /work/projects --to /work/new-product --sprint sprint-12

# Or select missions, with additional decisions, learnings and next steps by ID:
cmos-mcp spin-out --from /work/projects --to /work/new-product \
  --missions product-plan,product-prototype \
  --decisions 41,42 --learnings 17 --next-steps 23,24

# Apply the same reviewed selection:
cmos-mcp spin-out --from /work/projects --to /work/new-product \
  --missions product-plan,product-prototype \
  --decisions 41,42 --learnings 17 --next-steps 23,24 --apply
```

Choose either `--sprint` or `--missions`. A destination without CMOS is reported as needing
initialization in the preview; `--apply` initializes it and takes database backups before
copying. Copied work retains its status but has no sprint assignment in the destination.
Assign it to a target sprint when ready. Source Queued, Blocked and Deferred missions become
Dropped; Completed and already Dropped missions retain their status. Source decisions and
learnings become archived, and source next steps become dropped. Default lists and retrieval
omit these transferred source rows. Sprint history retains its counts and identifies transfers
with their destination pointers. No sprint closes automatically.

Read a source or copied decision, learning or mission with its existing `show` action and an
explicit `projectRoot`; the result includes `spunOutTo` or `spinOutOrigin` and a readable address.
For a historical next step, use
`cmos_context(action="next_steps", nextStepAction="list", nextStepIds=[23], projectRoot="/work/projects")`.
Explicit IDs include moved or dropped rows; an explicit `nextStepStatus` still filters them.
The ordinary next-step list continues to show open work. Target next steps without a sprint
are flagged idle after 42 days. The CLI does not upload either store immediately: each enters
the normal upload schedule after its next successful MCP write, subject to the configured
[upload controls](#optional-hosted-dashboard).

Retry the exact command after an interruption. A verified completed operation returns unchanged.
If source records changed after the target copy committed, final source marking is refused and
both stores are preserved for review. If a reserved retry lacks its committed target receipt,
the command also refuses: it cannot distinguish a crash before copying from an erased proof of
an earlier copy. Preserve **both roots and the operation ID** named in the remedy, inspect their
ledgers and pre-write snapshots, and resolve or restore the conflicting state before retrying.
Do not delete a reservation to force another copy; retries never silently overwrite copied work.

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

# Optional — disable background uploads after writes and explicit completion calls.
# Shared-store propagation and explicitly requested network actions remain available.
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
- **Database snapshots.** `cmos_db(action="snapshot")` copies the database on demand. A `cmos_sprint(action="complete")` attempts a snapshot before and after the close; a snapshot failure warns without blocking completion. Applying `cmos_db(action="prune_snapshots")` to a nonempty selection requires a backup, and `cmos_db(action="restore")` first copies the live database to `cmos/db/snapshots/pre-restore/`. `CMOS_MAX_SNAPSHOTS` caps how many are kept: taking one deletes the oldest beyond it, automatic ones included. Nothing else snapshots first, and there is no soft-delete net — `cmos_db(action="purge")` deletes this project's data from the dashboard mirror. See [SECURITY.md](SECURITY.md#backups--deletion--the-honest-reality).
- **Dry-run where it exists.** `cmos_context(action="condense")` and `cmos_db(action="backfill")` accept `dryRun` to preview without committing. It is not a general property of mutating tools.

## Known limits

- Registered projects sync after writes and explicit closes while a server is running; manual `cmos_db(action="backfill")` requests a sync immediately.
- SQLite is the source of truth and the Postgres mirror is a mirror. To bring state down, `cmos_db(action="clone")` bootstraps a fresh machine from dashboard state and `cmos_db(action="pull")` merges events since your last cursor.
- Cross-user messaging on the dashboard is paid-tier; same-user (multi-device) messaging is free.

## Documentation

- [Getting started](docs/getting-started.md) — client configuration and an optional Builder walkthrough.
- [Harness coverage](docs/harnesses.md) — native adapters, MCP prompts and the fallback without hooks.
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
