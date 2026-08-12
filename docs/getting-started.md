# Getting started with cmos-mcp

This walks you from a clean machine to a working CMOS workspace with a sprint, a mission, and a session captured. The dashboard at [cmos.aquex.ai](https://cmos.aquex.ai) is **not** required for any of it — local mode is the default. There's an opt-in section at the end if you want to connect.

Total time: under 10 minutes.

## Prerequisites

- Node.js 18 or newer (`node -v`)
- An MCP-capable client: Claude Code, Claude Desktop, Cursor, Zed, VS Code (Claude extension), or Windsurf

## 1. Install the server

Pick one:

```bash
# Global install — fastest startup, command always on PATH
npm install -g @aquex/cmos-mcp

# Or run on demand via npx — no global state, ~1s slower start
npx -y @aquex/cmos-mcp
```

Verify it starts:

```bash
cmos-mcp --version  # if globally installed (the bin is `cmos-mcp`)
# or
npx -y @aquex/cmos-mcp --version
```

## 2. Wire it into your MCP client

Pick the block that matches your tool. Each example launches the server via `npx` so the client picks up updates automatically.

### Claude Code

```bash
claude mcp add-json cmos-mcp '{"command":"npx","args":["-y","@aquex/cmos-mcp"]}'
claude mcp list   # confirm it's registered
```

Claude Code runs from your workspace directory, so the next step's auto-discovery just works.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows), or `~/.config/Claude/claude_desktop_config.json` (Linux):

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

Restart Claude Desktop. Claude Desktop has no working-directory context, so you'll register a default project explicitly in step 3.

### Cursor

Edit `~/.cursor/mcp.json`:

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

Edit your Zed `settings.json`:

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

Edit your user `settings.json`:

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

## 3. Initialize CMOS in your project

In your client, ask the agent to run:

```
cmos_project(action="init", projectRoot="/absolute/path/to/your/project", projectName="My Project")
```

This creates `cmos/db/cmos.sqlite` (the source of truth) and a starter context. Use the absolute path for clarity — relative paths resolve against the agent's CWD, which varies.

If you're on Claude Desktop and want this project picked up automatically next session:

```
cmos_project(action="register", projectRoot="/absolute/path/to/your/project", setAsDefault=true)
```

Claude Code, Cursor, Zed, VS Code, and Windsurf auto-discover from the working directory and don't need this step.

## 4. Cold-start the agent

```
cmos_agent_onboard()
```

You'll get a single payload (<4KB) with project identity, the active sprint (if any), pending missions, recent decisions, context freshness, and suggested actions. `cmos_agent_onboard` is the **cold-start / fresh-project** entry point — if this is a fresh project the payload includes a `freshProject: true` flag and the suggested action will be to start a planning session.

For an **ongoing** session (a project that already has state), open with `cmos_review` instead — it returns the same essentials as a tighter ≤4 KB digest with the top next actions promoted to a flat field.

## 5. Plan your first sprint

```
cmos_sprint(action="add", sprintId="sprint-01", title="First sprint", focus="Ship the first end-to-end feature")
```

```
cmos_session(action="start", type="planning", title="Plan sprint 01", sprintId="sprint-01")
```

Capture decisions as you make them:

```
cmos_session(action="capture", category="decision", content="Use device-code auth for the dashboard handshake")
```

```
cmos_session(action="capture", category="next-step", content="Wire cmos_status into the onboarding banner")
```

## 6. Add and start a mission

```
cmos_mission(action="add", missionId="s01-m01", name="First mission", sprintId="sprint-01",
             objective="Deliver the first end-to-end feature",
             successCriteria=["Feature works", "Tests pass", "Snapshot taken"])
```

```
cmos_mission_transition(action="start", missionId="s01-m01")
```

The transition tool surfaces relevant past decisions via FTS5 keyword overlap when you start a mission, so prior context flows in automatically.

## 7. Complete the work

When you're done coding, capture what you decided and finish the mission:

```
cmos_mission_transition(action="complete", missionId="s01-m01",
                        notes="Built feature X, added tests, snapshotted DB before migration",
                        decisions=["Chose event sourcing for the audit trail"])
```

```
cmos_session(action="complete", summary="Sprint 01 first mission shipped")
```

## 8. Check the state

```
cmos_review()
```

You'll see the completed mission, the captured decisions, and the updated context in the session digest. The next mission in the queue (if any) becomes the natural pull. `cmos_review` is the opener to reach for at the top of every ongoing session.

```
cmos_status()
```

Returns a 5-field health snapshot (`cmos_address`, `dashboard_url`, `auth_tier`, `last_sync_at`, `last_delivery_observed_at`). Useful for confirming local-only mode at a glance.

That's the loop: **onboard → start mission → execute → complete → onboard**. Sprints close with `cmos_sprint(action="complete")`, which triggers decision archival, a context snapshot, and working-memory cleanup.

## Local mode is the default

Everything above ran without a network connection. Your data lives in `cmos/db/cmos.sqlite`. Append-only events protect your audit trail, and `cmos_db(action="snapshot")` copies the database whenever you ask it to — take one before anything destructive, because nothing does it for you.

If you stay in local mode, you can ignore the next section forever.

## Optional: connect the hosted dashboard

The dashboard at [cmos.aquex.ai](https://cmos.aquex.ai) adds three things on top of local mode:

- **Sync** — `cmos_db(action="backfill")` pushes pending events to a Postgres mirror so your state survives machine swaps.
- **Project registry** — addressable `cmos://you/project-name` URIs across all your machines.
- **Messaging** — `cmos_message(action="send")` to your own projects (free) or, on the paid tier, to other users.

### Sign up

Visit [cmos.aquex.ai](https://cmos.aquex.ai) and create an account. Free.

### Connect from cmos-mcp

```bash
export CMOS_DASHBOARD_URL=https://cmos.aquex.ai
```

(Set it in your shell profile or your MCP client's env block. cmos-mcp also defaults to `https://cmos.aquex.ai` when the variable is unset, but exporting it explicitly is the convention.)

In your agent:

```
cmos_auth(action="login_init")
```

Returns a `userCode` and a `verificationUri`. Visit the URL in your browser, enter the code, approve the device. Then:

```
cmos_auth(action="login_complete", deviceCode="<the deviceCode from login_init>")
```

This polls until the device is approved (or 30s, whichever comes first; agents re-call until approved). On success, a user-scoped key persists atomically to `~/.config/cmos-mcp/credentials.json` with mode 0600.

### Register the project on the dashboard

```
cmos_project(action="register")
```

A project-scoped key is auto-issued on first registration and bound to your user-scoped credential. From this point forward, sync, registry, and messaging are wired.

### Verify

```
cmos_status()
```

`auth_tier` will read `device-code` and `dashboard_url` will reflect the configured URL. `cmos_message(action="whoami")` confirms sender attribution.

If you sign out:

```
cmos_auth(action="logout")
```

This revokes the user-scoped key on the dashboard and clears the local row. Project-scoped child keys keep working until you revoke them individually with `cmos_auth(action="revoke", keyId=...)`.

## Where to next

- [Tool reference](../TOOL_REFERENCE.md) — every tool, action, and parameter (generated from the tool definitions).
- [Changelog](../CHANGELOG.md) — release notes and tool-surface changes.
- [GitHub issues](https://github.com/kneelinghorse/cmos-mcp/issues) — bug reports and feature requests.

## Troubleshooting

**`cmos_agent_onboard` returns "no project found"**: the working directory has no `cmos/db/cmos.sqlite`. Either `cd` into a project that has one, pass `projectRoot` explicitly, or run `cmos_project(action="init", ...)`.

**Claude Desktop shows the server but tools return errors**: register a default project (step 3) — Claude Desktop has no working-directory context.

**`cmos_auth(action="login_init")` returns `DASHBOARD_NOT_CONFIGURED`**: `CMOS_DASHBOARD_URL` is empty. Set it to `https://cmos.aquex.ai` (or your dashboard host) and try again. cmos-mcp treats empty-string env values as unset.

**Tool calls show as unauthorized after a successful login**: the local credential store may be on a different config dir than the running server. Check `CMOS_CONFIG_DIR` matches across your shell and MCP client launch env.

**Dashboard returns HTTP 402**: this is the paid-tier denial path (e.g., cross-user messaging from a free account). The error includes a sign-up pointer.
