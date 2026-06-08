# CMOS-MCP Tool Catalog

**Document Purpose**: Complete catalog of all MCP tools with descriptions, parameters, and return types.

**Last Updated**: 2025-12-27

**Total Tools**: 30

---

## Tool Categories

| Category                 | Count | Description                       |
| ------------------------ | ----- | --------------------------------- |
| Mission Protocol         | 4     | Domain packs and mission creation |
| CMOS Database Reads      | 4     | Query operations                  |
| CMOS Lifecycle Mutations | 5     | State changes                     |
| CMOS Context Operations  | 3     | Context management                |
| CMOS Session Management  | 4     | Session operations                |
| CMOS Sprint Management   | 4     | Sprint CRUD                       |
| CMOS Mission Creation    | 2     | Add missions and dependencies     |
| CMOS Agent Utilities     | 3     | Onboarding and decisions          |
| CMOS Administrative      | 1     | Database health                   |

---

## Mission Protocol Tools

### 1. `get_available_domains`

Lists available domain packs from the registry.

**Parameters:** None

**Returns:**

```typescript
{
  domains: Array<{
    name: string;
    description: string;
    version: string;
  }>;
}
```

---

### 2. `create_mission`

Creates a new mission from objective and optional domain pack.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `objective` | string | Yes | Clear, concise mission goal |
| `domain` | string | No | Domain pack name |
| `successCriteria` | string[] | No | Measurable success conditions |
| `constraints` | string[] | No | Limitations or boundaries |
| `outputFormat` | "yaml" \| "json" | No | Output format (default: yaml) |
| `missionId` | string | No | Suggested mission ID |
| `sprintId` | string | No | Sprint ID for JSON output |
| `context` | string | No | Context description |

**Returns:** Formatted mission (YAML or JSON string)

---

### 3. `get_mission_quality_score`

Assesses mission quality using three-dimensional framework.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionFile` | string | Yes | Path to mission YAML file |
| `verbose` | boolean | No | Include detailed metrics |

**Returns:**

```typescript
{
  clarity: number;      // 0-100
  completeness: number; // 0-100
  aiReadiness: number;  // 0-100
  overall: number;      // Weighted average
  suggestions?: string[];
}
```

---

### 4. `create_mission_splits`

Splits complex missions into smaller sub-missions.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionFile` | string | Yes | Path to mission YAML |
| `maxSubMissions` | number | No | Max sub-missions (default: 10) |
| `model` | "claude" \| "gpt" \| "gemini" | No | Target model (default: claude) |
| `outputDir` | string | No | Output directory |
| `preserveStructure` | boolean | No | Preserve structure (default: true) |

**Returns:** Array of sub-mission files

---

## CMOS Tools - Database Reads

### 5. `cmos_mission_list`

Lists missions with optional filtering.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | MissionStatus | No | Filter by status |
| `sprintId` | string | No | Filter by sprint |
| `limit` | number | No | Max results (default: 20, max: 100) |
| `projectRoot` | string | No | Project root directory |

**Returns:**

```typescript
{
  missions: Array<{
    id: string;
    name: string;
    status: MissionStatus;
    sprintId: string | null;
    objective: string | null;
  }>;
}
```

---

### 6. `cmos_mission_show`

Gets full details of a specific mission.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionId` | string | Yes | Mission ID (e.g., "s12-m06") |
| `projectRoot` | string | No | Project root directory |

**Returns:**

```typescript
{
  id: string;
  name: string;
  status: MissionStatus;
  objective: string | null;
  context: string | null;
  successCriteria: string[] | null;
  deliverables: string[] | null;
  referenceDocs: string[] | null;
  domainFields: object | null;
  notes: string | null;
  completedAt: string | null;
  sprint: { id: string; title: string; focus: string | null; status: string | null; }
}
```

---

### 7. `cmos_mission_status`

Shows active work queue with priority ordering.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeBlocked` | boolean | No | Include blocked missions (default: false) |
| `queuedLimit` | number | No | Max queued to show (default: 5) |
| `projectRoot` | string | No | Project root directory |

**Returns:**

```typescript
{
  inProgress: StatusMissionItem[];
  current: StatusMissionItem[];
  queued: StatusMissionItem[];
  blocked?: StatusMissionItem[];
  summary: {
    activeCount: number;
    queuedCount: number;
    blockedCount: number | null;
    nextAction: string;
  }
}
```

---

### 8. `cmos_session_list`

Lists sessions with optional filtering.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | "active" \| "completed" \| "canceled" | No | Filter by status |
| `type` | SessionType | No | Filter by type |
| `sprintId` | string | No | Filter by sprint |
| `page` | number | No | Page number (default: 1) |
| `pageSize` | number | No | Results per page (default: 20) |
| `projectRoot` | string | No | Project root directory |

**Session Types:** `onboarding`, `planning`, `review`, `research`, `check-in`, `custom`

