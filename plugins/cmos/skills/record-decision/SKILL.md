---
name: record-decision
description: Record a meaningful project choice in CMOS with its reasons and evidence, or propose an unresolved choice for the operator. Use when someone will later need to know why a choice was made.
---

# CMOS record-decision

Open with one sentence stating the decision. Apply the “someone will later ask why” test:
architecture, scope and tradeoffs belong in the record; routine edits and a narration of actions
usually do not. Read the relevant existing decisions with `cmos_decisions(action="search")` or
`cmos_decisions(action="show")` before adding a duplicate or correction.

Use a compact MADR-style record, scaled to the choice:

- **Context:** the problem and constraints that made a choice necessary.
- **Decision:** the chosen approach and why it fits.
- **Alternatives:** serious options considered and why they were rejected.
- **Consequences:** benefits, costs and accepted limitations.
- **Evidence:** actual code, tests, measurements or research references supporting the choice.

Record an explicit user decision, a requested decision capture, or an implementation choice
within already authorized work directly. Do not add another approval ritual.

**Choices that wait for the operator** are those that change product scope, commit a budget or
cost, create an outside commitment, settle an operator preference, add a constraint or standing
rule, or change the operator profile. Put one to the operator by ending your reply with one line,
up to three such lines per reply:

    Would record: <the decision and its reason, in one sentence>
    Would record (constraint): <the constraint>
    Would record (rule): <the standing rule>
    Would record (profile): <one line for the operator profile>

Use the label at the start of a trailing line, outside code blocks; `Would record (decision):`
also names a decision. Leading list or quote markers and Markdown wrappers are accepted. A label
may also start the final sentence of the reply's final line, after `.`, `?` or `!` and whitespace;
an inline label after a colon or the abbreviations `e.g.`, `i.e.`, `etc.`, `vs.` or `cf.` does not
count. A placeholder or "nothing" is not a proposal. The text needs at least three words and 15
characters; text over 1,000 characters is cut at a word. Where CMOS hooks run, the line becomes a
draft with an id (`P<n>`) and the operator's next message is bound to it. The line is a proposal,
not a claim that a hook saved or approved it. Continue independent authorized work while the choice
is open.

**Published reply grammar** ([source](../../../../src/tools/cmos/draft-grammar.ts)): a plain reply
is at most 60 normalized characters and consists entirely of phrases below, joined by whitespace,
commas, periods, semicolons, exclamation marks, ellipses or dashes, with optional courtesies.
Matching ignores case, normalizes curly apostrophes, removes double quotes and collapses
whitespace. A question mark makes it a question; extra words, or a mixture of approval and decline
phrases, make it other. Courtesies alone do not approve or decline.

- Approval phrases: `approved`, `approve`, `approve it`, `yes`, `yep`, `yeah`, `y`, `ok`, `okay`,
  `sure`, `proceed`, `go ahead`, `go for it`, `do it`, `record it`, `yes record it`, `that's good`,
  `thats good`, `that is good`, `sounds good`, `looks good`, `lgtm`, `agreed`, `agree`, `i agree`,
  `confirmed`, `confirm`, `correct`.
- Decline phrases: `no`, `nope`, `nah`, `don't`, `do not`, `don't record that`, `do not record that`,
  `don't record it`, `do not record it`, `skip it`, `skip that`, `skip`, `decline`, `declined`,
  `reject`, `rejected`, `drop it`, `not that`, `no thanks`, `no thank you`, `leave it`, `never mind`,
  `nevermind`.
- Courtesies: `please`, `thanks`, `thank you`, `thx`, `ty`.

**When the operator answers:**

- A plain approval: record it now with
  `cmos_decisions(action="record", content="<the draft's text as drafted>", fromDraft="P<n>")`.
  Content about something else is refused. Constraint, rule and profile drafts are written as
  drafted; different content passed to the call is not used and produces a warning, except for
  whitespace changes.
- Nuance or call-outs approving a decision: fold them in; ask first when the nuance is unclear or
  conflicts with an existing record. For a constraint, rule or profile line, propose the revised
  text again and wait for a plain approval; these kinds refuse nuance and questions.
- A question or an amendment: answer, and end with the line again, revised if the answer changes it.
  The revised line replaces the draft.
- A plain decline ("no", "don't record that", "skip it"…): do not record it.
- No answer: never record it. A draft expires unanswered after 7 days or 3 session starts.
- A pending draft from an earlier session: name it to the operator in a prose line as `draft P<n>`
  or `proposal P<n>`, with its subject. A bare id, or an id in code, a link target, a URL or a file
  path, does not show the draft for approval. This instruction's backticks mark examples; the
  actual naming must be prose outside inline code.

The record says how the approval was known: `approved` requires a plain approval of that draft
alone in this session and, for a decision, content that stays within the draft's wording check.
That check requires the same text after trimming and collapsing whitespace; case, word order and
punctuation remain significant. `agent-judged` means the operator's words were nuance, covered
several drafts, or the decision changed any wording beyond whitespace; the words are attached.
`agent-attested` is available only for decisions from a server without a harness session.
A linked server refuses a draft when no words younger than two hours
exist for this draft in this conversation, including when words exist only in another session.
Constraint, rule and profile drafts require a plain approval and never record as agent-attested.
Without a draft id, record the operator's approved choice directly.

Write with `cmos_decisions(action="record", content="<decision and supporting context>")`.
Add `missionId` when the choice belongs to a mission, and use structured `evidence` only for real
TraceLab references supported by the tool. Put ordinary source paths and URLs in the content.
To correct a decision, record the replacement with `supersedes=[<old decision id>]`; preserve the
old record instead of editing its historical meaning. A decision needs no session opened merely
to file it. Verify `decisionId` and `materialization`, and inspect any `writeFailures`; report a
failed capture rather than implying it persisted. This skill does not authorize messaging another
project or changing global operator preferences.
