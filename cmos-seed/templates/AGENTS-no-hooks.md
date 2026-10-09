<!-- CMOS hook-less block: written by `cmos-mcp init --no-hooks` for a harness without hooks. Delete it if the harness gains them. -->

## CMOS in a harness without hooks

This harness runs no CMOS hooks, so these steps do their work:

1. At the start of a conversation, call `cmos_review()` and read the digest it returns.
2. When you settle a choice someone will later ask about, record it:
   `cmos_decisions(action="record", content="...")`.
3. Save a lesson or an open thread as you go:
   `cmos_session(action="capture", category="learning", content="...")`, or `category="next-step"`.
4. Before you stop, capture anything unfinished as a next step.

<!-- /CMOS hook-less block -->
