---
name: setup
description: Set up CMOS Chat by choosing an existing project record or creating a record in the chat's desktop project. Use when someone installs CMOS Chat or asks to start remembering a project's work.
---

Use the CMOS tools to establish which project this chat should use. Call
`cmos_project(action="list")` to show the known projects and their addresses. If the user has
chosen one, use its exact returned address as `projectRoot`; an address looks like
cmos://owner/project. Otherwise try `cmos_review()` in the chat's current project. State the
project named by the receipt before discussing its record. Ask the user to choose when the
intended project is ambiguous.

If CMOS is still installing, report that status. Once installation finishes, retry the CMOS
tools. If the chat still offers only installation status, tell the user to start a new session.
Do not claim a record was loaded from an installation receipt.

When there is no project record, offer to create one in this chat's folder. The folder must be
the exact current desktop project folder supplied by the app, the user, or the tool's refusal;
never derive a folder from an address. If none is available, explain how to open the intended
repository or folder as a local project in the desktop app, then return to this setup.

Ask which depth they want, recommending Ledger for decisions and learnings. Planner adds next
steps; Builder adds sprints and missions. Use an answer already given. After they agree to create
the record, call `cmos_project(action="init")` with that exact folder in `projectRoot` and map
Ledger to `projectType="general"`, Planner to `projectType="managed"`, or Builder to
`projectType="build"`. Preserve an existing record's level unless the user requests a change.

Read the initialization receipt and warnings, then call `cmos_review()` with the selected project.
Explain what was created and what can be remembered next. Use only CMOS tools; if a remedy needs
an unavailable capability, explain the limitation in plain words and keep the record unverified.
