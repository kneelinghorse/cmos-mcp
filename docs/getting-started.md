# Getting started with cmos-mcp

This walks you from a clean machine to a working CMOS workspace with a sprint, a mission, and a session captured. The dashboard at [cmos.aquex.ai](https://cmos.aquex.ai) is **not** required for any of it — local mode is the default. There's an opt-in section at the end if you want to connect.

Total time: under 10 minutes.

## Prerequisites

- Node.js 20 or newer (`node -v`)
- An MCP-capable client: Claude Code, Claude Desktop, Cursor, Zed, VS Code (Claude extension), or Windsurf

## 1. Install the server

Pick one:

```bash
# Recommended: a global install of this release. It starts from disk, with no registry lookup.
npm install -g @aquex/cmos-mcp@3.2.0

# Or run on demand via npx: pinned, and preferring the local cache. The first launch downloads
# the package; later launches reuse the npm cache.
npx --prefer-offline -y @aquex/cmos-mcp@3.2.0
```

Verify it starts:

```bash
cmos-mcp --version  # if globally installed (the bin is `cmos-mcp`)
# or
npx --prefer-offline -y @aquex/cmos-mcp@3.2.0 --version
```

Semantic (vector) search is optional: without it, retrieval is keyword-only and the install is about
45 MB. To add a vector term, install `@xenova/transformers` next to cmos-mcp;
`cmos_db(action="health")` reports whether semantic search is on.

## 2. Wire it into your MCP client

Pick the block that matches your tool. Each example runs a pinned version through `npx`, preferring the local cache; to upgrade, change the version. With the global install, use `"command": "cmos-mcp"` and drop the `npx` arguments (keep `--project-root` where an example has it).

### Claude Code

```bash
claude mcp add-json cmos-mcp '{"command":"npx","args":["--prefer-offline","-y","@aquex/cmos-mcp@3.2.0"]}'
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

Restart Claude Desktop. Claude Desktop starts servers with no project context (on macOS, from `/` with
no workspace roots), so the config names the project: `--project-root` applies to calls that pass no
`projectRoot`, and only to this server entry. (If the project does not exist yet, create it in step 3
first.)

### Cursor

Edit `~/.cursor/mcp.json`:

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

Edit your Zed `settings.json`:

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

Edit your user `settings.json`:

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

## 3. Initialize CMOS in your project

In your client, ask the agent to run:

```
cmos_project(action="init", projectRoot="/absolute/path/to/your/project", projectName="My Project")
```

This creates `cmos/db/cmos.sqlite` (the source of truth), a starter context, and an `AGENTS.md` at the project root with the repository rules to fill in (an existing `AGENTS.md` or `agents.md` is left as it is). Use the absolute path for clarity — relative paths resolve against the agent's CWD, which varies.

On Claude Desktop, the `--project-root` from step 2 points the server at this project. A machine-wide
alternative, used by any server that starts with no project context and no `--project-root`:

```
cmos_project(action="register", projectRoot="/absolute/path/to/your/project", setAsDefault=true)
```

Claude Code, Cursor, Zed, VS Code, and Windsurf resolve the project from the working directory (or the
nearest folder above it holding `cmos/db/`) and need neither.

## 4. Cold-start the agent

```
cmos_agent_onboard()
```

You'll get a single payload with project identity, the active sprint (if any), pending missions, recent decisions, context freshness, and suggested actions. History arrives as 300-character previews with ids, so the payload stays under 28 KB however long the project runs; read one decision in full with `cmos_decisions(action="show", decisionId=…)`. `cmos_agent_onboard` is the **cold-start / fresh-project** entry point — if this is a fresh project the payload includes `freshProject: true` and a `tierSelectionPrompt`, and the first suggested action is to follow it.

For an **ongoing** session (a project that already has state), open with `cmos_review` instead — it returns the same essentials as a tighter ≤4 KB digest with the top next actions promoted to a flat field.

## 5. Plan your first sprint

```
cmos_sprint(action="add", sprintId="sprint-01", title="First sprint", focus="Ship the first end-to-end feature")
```

```
cmos_session(action="start", type="planning", title="Plan sprint 01", sprintId="sprint-01")
```

Starting a session is optional. A capture made without one lands in an implicit session that the server opens for its process and closes when the process ends. Start one explicitly when you want the work titled, typed or tagged to a sprint; `sprintId` may name any existing sprint, including a planned one.

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

When you're done coding, finish the mission with notes only, then record what you decided in its own call:

```
cmos_mission_transition(action="complete", missionId="s01-m01",
                        notes="Built feature X, added tests, snapshotted DB before migration")
```

```
cmos_decisions(action="record", missionId="s01-m01",
               content="Chose event sourcing for the audit trail")
```

Keep the two apart. Some hosts drop a closing tag when a long free-text parameter and an array share
one call, and the array is absorbed into the text; the server refuses such a completion rather than
completing without your decisions.

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

That's the loop: **review → start mission → execute → complete → review**; `cmos_agent_onboard` is for a project's first session. Sprints close with `cmos_sprint(action="complete")`, which stamps the close time, takes a database snapshot before and after the close and a context snapshot, and cleans up working memory. The sprint's decisions and learnings stay active unless you pass `archive: true`.

## Local mode is the default

With the default install and no dashboard sign-in, nothing above used the network once the package was installed: there is no credential, so nothing is uploaded, and without the optional `@xenova/transformers` no model is downloaded. Your data lives in `cmos/db/cmos.sqlite`. Append-only events protect your audit trail. `cmos_db(action="snapshot")` copies the database whenever you ask, and CMOS takes one itself before a restore, around a sprint close and before a snapshot prune — but nothing else snapshots first, so take one before anything else destructive.

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

### What happens next

Nothing more to run. Once you are signed in, the next `cmos_session(action="complete")` or `cmos_sprint(action="complete")` registers the project on the dashboard, stores its project-scoped key next to your user credential, and uploads the whole SQLite file; every later close uploads it again. Set `CMOS_CHECKPOINT_SYNC=off` to keep closes local. (`cmos_project(action="register", projectRoot=…)` is different: it records the project in the local registry only.)

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

**A tool answers "No CMOS project in '<dir>'"** (or, for a `projectRoot` you passed, `CMOS_NOT_DETECTED`: "CMOS directory not found starting from '<dir>'"): that folder has no `cmos/db/cmos.sqlite`. Either `cd` into a project that has one, pass the right `projectRoot`, or run the `cmos_project(action="init", ...)` call the answer names.

**Claude Desktop shows the server but tools return errors**: Claude Desktop has no working-directory context. Add `"--project-root", "/absolute/path/to/your/project"` to the server's `args` (step 2), or set a default with `setAsDefault` (step 3). A default set before 3.2.0 must be re-confirmed with `setAsDefault` before it applies.

**A dashboard tool returns `DASHBOARD_NOT_CONFIGURED`**: there is no dashboard credential yet. Sign in with `cmos_auth(action="login_init")` and `login_complete`. The dashboard URL is not the cause: an unset or empty `CMOS_DASHBOARD_URL` means `https://cmos.aquex.ai`.

**Tool calls show as unauthorized after a successful login**: the local credential store may be on a different config dir than the running server. Check `CMOS_CONFIG_DIR` matches across your shell and MCP client launch env.

**Dashboard returns HTTP 402**: this is the paid-tier denial path (e.g., cross-user messaging from a free account). The error includes a sign-up pointer.