---

## CMOS Tools - Lifecycle Mutations

### 9. `cmos_mission_start`

Transitions mission to In Progress.

**Valid From:** Queued, Current

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionId` | string | Yes | Mission ID to start |
| `notes` | string | No | Notes about starting |
| `projectRoot` | string | No | Project root directory |

**Returns:**

```typescript
{
  missionId: string;
  previousStatus: MissionStatus;
  currentStatus: 'In Progress';
  message: string;
  startedAt: string;
}
```

---

### 10. `cmos_mission_complete`

Transitions mission to Completed.

**Valid From:** In Progress

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionId` | string | Yes | Mission ID to complete |
| `notes` | string | No | Outcome summary |
| `projectRoot` | string | No | Project root directory |

---

### 11. `cmos_mission_block`

Transitions mission to Blocked.

**Valid From:** Current, In Progress

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionId` | string | Yes | Mission ID to block |
| `reason` | string | Yes | Why blocked |
| `blockers` | string[] | No | Items needed to unblock |
| `projectRoot` | string | No | Project root directory |

---

### 12. `cmos_mission_unblock`

Transitions mission from Blocked.

**Valid From:** Blocked only

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionId` | string | Yes | Mission ID to unblock |
| `resolution` | string | No | How blocker was resolved |
| `targetStatus` | "In Progress" \| "Current" | No | Target status (default: In Progress) |
| `projectRoot` | string | No | Project root directory |

---

### 13. `cmos_mission_update`

Updates specific mission fields.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionId` | string | Yes | Mission ID to update |
| `fields` | MissionUpdateFields | Yes | Fields to update |
| `projectRoot` | string | No | Project root directory |

**MissionUpdateFields:**

- `name`, `objective`, `context`, `notes` (string)
- `status` (MissionStatus - validates transitions)
- `successCriteria`, `deliverables`, `referenceDocs` (string[])
- `domainFields`, `metadata` (object)

---

## CMOS Tools - Context Operations

### 14. `cmos_context_view`

Renders aggregated context from database.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `contextType` | "master_context" \| "project_context" | No | Filter to type |
| `projectRoot` | string | No | Project root directory |

**Returns:** Merged context object with project history, decisions, constraints

---

### 15. `cmos_context_snapshot`

Takes strategic snapshot of context.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `contextType` | "master_context" \| "project_context" | Yes | Which context |
| `source` | string | Yes | Why snapshot taken (1-500 chars) |
| `sessionId` | string | No | Associate with session |
| `projectRoot` | string | No | Project root directory |

---

### 16. `cmos_context_history`

Views context snapshot timeline.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `contextType` | ContextType | No | Filter by type |
| `sessionId` | string | No | Filter by session |
| `since` | string | No | ISO date filter (after) |
| `until` | string | No | ISO date filter (before) |
| `page` | number | No | Page number |
| `pageSize` | number | No | Results per page |
| `projectRoot` | string | No | Project root directory |

---

## CMOS Tools - Session Management

### 17. `cmos_session_start`

Starts a new session (only one active at a time).

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | SessionType | Yes | Session type |
| `title` | string | Yes | Session title (1-255 chars) |
| `sprintId` | string | No | Associate with sprint |
| `agent` | string | No | Agent name (default: "assistant") |
| `projectRoot` | string | No | Project root directory |

---

### 18. `cmos_session_capture`

Captures insight during active session.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | CaptureCategory | Yes | Category type |
| `content` | string | Yes | Insight content (1-1000 chars) |
| `context` | string | No | Additional context (max 500 chars) |
| `sessionId` | string | No | Session ID (uses active if not provided) |
| `agent` | string | No | Agent name |
| `projectRoot` | string | No | Project root directory |

**Capture Categories:** `decision`, `learning`, `constraint`, `context`, `next-step`

---

### 19. `cmos_session_complete`

Completes active session with summary.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `summary` | string | Yes | What was accomplished (1-2000 chars) |
| `nextSteps` | string[] | No | Action items |
| `sessionId` | string | No | Session ID (uses active if not provided) |
| `agent` | string | No | Agent name |
| `projectRoot` | string | No | Project root directory |

---

### 20. `cmos_session_list`

Lists sessions with filtering (see #8 above for full details).

---

## CMOS Tools - Sprint Management

### 21. `cmos_sprint_list`

Lists sprints with mission counts.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status (e.g., "Active") |
| `limit` | number | No | Max results (default: 20, max: 100) |
| `projectRoot` | string | No | Project root directory |

**Returns:**

```typescript
{
  sprints: Array<{
    id: string;
    title: string;
    focus: string | null;
    status: string | null;
    missionCounts: {
      total: number;
      completed: number;
      blocked: number;
      active: number;
    };
  }>;
}
```

---

### 22. `cmos_sprint_show`

Gets sprint details with all missions.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sprintId` | string | Yes | Sprint ID (e.g., "sprint-14") |
| `projectRoot` | string | No | Project root directory |

