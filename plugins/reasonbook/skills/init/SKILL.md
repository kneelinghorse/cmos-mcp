---
name: init
description: Initialize Reasonbook in the user's chosen project folder and select Ledger, Planner or Builder depth. Use for starting a Reasonbook record, including projects without a global Reasonbook CLI installation.
---

# Reasonbook init

**First, check that the Reasonbook tools are here.** If `rbook_review` and the other Reasonbook
tools are not available, do not do the work: stop and tell the user which case applies. If the
session-start message or the server's instructions say Reasonbook is installing, they should start
a new session once installation finishes. Otherwise Reasonbook needs its local server, which runs in
Claude Code or Codex but not in claude.ai chat; the install steps are at
https://github.com/kneelinghorse/reasonbook#readme.

Use the project folder the user named, or the current project when unambiguous. Do not choose a
parent project or create a nested record by accident. Read existing agent rules first.

For a new record, ask one level question unless the user already answered it: “What should
Reasonbook track here: Ledger for decisions and learnings, Planner for those plus next steps, or
Builder for those plus sprints and missions?” Use the stated answer; do not infer Builder from the
presence of code. For an existing Reasonbook project, preserve its level unless a change was requested.

Call the project's initialization tool:

```text
rbook_project(action="init", projectRoot="<chosen project folder>", projectType="general")
```

Map Ledger to `general`, Planner to `managed` and Builder to `build`. Omit `projectType` when
rerunning init without a requested level change. The plugin already provides lifecycle hooks.

Read the tool's receipt, including the effective level, generated or preserved files and any
warnings. On failure, report the actual error and remedy; do not claim the record exists. Existing
project instructions stay authoritative. Initialization does not authorize changing the user's
global MCP configuration or creating a mission unrelated to the requested project.
