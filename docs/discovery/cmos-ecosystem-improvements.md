# CMOS Ecosystem Improvements Analysis

**Mission**: s15-m02
**Date**: 2025-12-27
**Status**: Complete

## Overview

This document analyzes opportunities to improve the efficiency and agent-friendliness of the CMOS ecosystem, with focus on:

1. MCP-based project seeding
2. Process flow improvements
3. Agent workflow optimizations
4. Ecosystem consolidation path

---

## 1. MCP-Based Project Seeding

### Current State

Project initialization requires manual steps:

1. Clone/copy `cmos-seed` template
2. Run `python cmos/scripts/seed_sqlite.py` to initialize database
3. Edit `cmos/missions/backlog.yaml` with project missions
4. Run validation commands

This requires Python runtime and manual file editing.

### Proposed: MCP-Driven Seeding

#### New Tool: `cmos_project_init`

```typescript
{
  name: "cmos_project_init",
  parameters: {
    projectName: string,        // "my-awesome-project"
    projectPath: string,        // Where to create CMOS structure
    initialSprint?: {
      id: string,               // "sprint-01"
      title: string,            // "Foundation"
      focus?: string            // "Core infrastructure setup"
    },
    initialMissions?: Array<{
      id: string,               // "s01-m01"
      name: string,             // "Project Setup"
      objective?: string,
      successCriteria?: string[]
    }>,
    template?: "standard" | "research" | "design"  // Preset configurations
  }
}
```

#### Implementation

1. **Schema bundling**: Embed `schema.sql` in MCP server package
2. **Directory creation**: Create `cmos/db/`, `cmos/contexts/` structure
3. **Database initialization**: Execute schema, create metadata row
4. **Initial seeding**: Insert sprint and missions if provided
5. **Template application**: Apply domain-specific defaults

#### Benefits

