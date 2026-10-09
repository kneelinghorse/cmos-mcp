---
name: start
description: Review the current CMOS project and recover its working context. Use at session start or when resuming work; review alone does not begin a mission or change project state.
---

# CMOS start

Read the project's agent rules, then call `cmos_review()` for the intended project. Use the
project folder already named by the user or established by the current session. If the digest
is already present and current, reuse it. Read the authoritative roadmap or foundational
documents needed to understand the user's requested work.

Summarize the active work, relevant decisions and the next eligible step. Inspect a mission
with `cmos_mission(action="show", missionId="<id>")` when its full objective or dependencies are
needed. Treat warnings and surviving next steps as evidence to assess in context. Report an
unresolved project identity or unavailable record instead of inventing the missing context.

This command reviews context; it does not initialize a project, start or complete a mission,
create a session, capture a record or publish changes. Continue previously authorized work
when the user's request calls for it. Otherwise, report the current state and the proposed
next step. Use `/cmos:plan` for requested planning or `/cmos:build` for requested implementation.
