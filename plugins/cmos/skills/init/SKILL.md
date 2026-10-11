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

Call the project's initialization tool:

```text
cmos_project(action="init", projectRoot="<chosen project folder>", projectType="general")
```

Map Ledger to `general`, Planner to `managed` and Builder to `build`. Omit `projectType` when
rerunning init without a requested level change. The plugin already provides lifecycle hooks.

Read the tool's receipt, including the effective level, generated or preserved files and any
warnings. On failure, report the actual error and remedy; do not claim the record exists. Existing
project instructions stay authoritative. Initialization does not authorize changing the user's
global MCP configuration or creating a mission unrelated to the requested project.
