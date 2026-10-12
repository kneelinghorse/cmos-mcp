---
name: build
description: Execute the current Reasonbook mission queue, implementing and verifying each mission before recording completion. Use for a Reasonbook build session or an explicit request to work through missions.
---

# Reasonbook build

**First, check that the Reasonbook tools are here.** If `rbook_review` and the other Reasonbook
tools are not available, do not do the work: stop and tell the user which case applies. If the
session-start message or the server's instructions say Reasonbook is installing, they should start
a new session once installation finishes. Otherwise Reasonbook needs its local server, which runs in
Claude Code or Codex but not in claude.ai chat; the install steps are at
https://github.com/kneelinghorse/reasonbook#readme.

Use the project's current record instead of a handoff file. Call `rbook_review()` for the project
digest, read the project's agent rules, and follow its development and release requirements.
If the digest is already in this session, refresh only what has changed.

1. Read `rbook_mission(action="status", includeBlocked=true)`. Select In Progress before Current
   before Queued, within the user's requested scope and the mission's dependencies. If a selected
   mission is blocked, resolve its stated dependency or choose other eligible work; do not erase
   a blocker by starting it. After verifying that its blocker is resolved, call
   `rbook_mission_transition(action="unblock", missionId="<id>", resolution="<what resolved the blocker>")`.
   Resume the returned In Progress state; if deliberately unblocked to Current, start it normally.
2. Read the selected mission with `rbook_mission(action="show", missionId="<id>")` and read its
   `referenceDocs`, especially the sprint's design document. Resolve a conflict with the project's
   authoritative plan before coding. Use `rbook_mission_transition(action="start", missionId="<id>")`
   when work is ready to begin; inspect the returned relevant decisions. Resume an already
   In Progress mission without inventing another start.
3. Implement the work and verify its success criteria. Follow the project's test-first workflow
   and required checks. A passing narrow test does not stand in for unrun integration or live
   criteria. Keep significant choices in Reasonbook while their reasons are fresh: use
   `rbook_decisions(action="record", missionId="<id>", content="<choice and reason>")` and capture
   cross-cutting lessons with `rbook_session(action="capture", category="learning", content="<lesson>")`.
   Set `evergreen: true` when a learning encodes a standing method, so it remains exempt from
   staleness archival even when a close opts into archival.
   Give delegated work a bounded scope and integrate its evidence before claiming it is done.
4. When every criterion is met, call
   `rbook_mission_transition(action="complete", missionId="<id>", notes="<implemented work and verification>")`.
   Keep this call notes-only; record decisions, learnings and feedback separately. If a write fails,
   report its actual result and retry only after addressing the cause.
5. Verify with `rbook_mission(action="status", includeBlocked=true)` and repeat while eligible work
   remains in scope. Honor the project's commit boundaries.

If work cannot proceed, use
`rbook_mission_transition(action="block", missionId="<id>", reason="<cause>", blockers=["<needed evidence or dependency>"])`.
State what is needed; never mark partially implemented or unverified work complete. A request to
pause ends the loop with an honest checkpoint. When the queue is exhausted, report what was done,
what was verified and anything outstanding. Sprint close and release follow the project's close
workflow and the user's scope; an empty queue alone does not authorize publishing or messaging.
