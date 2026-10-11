---
name: catch-up
description: Explain what is happening in a project's CMOS record in plain conversation. Use for a project catch-up, recent decisions, open work, and unresolved questions; this does not start development work.
---

Use the user's chosen project address as `projectRoot`, or omit it to use this chat's project.
Call `cmos_review()` and name the project from its receipt. If the project is unclear, use
`cmos_project(action="list")` and ask the user to choose an exact returned address. Do not borrow
another project's record after a refusal.

Explain the current direction, recent decisions, open work and questions that need attention.
Distinguish recorded facts from your interpretation. Refer to the returned record ids when
describing a decision or an unresolved item; fetch a specific record only when its detail changes
the answer. Keep the explanation proportionate to the user's question.

This workflow reads the record. Offer possible next actions without recording or completing them.
If the tools are unavailable or still installing, report that state; after installation, a new
session may be needed before the real tools appear. Summarize any refusal and its available
in-chat remedy in plain words rather than inventing a result.