- **Zero Python dependency** for project setup
- **LLM-driven initialization**: Agent can seed project during conversation
- **Template support**: Pre-configured setups for different project types
- **Idempotent**: Safe to call on existing project (validates, doesn't overwrite)

### Implementation Priority: HIGH

This eliminates the primary friction point for new CMOS projects.

---

## 2. Process Flow Improvements

### 2.1 Agent Onboarding Enhancement

**Current**: `cmos_agent_onboard` returns static payload.

**Improvement**: Add contextual awareness.

```typescript
// Enhanced onboard response
{
  project: { ... },
  currentSprint: { ... },
  pendingMissions: [...],

  // NEW: Contextual suggestions
  suggestedFirstAction: "Start current mission: s15-m02",
  blockerResolutions: [
    { missionId: "s15-m01", suggestion: "Missing API key - check .env" }
  ],

  // NEW: Recent session context
  lastSessionSummary: "Completed Sprint 14 planning",

  // NEW: Sprint health metrics
  sprintProgress: {
    completed: 4,
    total: 8,
    percentComplete: 50,
    estimatedVelocity: "on track"
  }
}
```

### 2.2 Mission Transition Automation

**Current**: Manual state transitions with separate calls.

**Improvement**: Smart transition with auto-promotion.

```typescript
// cmos_mission_complete with auto-next
{
  missionId: "s15-m02",
  notes: "Analysis complete",
  autoPromoteNext: true,      // NEW: Auto-start next queued mission
  captureDecisions: [         // NEW: Extract decisions to strategic_decisions
    "Recommend Option D for consolidation"
  ]
}
```

### 2.3 Session-Mission Linking

**Current**: Sessions and missions are loosely related via notes.

**Improvement**: Explicit linking.

```typescript
// New field in sessions table
{
  related_missions: ["s15-m02", "s15-m03"],  // Missions worked during session
  decisions_for_mission: "s15-m02"           // Mission that prompted decisions
}
```

### 2.4 Context Auto-Snapshot

**Current**: Manual snapshot calls required.

**Improvement**: Automatic snapshots at key moments.

Trigger conditions:

- Sprint completion (all missions done)
- Major blocking event recorded
- Session completion with 5+ decisions
- Mission dependency chain cleared

### 2.5 Decision Extraction Pipeline

**Current**: Decisions captured in session, manually synced.

**Improvement**: Real-time extraction.

When `cmos_session_capture` receives `category: "decision"`:

1. Parse decision text for keywords
2. Auto-tag with domain (inferred from context)
3. Link to current mission/sprint
4. Insert into `strategic_decisions` immediately

---

## 3. Agent Workflow Optimizations

### 3.1 Batch Operations

Add tools for common multi-step patterns:

```typescript
// cmos_sprint_close - Complete sprint with summary
{
  sprintId: "sprint-14",
  summary: "Achieved full CLI/MCP parity",
  promoteMissions: true,  // Move incomplete to next sprint
  snapshotContext: true   // Auto-snapshot master_context
}

// cmos_mission_batch_update - Update multiple missions
{
  missionIds: ["s15-m03", "s15-m04"],
  updates: { status: "Current" }
}
```

### 3.2 Query Shortcuts

Add tools that combine common queries:

```typescript
// cmos_work_summary - Single call for work status
// Returns: in progress, blocked, recent completions, next up

// cmos_decision_timeline - Decisions by date range with mission context
```

### 3.3 Validation Helpers

```typescript
// cmos_validate_mission_spec - Check mission before starting
{
  missionId: 's15-m02';
}
// Returns: { valid: true, warnings: ["No deliverables defined"] }

// cmos_validate_sprint_ready - Check sprint can begin
{
  sprintId: 'sprint-15';
}
// Returns: { ready: true, blockedMissions: 0, missingDependencies: [] }
```

---

## 4. Ecosystem Consolidation Path

See `cmos-consolidation-feasibility.md` for full analysis.

**Summary**: Recommend MCP-primary architecture with thin CLI shim.

### Quick Wins (No Consolidation Required)

These improvements work in either system:

1. **Add `cmos_project_init`** - MCP-based seeding
2. **Enhance `cmos_agent_onboard`** - Richer context
3. **Add batch operations** - Sprint close, bulk updates
4. **Auto-snapshot triggers** - Reduce manual snapshots

### Consolidation Prerequisites

Before full consolidation:

1. Add `cmos_session_search` to MCP
2. Add `cmos_backlog_export` to MCP
3. Test parity between systems
4. Document migration path

---

## 5. Prioritized Improvement Roadmap

### Tier 1: High Impact, Low Effort (Sprint 16)

| Improvement              | Effort | Impact | Description                                    |
| ------------------------ | ------ | ------ | ---------------------------------------------- |
| `cmos_project_init`      | 2 days | HIGH   | MCP-based seeding eliminates Python dependency |
| Enhanced onboard         | 1 day  | MEDIUM | Richer agent cold-start context                |
| Auto decision extraction | 1 day  | MEDIUM | Real-time decision → strategic_decisions       |

### Tier 2: High Impact, Medium Effort (Sprint 17)

| Improvement           | Effort | Impact | Description                    |
| --------------------- | ------ | ------ | ------------------------------ |
| `cmos_sprint_close`   | 2 days | HIGH   | Batch sprint completion        |
| `cmos_session_search` | 1 day  | MEDIUM | Enable consolidation           |
| CLI shim prototype    | 3 days | MEDIUM | Test consolidation feasibility |

### Tier 3: Medium Impact, Medium Effort (Sprint 18)

| Improvement               | Effort | Impact | Description             |
| ------------------------- | ------ | ------ | ----------------------- |
| Session-mission linking   | 2 days | MEDIUM | Better traceability     |
| Auto-snapshot triggers    | 1 day  | LOW    | Reduce manual snapshots |
| `cmos_validate_*` helpers | 2 days | MEDIUM | Pre-flight checks       |

### Tier 4: Consolidation Completion (Sprint 19+)

| Improvement            | Effort | Impact | Description          |
| ---------------------- | ------ | ------ | -------------------- |
| Full CLI shim          | 3 days | MEDIUM | Replace Python CLI   |
| Research export in MCP | 2 days | LOW    | Feature parity       |
| Python deprecation     | 1 day  | LOW    | Documentation update |

---

## 6. Success Metrics

### Efficiency Metrics

- **Agent cold-start time**: Reduce from 3 tool calls to 1
- **Mission transition friction**: Reduce from 2 calls to 1
- **Project seeding time**: Reduce from 10 minutes to 30 seconds

### Quality Metrics

- **Decision capture rate**: Track % of decisions in strategic_decisions
- **Context staleness**: Average age of last snapshot
- **Mission completion flow**: % using auto-promote

### Consolidation Metrics

- **CLI usage migration**: Track Python vs Node CLI usage
- **Feature parity**: % of CLI commands available in MCP
- **Maintenance overhead**: Lines of code per capability

---

## 7. Implementation Notes

### Schema Changes Required

```sql
-- Add session-mission linking
ALTER TABLE sessions ADD COLUMN related_missions TEXT;  -- JSON array

-- Add auto-snapshot triggers metadata
ALTER TABLE metadata ADD COLUMN last_auto_snapshot TEXT;
ALTER TABLE metadata ADD COLUMN snapshot_policy TEXT;  -- JSON config

-- Add mission validation cache
CREATE TABLE IF NOT EXISTS mission_validations (
  mission_id TEXT PRIMARY KEY,
  validated_at TEXT,
  warnings TEXT,  -- JSON array
  valid INTEGER
);
```

### Configuration Options

```typescript
// CMOS configuration (optional, via metadata table or env)
{
  autoSnapshotOnSprintComplete: true,
  autoPromoteNextMission: false,  // Require explicit start
  decisionExtractionEnabled: true,
  sessionStaleThresholdHours: 24
}
```

---

## Conclusion

The CMOS ecosystem is mature but has optimization opportunities:

1. **Highest priority**: MCP-based project seeding to eliminate Python dependency
2. **Quick wins**: Enhanced onboarding, auto-decision extraction
3. **Long-term**: Consolidation to single TypeScript codebase

The recommended path maintains human UX via CLI shim while unifying on MCP as the canonical implementation. This reduces maintenance burden while preserving workflow flexibility.
