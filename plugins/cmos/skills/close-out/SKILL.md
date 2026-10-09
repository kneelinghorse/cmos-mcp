---
name: close-out
description: Close a CMOS sprint or session with verified work, deliberate carry-forwards and an audited receipt. Use when the user requests closeout; follow the project's own release and close checklist.
---

# CMOS close-out

Read the project's agent rules and any named close or release checklist **before making close
mutations**. Its ordering is authoritative: place reconciliation writes (mission completion,
decision and learning captures, and next-step carry) before any final state commit and test
boundary the checklist requires. Satisfy release evidence, runtime, review and commit prerequisites
in their prescribed order before sprint close. Reuse authorization already
given for this work. If a required outward action is outside that authorization, prepare its
reviewable result and identify the missing authorization instead of silently skipping it.

Read `cmos_review()` and inspect the scope being closed. For a sprint, use
`cmos_mission(action="status", includeBlocked=true)` and `cmos_sprint(action="show", sprintId="<id>")`.
Reconcile completed work with actual code, tests and evidence. Do not complete an unfinished
mission merely to make closeout succeed. Keep any mission-completion call notes-only; record
material decisions, learnings and feedback separately. Counts in the close summary state the
filter or counting rule.

Read open next steps with `cmos_context(action="next_steps", nextStepAction="list")`. Complete what
was done, drop what is deliberately obsolete, and carry what remains useful with
`cmos_context(action="next_steps", nextStepAction="carry", nextStepIds=[<ids>])`.
Add `carryToSprint` only for an existing target sprint; omit it to park work without inventing a
sprint. Carry renews the lease, so do not carry everything automatically. Local next-step carry
does not require cross-project messages. A closeout request alone does not authorize sending them.

After these writes, finish any final pre-close commit and validation boundary required by the
checklist. A later mutation invalidates that boundary: repeat the affected commit and validation
steps before closing.
Once all prerequisites are satisfied, close only the requested scope:

- For a sprint, call `cmos_sprint(action="complete", sprintId="<id>", summary="<verified outcome>")`.
  Preserve the default of leaving decisions and learnings active unless archival was requested.
  Build freshness is advisory; read its warning and follow the project's runtime rules.
- For an existing session being closed, call
  `cmos_session(action="complete", sessionId="<id>", summary="<verified outcome>")`.
  Do not create a session solely to close it or close an unrelated session.

Read the successful receipt before reporting success. For a sprint, both
`data.lifecycle.archivedDecisionIds` and `data.lifecycle.learningIds` must be arrays. If a
successful close lacks an auditable receipt, report that the close already happened and what is
missing; do not repeat the mutation to obtain a better receipt. On failure, keep the scope open
and explain the unmet requirement. Complete the project's remaining checklist steps, then report
the closed scope, verification, warnings and carry-forwards. Offer `/cmos:plan` for the next arc.
