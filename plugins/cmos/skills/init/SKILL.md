---
name: init
description: Initialize CMOS in the user's chosen project folder and select Ledger, Planner or Builder depth. Use for starting a CMOS record, including projects without a global CMOS CLI installation.
---

# CMOS init

Use the project folder the user named, or the current project when unambiguous. Do not choose a
parent project or create a nested record by accident. Read existing agent rules first.

For a new record, ask one level question unless the user already answered it: “What should CMOS
track here: Ledger for decisions and learnings, Planner for those plus next steps, or Builder for
those plus sprints and missions?” Use the stated answer; do not infer Builder from the presence
of code. For an existing CMOS project, preserve its level unless a change was requested.

Run the plugin's pinned CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs" init --project-root /absolute/project --level ledger
```

Replace `ledger` with the chosen `planner` or `builder` answer. Omit `--level` when rerunning init
without a requested level change. Add `--no-hooks` only when preparing a project for a harness
that has no hooks; Claude Code with this plugin already has hooks.

Read the command's receipt, including the effective level, generated or preserved files and any
warnings. On failure, report the actual error and remedy; do not claim the record exists. Existing
project instructions stay authoritative. Initialization does not authorize changing the user's
global MCP configuration or creating a mission unrelated to the requested project.
