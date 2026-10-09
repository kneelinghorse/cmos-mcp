---
name: plan
description: Plan the next CMOS work from carry-forwards and the project's roadmap, with scope appropriate to its Ledger, Planner or Builder level. Use for CMOS planning and mission design, not to begin implementation automatically.
---

# CMOS plan

Read `cmos_review()`, the project's agent rules and its authoritative roadmap or foundational
documents. Start with open carry-forwards from
`cmos_context(action="next_steps", nextStepAction="list")`, then consider the roadmap's next arc.
Explain which work is still needed, already done or obsolete; a surviving row is evidence to
review, not a command to execute. Preserve the user's priorities and previously settled choices.

Match the plan to the project's chosen level:

- **Ledger:** record meaningful decisions and learnings. Do not create a sprint hierarchy for a
  project that only needs a durable record.
- **Planner:** add actionable next steps, dependencies and evidence of completion. Keep work as
  next steps unless the user wants the Builder workflow.
- **Builder:** write the scoped design in the project's tracked CMOS planning documents. State the
  outcome, non-goals, interfaces, alternatives, dependencies, measurable success criteria and
  validation plan. Link the document in each mission's `referenceDocs`. Before ratification, obtain
  an independent blocking critic that tries both to confirm and refute the design. A
  NEEDS-REVISION verdict must be resolved and re-reviewed; an advisory review is not a substitute.

Ground designs in the code, tool contracts and data that will actually be used. For cross-store,
migration or concurrency work, probe the facts the design depends on and explicitly label any
remaining `UNVERIFIED-ASSUMPTION`. Include failure and recovery cases, with particular attention to
foreign stores, locks, absent or NULL data and the real dispatch boundary. A capability limit
belongs beside the scope claim it limits. Do not ratify an unresolved assumption that determines
whether the design can work.

Capture the choices and their reasons with `cmos_decisions(action="record", content="<decision>")`;
link relevant evidence and mission provenance when available. For next-step planning, reuse the
task's planning session or open one with `cmos_session(action="start", type="planning", title="<topic>")`. Use
`cmos_session(action="capture", category="next-step", content="<action and completion evidence>")`
for planned next steps in the current planning session, then complete that session when planning
is finished so its next steps materialize. Do not open one solely to record a decision.

For Builder work, use `cmos_sprint(action="add")`, `cmos_mission(action="add")` and
`cmos_mission(action="depends")` with the tools' current schemas, after scope and dependencies are
settled. Each mission needs a concrete objective and criteria that distinguish done from merely
attempted. Resolve product scope, budget and irreversible tradeoffs with the operator when those
choices are still open; do not ask again about an approved plan. Report the ratified work and any
unresolved choices. Planning ends with a usable record; start building only when requested.
