# Build Session Prompt

**Purpose**: Efficient prompt for running multiple build missions in a session loop.

**Usage**: Paste at the start of a build session to establish context.

---

## Session Initialization Prompt

```
We're running a CMOS build session. If anything is unclear, pause and ask before proceeding.

CMOS uses MCP tools for database operations. Start by getting context:

1. ONBOARD: Call cmos_agent_onboard() to get project state
   - Verify project identity (project_id, project_name)
   - Check you're working on the correct project database
2. HEALTH CHECK: Call cmos_db_health() to verify database
3. LOAD RULES: Read cmos/tiers/build.md for project rules

Then run missions in a loop:

1. SELECT NEXT: Call cmos_mission_status() to see work queue
   - Priority: In Progress → Current → Queued

2. START: Call cmos_mission_start(missionId="<id>")
   - Logs start event to database
   - Transitions to In Progress

3. EXECUTE: Actually implement the work
   - Write real code, not stubs
   - Create comprehensive tests
   - Verify all success criteria met
   - CRITICAL: Don't mark complete unless work is actually done

4. COMPLETE: Call cmos_mission_complete(missionId="<id>", notes="<what was done>")
   - Marks completed in database
   - Logs completion event

5. VERIFY: Call cmos_mission_status() to confirm state

If blocked: Call cmos_mission_block(missionId="<id>", reason="<why>", blockers=["<what's needed>"])

Loop until all missions complete or you need to pause.
```

---

## Minimal Loop Prompt

```
CMOS build loop:

1. Status: cmos_mission_status()
2. Start: cmos_mission_start(missionId="...")
3. Execute: Implement fully, test thoroughly
4. Complete: cmos_mission_complete(missionId="...", notes="...")
5. Repeat
```

---

## Key Principles

**Database First**:

- SQLite is source of truth
- All state managed via MCP tools
- No file mirrors to maintain

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

Agent: Loaded. Running cmos_agent_onboard()... Found next mission: s16-m01

You: Go ahead

Agent: [Starts, implements, tests, completes, validates]
       Next mission: s16-m02. Ready to start?

You: Yes

Agent: [Starts, implements, tests, completes, validates]
       Next mission: s16-m03. Ready?

You: Pause there, let's review
```

---

## Project Identity Validation

The onboard response includes project identity:

- `project.id` - Unique project identifier
- `project.name` - Human-readable project name
- `project.tracelabProjectId` - Linked TraceLab project (if any)

**Verify you're working on the correct project** before executing missions. If the project identity doesn't match your expectations, you may have the wrong database.

---

**Last Updated**: 2025-12-29
**For**: Build session mission loops