---

### 23. `cmos_sprint_add`

Creates a new sprint.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sprintId` | string | Yes | Unique sprint ID |
| `title` | string | Yes | Sprint title |
| `focus` | string | No | Strategic focus |
| `status` | string | No | Status (default: "Active") |
| `startDate` | string | No | Start date (ISO format) |
| `endDate` | string | No | End date (ISO format) |
| `projectRoot` | string | No | Project root directory |

---

### 24. `cmos_sprint_update`

Updates sprint fields.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sprintId` | string | Yes | Sprint ID to update |
| `fields` | SprintUpdateFields | Yes | Fields to update |
| `projectRoot` | string | No | Project root directory |

---

## CMOS Tools - Mission Creation

### 25. `cmos_mission_add`

Creates a new mission in database.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionId` | string | Yes | Mission ID (e.g., "s14-m05") |
| `name` | string | Yes | Display name |
| `sprintId` | string | Yes | Must reference existing sprint |
| `objective` | string | No | Mission objective |
| `context` | string \| object | No | Background context |
| `status` | MissionStatus | No | Initial status (default: Queued) |
| `successCriteria` | string[] | No | Success conditions |
| `deliverables` | string[] | No | Expected outputs |
| `referenceDocs` | string[] | No | Reference documentation |
| `domainFields` | object | No | Domain-specific fields |
| `notes` | string | No | Additional notes |
| `projectRoot` | string | No | Project root directory |

---

### 26. `cmos_mission_depends`

Creates dependency between missions.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fromId` | string | Yes | Dependent mission ID |
| `toId` | string | Yes | Dependency mission ID |
| `type` | DependencyType | Yes | Dependency type |
| `projectRoot` | string | No | Project root directory |

**Dependency Types:**

- `Blocks`: A blocks B from starting
- `Requires`: A requires B to be completed first
- `Enables`: A enables B to proceed

---

## CMOS Tools - Agent Utilities

### 27. `cmos_agent_onboard`

Gets aggregated onboarding payload for agent cold-start.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectRoot` | string | No | Project root directory |

**Returns:** (Optimized for <4KB context windows)

```typescript
{
  project: { name: string; description: string; status: string; };
  currentSprint: { id: string; title: string; focus: string; status: string; };
  activeSession: SessionSummary | null;
  pendingMissions: PendingMissionSummary[];
  blockedMissions: PendingMissionSummary[];
  recentDecisions: RecentDecisionSummary[];
  nextSteps: string[];
  suggestedActions: SuggestedAction[];
  sessionStats: { totalSessions: number; lastActivity: string; };
}
```

---

### 28. `cmos_decisions_list`

Lists strategic decisions with filtering.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | string | No | Filter by domain |
| `sprintId` | string | No | Filter by sprint |
| `since` | string | No | ISO date filter (after) |
| `until` | string | No | ISO date filter (before) |
| `page` | number | No | Page number |
| `pageSize` | number | No | Results per page |
| `projectRoot` | string | No | Project root directory |

---

### 29. `cmos_decisions_search`

Searches decisions by keyword.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keywords |
| `domain` | string | No | Filter by domain |
| `sprintId` | string | No | Filter by sprint |
| `limit` | number | No | Max results (default: 20, max: 50) |
| `projectRoot` | string | No | Project root directory |

---

## CMOS Tools - Administrative

### 30. `cmos_db_health`

Checks database connectivity and health.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectRoot` | string | No | Project root directory |

**Returns:**

```typescript
{
  connected: boolean;
  version: string;           // SQLite version
  path: string;              // Database file path
  tables: string[];          // Table names
  missionCount: number;
  sessionCount: number;
  contextCount: number;
  lastMissionActivity: string;
  lastSessionActivity: string;
  lastContextUpdate: string;
  fileSizeBytes: number;
  walModeEnabled: boolean;
}
```

---

## Common Types

### MissionStatus

```typescript
type MissionStatus = 'Queued' | 'Current' | 'In Progress' | 'Completed' | 'Blocked';
```

### State Transitions

```typescript
const VALID_STATE_TRANSITIONS = {
  Queued: ['Current', 'In Progress'],
  Current: ['In Progress', 'Blocked'],
  'In Progress': ['Completed', 'Blocked'],
  Completed: [], // Terminal
  Blocked: ['In Progress', 'Current'],
};
```

### SessionType

```typescript
type SessionType = 'onboarding' | 'planning' | 'review' | 'research' | 'check-in' | 'custom';
```

### CaptureCategory

```typescript
type CaptureCategory = 'decision' | 'learning' | 'constraint' | 'context' | 'next-step';
```

---

## Related Documents

- [Architecture](./cmos-mcp-architecture.md) - System architecture and components
- [Design Patterns](./cmos-mcp-patterns.md) - Code patterns and conventions
