# Build Session Prompt

**Purpose**: Efficient prompt for running multiple build missions in a session loop.

**Usage**: Paste at the start of a build session to establish context.

---

## Session Initialization Prompt

```
We're running a CMOS build session. If anything is unclear, pause and ask before proceeding.

CMOS uses MCP tools for database operations. Open the session with the bundled review tool:

1. REVIEW: Call cmos_review() to get a ≤4KB project digest
   - Returns project identity, current sprint, project-scoped work queue,
     recent decisions, freshness, and top-3 next_actions
   - Replaces the older onboard + context view + mission status opener
2. LOAD RULES: Read agents.md for repository rules

Then run missions in a loop:

1. SELECT NEXT: Call cmos_mission(action="status") to see work queue
   - Priority: In Progress → Current → Queued
   - Pass includeBlocked=true to surface blocked work

2. START: Call cmos_mission_transition(action="start", missionId="<id>")
   - Logs start event to database
   - Transitions to In Progress
   - Surfaces relevant past decisions via FTS5

3. EXECUTE: Actually implement the work
   - Write real code, not stubs
   - Create comprehensive tests
   - Verify all success criteria met
   - CRITICAL: Don't mark complete unless work is actually done

4. COMPLETE: Call cmos_mission_transition(action="complete", missionId="<id>", notes="<what was done>")
   - Marks completed in database
   - Logs completion event
   - Optionally pass decisions=["..."] and agentFeedback="..." when the host preserves structured arguments

5. VERIFY: Call cmos_mission(action="status") to confirm state

If blocked: Call cmos_mission_transition(action="block", missionId="<id>", reason="<why>", blockers=["<what's needed>"])

Loop until all missions complete or you need to pause.
```

---

## Minimal Loop Prompt

```
CMOS build loop:

1. Review: cmos_review()
2. Status: cmos_mission(action="status", includeBlocked=true)
3. Start: cmos_mission_transition(action="start", missionId="...")
4. Execute: Implement fully, test thoroughly
5. Complete: cmos_mission_transition(action="complete", missionId="...", notes="...")
6. Repeat
```

---

## Key Principles

**Database First**:

- SQLite is source of truth
- Database-backed operational state is managed via MCP tools
- Registered foundational documents remain durable files; generated exports are views

**Validation Checkpoints**:

- After each mission completion
- Before ending session
- If anything seems wrong

**Mission Loop Efficiency**:

- Don't re-explain system between missions
- Trust tools to handle transitions
- Focus on execution and validation

---

## Common Session Patterns

### Pattern 1: Sequential Execution

Run missions one by one until backlog clears.

### Pattern 2: Batch Similar Missions

Group related missions and run together.

### Pattern 3: Stop on Blocker

If mission blocks, document needs, end session.

---

## Example Session Flow

```
You: [Paste Session Initialization Prompt]

Agent: Loaded. Running cmos_review()... Found next mission: s16-m01

Agent: [Starts, implements, tests, completes, validates; continues through the queue]
       Next mission: s16-m03.

You: Pause there, let's review
```

---

## Project Identity Validation

The review response includes project identity:

- `project.name` - Human-readable project name
- `project.cmos_address` - Canonical CMOS address when configured
- `localProjectId` - Identifier recorded by the local store

**Verify you're working on the correct project** before executing missions. If the project identity doesn't match your expectations, you may have the wrong database.

---

**Last Updated**: 2026-08-28
**For**: Build session mission loops
