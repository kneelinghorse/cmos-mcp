---
name: start
description: Review the current Reasonbook project and recover its working context. Use at session start or when resuming work; review alone does not begin work or change project state.
---

# Reasonbook start

**First, check that the Reasonbook tools are here.** If `rbook_review` and the other Reasonbook
tools are not available, do not do the work: stop and tell the user which case applies. If the
session-start message or the server's instructions say Reasonbook is installing, they should start
a new session once installation finishes. Otherwise Reasonbook needs its local server, which runs in
Claude Code or Codex but not in claude.ai chat; the install steps are at
https://github.com/kneelinghorse/reasonbook#readme.

Read the project's agent rules, then call `rbook_review()` for the intended project. Use the
project folder already named by the user or established by the current session. If the digest
is already present and current, reuse it. Read the authoritative roadmap or foundational
documents needed to understand the user's requested work.

Summarize the active work, relevant decisions and the next eligible step. Inspect a mission
with `rbook_mission(action="show", missionId="<id>")` when its full objective or dependencies are
needed. Treat warnings and surviving next steps as evidence to assess in context. Report an
unresolved project identity or unavailable record instead of inventing the missing context.

This command reviews context; it does not initialize a project, start or complete a mission,
create a session, capture a record or publish changes. Continue previously authorized work
when the user's request calls for it. Otherwise, report the current state and the proposed
next step. Use `/reasonbook:plan` for requested planning or `/reasonbook:build` for requested implementation.
