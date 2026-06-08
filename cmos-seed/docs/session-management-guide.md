# Session Management Guide

Sessions capture planning, onboarding, research, and review activities that fall outside mission-oriented build work.

---

## Session Types

| Type       | Use Case                                         |
| ---------- | ------------------------------------------------ |
| onboarding | Ramp up a new agent or hand off a feature        |
| planning   | Sprint, roadmap, or architecture planning        |
| review     | Weekly reviews, retrospectives, evaluations      |
| research   | Exploratory spikes, benchmarking, investigations |
| check-in   | Quick syncs to capture status and blockers       |
| custom     | Any structured collaboration needing a record    |

All types share the same lifecycle: **start → capture → complete**.

---

## Basic Workflow

### 1. Start a Session

```
cmos_session_start({
  type: "planning",
  title: "Sprint 17 Planning",
  sprintId: "sprint-17"  // optional
})
```

### 2. Capture Insights (repeat as needed)

```
cmos_session_capture({
  category: "decision",
  content: "Focus on API performance"
})

cmos_session_capture({
  category: "constraint",
  content: "Must maintain backward compatibility"
})

cmos_session_capture({
  category: "next-step",
  content: "Profile current latency"
})
```

**Categories**: `decision`, `learning`, `constraint`, `context`, `next-step`

### 3. Complete the Session

```
cmos_session_complete({
  summary: "Sprint 17 scoped and prioritized",
  nextSteps: ["Finalize API metrics", "Update backlog"]
})
```

---

## Worked Examples

### Sprint Planning

```
cmos_session_start(type="planning", title="Sprint 17 Planning")

cmos_session_capture(category="decision", content="Focus on API performance")
cmos_session_capture(category="constraint", content="Backward compatibility required")
cmos_session_capture(category="next-step", content="Profile API endpoints")

cmos_session_complete(summary="Sprint 17 planned: 6 missions for API optimization")
```

### Agent Onboarding

```
cmos_session_start(type="onboarding", title="Onboarding for Feature X")

cmos_session_capture(category="context", content="Feature X requires real-time updates")
cmos_session_capture(category="decision", content="Use WebSockets for real-time")

cmos_session_complete(
  summary="Onboarded to Feature X implementation",
  nextSteps=["Review WebSocket libraries", "Design message protocol"]
)
```

### Weekly Review

```
cmos_session_start(type="review", title="Week 47 Review")

cmos_session_capture(category="learning", content="CI/CD pipeline needs optimization")
cmos_session_capture(category="learning", content="Velocity improved with pair programming")

cmos_session_complete(summary="Week 47: Good progress, CI/CD needs work")
```

---

## Viewing Sessions

```
cmos_session_list()                    // List all sessions
cmos_session_list(status="completed")  // Filter by status
cmos_session_list(type="planning")     // Filter by type
```

---

## Tips

- Keep captures concise (<1000 chars)
- Use next-steps to seed future missions
- Complete sessions before starting new ones
- Use `cmos_agent_onboard()` to see active sessions

---

## Keeping Context Fresh

After completing sessions, decisions and learnings are stored in the database. To aggregate recent session captures into `master_context` for strategic memory:

```
cmos_context_update()
```

This tool:

- Scans completed sessions since last context update
- Extracts decisions, learnings, and constraints
- Updates master_context with aggregated insights
- Creates automatic snapshot for history

**When to use**:

- After completing multiple planning sessions
- At sprint boundaries
- Before onboarding a new agent
- When master_context feels stale

**Workflow Example**:

```
# Complete several planning sessions
cmos_session_complete(summary="Sprint planning complete")

# Later, aggregate insights into master_context
cmos_context_update()

# View updated context
cmos_context_view(contextType="master_context")
```

---

**Last Updated**: 2025-12-29
