# CMOS Consolidation Feasibility Assessment

**Mission**: s15-m02
**Date**: 2025-12-27
**Status**: Complete

## Executive Summary

The CMOS ecosystem consists of two systems with **88% functional overlap**:

- **TypeScript MCP Server** (25 tools) - LLM-focused
- **Python CLI** (28 commands) - Human-focused

Both share the same SQLite database with zero code dependencies. Full consolidation is **technically feasible** but has trade-offs. The recommended approach is **MCP-primary with thin CLI shim**.

---

## Current State Analysis

### Overlap Matrix

| Category        | TypeScript MCP | Python CLI | Overlap |
| --------------- | -------------- | ---------- | ------- |
| Mission CRUD    | 9 tools        | 8 commands | 100%    |
| Sprint CRUD     | 4 tools        | 4 commands | 100%    |
| Session CRUD    | 5 tools        | 7 commands | 85%     |
| Context ops     | 3 tools        | 4 commands | 100%    |
| Decision ops    | 2 tools        | 3 commands | 100%    |
| Database ops    | 1 tool         | 3 commands | 50%     |
| Agent utilities | 1 tool         | 0 commands | 0%      |

### Unique Capabilities

**MCP-only (3 features):**

1. `cmos_mission_unblock` - Transition from Blocked state
2. `cmos_agent_onboard` - Optimized agent cold-start payload
3. Auto-detection framework with environment variable support

**CLI-only (6 features):**

1. Session search (keyword search in captures)
2. Research export (Markdown generation)
3. Backlog YAML import/export
4. Foundational docs validation
5. Rich terminal formatting (colors, tables)
6. Historical context views (as-of timestamp)

---

## Consolidation Options

### Option A: Eliminate Python CLI (MCP-Only)

**Implementation:**

1. Add missing MCP tools: `cmos_session_search`, `cmos_research_export`, `cmos_backlog_export`
2. Create thin Node.js CLI wrapper (`npx cmos`) that calls MCP tools
3. Format MCP responses for terminal display

**Pros:**

- Single TypeScript codebase
- Type safety throughout
- Consistent error handling
- Easier testing (Zod schemas)

**Cons:**

- Node.js runtime required for CLI
- Terminal UX may degrade without rich formatting
- Migration effort for existing CLI users
- Research export would lose Markdown generation quality

**Effort:** Medium (4-6 weeks)
**Risk:** Medium (UX regression for terminal users)

### Option B: Eliminate TypeScript MCP (Python-Only)

**Implementation:**

1. Create FastMCP wrapper around Python CLI
2. Expose all CLI commands as MCP tools
3. Add agent onboard and unblock capabilities

**Pros:**

- Single Python codebase
- Python is common in research/data workflows
- No TypeScript build complexity

**Cons:**

- Lose TypeScript type safety
- MCP via FastMCP adds latency vs native
- Agent onboard optimization harder without TS
- Would need to rebuild MCP tool definitions

**Effort:** High (6-8 weeks)
**Risk:** High (performance regression, type safety loss)

### Option C: Keep Both Systems (Status Quo)

**Implementation:**

- Continue parallel development
- Accept feature duplication
- Document which system for which use case

**Pros:**

- Both systems work today
- No migration risk
- Each optimized for its users

**Cons:**

- Double maintenance burden
- Potential for drift/inconsistency
- Duplicated test coverage
- Confusing for new users

**Effort:** None (ongoing maintenance cost)
**Risk:** Low (but accumulating technical debt)

### Option D: MCP Primary + Thin CLI Shim (Recommended)

**Implementation:**

1. Declare TypeScript MCP as canonical implementation
2. Add missing MCP tools (session search, research export)
3. Create CLI shim that formats MCP responses for terminal
4. Deprecate Python CLI over 6-month timeline

**Pros:**

- Single source of truth
- Human UX preserved via shim
- Type safety maintained
- Gradual migration path

**Cons:**

- CLI shim requires Node.js
- Temporary parallel maintenance
- Some CLI formatting may be simpler

**Effort:** Medium (4-5 weeks)
**Risk:** Low (gradual transition)

---

## Feasibility Assessment

### Technical Feasibility: HIGH

Both systems use identical database schema and lifecycle semantics. The TypeScript MCP already covers all core operations. Missing capabilities (session search, research export) are straightforward to implement.

### Operational Feasibility: MEDIUM

Current CLI users would need to migrate to either:

- Node.js-based CLI shim, or
- Direct MCP tool invocation via Claude

This requires documentation and potentially training.

### Economic Feasibility: HIGH

Consolidation reduces maintenance from 2 codebases to 1. Estimated savings:

- 40% reduction in feature development time
- 50% reduction in bug fix duplication
- Single test suite instead of two

---

## Recommendation

**Pursue Option D: MCP Primary + Thin CLI Shim**

### Phase 1 (Sprint 16)

1. Add `cmos_session_search` MCP tool
2. Add `cmos_backlog_export` MCP tool
3. Document MCP as canonical

### Phase 2 (Sprint 17)

1. Create `npx cmos` CLI shim with terminal formatting
2. Test parity with Python CLI
3. Document migration path

### Phase 3 (Sprint 18)

1. Add `cmos_research_export` MCP tool
2. Deprecate Python CLI (mark as legacy)
3. Update agents.md to reference MCP-only

### Phase 4 (Sprint 19+)

1. Archive Python CLI code
2. Remove from documentation
3. Single codebase achieved

---

## Decision Points

Before proceeding with consolidation, confirm:

1. **Node.js CLI acceptable?** - Human operators must have Node.js for CLI access
2. **Rich formatting priority?** - How important are colored tables vs structured JSON?
3. **Python ecosystem dependencies?** - Any other systems depend on Python CLI?

---

## Appendix: Capability Mapping

### Missing MCP Tools to Add

```typescript
// cmos_session_search - Search session history by keyword
{
  query: string,      // Search term
  category?: string,  // Filter by capture category
  limit?: number      // Max results (default 20)
}

// cmos_backlog_export - Export missions to YAML
{
  sprintId?: string,  // Filter to specific sprint
  format?: 'yaml' | 'json'
}

// cmos_research_export - Generate research report
{
  missionId: string,
  format?: 'markdown' | 'json'
}
```

### CLI Shim Architecture

```
[User] → [npx cmos] → [MCP Tool Call] → [SQLite]
                ↓
         [Format Response]
                ↓
         [Terminal Output]
```

The CLI shim would:

1. Parse command-line arguments
2. Map to MCP tool invocation
3. Execute tool via direct function call (no server needed)
4. Format result with colors and tables
5. Output to terminal
