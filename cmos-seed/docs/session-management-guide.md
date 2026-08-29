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
cmos_session({
  action: "start",
  type: "planning",
  title: "Sprint 17 Planning",
  sprintId: "sprint-17"  // optional
})
```

### 2. Capture Insights (repeat as needed)

```
cmos_session({
  action: "capture",
  category: "decision",
  content: "Focus on API performance"
})

cmos_session({
  action: "capture",
  category: "constraint",
  content: "Must maintain backward compatibility"
})

cmos_session({
  action: "capture",
  category: "next-step",
  content: "Profile current latency"
})
```

**Categories**: `decision`, `learning`, `constraint`, `context`, `next-step`

### 3. Complete the Session

```
cmos_session({
  action: "complete",
  summary: "Sprint 17 scoped and prioritized",
  nextSteps: ["Finalize API metrics", "Update backlog"]
})
```

---

## Worked Examples

### Sprint Planning

```
cmos_session(action="start", type="planning", title="Sprint 17 Planning")

cmos_session(action="capture", category="decision", content="Focus on API performance")
cmos_session(action="capture", category="constraint", content="Backward compatibility required")
cmos_session(action="capture", category="next-step", content="Profile API endpoints")

cmos_session(action="complete", summary="Sprint 17 planned: 6 missions for API optimization")
```

### Agent Onboarding

```
cmos_session(action="start", type="onboarding", title="Onboarding for Feature X")

cmos_session(action="capture", category="context", content="Feature X requires real-time updates")
cmos_session(action="capture", category="decision", content="Use WebSockets for real-time")

cmos_session(action="complete",
  summary="Onboarded to Feature X implementation",
  nextSteps=["Review WebSocket libraries", "Design message protocol"]
)
```

### Weekly Review

```
cmos_session(action="start", type="review", title="Week 47 Review")

cmos_session(action="capture", category="learning", content="CI/CD pipeline needs optimization")
cmos_session(action="capture", category="learning", content="Velocity improved with pair programming")

cmos_session(action="complete", summary="Week 47: Good progress, CI/CD needs work")
```

---

## Viewing Sessions

```
cmos_session(action="list")                    // List all sessions
cmos_session(action="list", status="completed")  // Filter by status
cmos_session(action="list", type="planning")     // Filter by type
```

---

## Tips

- Keep captures concise (<1000 chars)
- Use next-steps to seed future missions
- Complete sessions before starting new ones
- Use `cmos_agent_onboard()` to see active sessions

---

## Keeping Context Fresh

Session completion already persists structured decisions and learnings, routes constraint/context/
next-step captures, updates the working contexts, and snapshots them. Use aggregate update only as
a recovery/backfill path for constraint captures that were not incorporated into `master_context`:

```
cmos_context(action="update", since="<ISO timestamp>")
```

This tool:

- Scans constraint captures, optionally bounded by `since`
- Adds previously unaggregated constraints to `master_context`
- Creates a snapshot only when it changes `master_context`

Decisions and learnings are table-backed when captured; this action does not re-aggregate them.
Normal completed sessions need no follow-up update call.

**Recovery example**:

```
# Backfill constraint captures from a known point
cmos_context(action="update", since="2026-08-01T00:00:00Z")

# View updated context
cmos_context(action="view", contextType="master_context")
```

---

**Last Updated**: 2026-08-28
