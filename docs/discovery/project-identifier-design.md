# Project Identifier Schema & TraceLab Linking

**Mission**: s15-m05
**Date**: 2025-12-27
**Status**: Complete

## Overview

This document describes the project identifier design for CMOS, enabling unique project identification and TraceLab cross-referencing.

---

## 1. Design Decision

### Approach: Metadata-Based Project Identity

Project identity is stored in the `metadata` table using standard keys:

```sql
-- Standard metadata keys for project identity
project_id           -- UUID or slug uniquely identifying this project
project_name         -- Human-readable project name
tracelab_project_id  -- UUID of linked TraceLab project
created_at           -- ISO timestamp of project initialization
```

### Rationale

| Approach                 | Pros                                      | Cons                        | Decision     |
| ------------------------ | ----------------------------------------- | --------------------------- | ------------ |
| Metadata table           | Simple, backward compatible, no migration | Single project per DB       | **Selected** |
| Dedicated projects table | Multi-project support                     | Complex, requires migration | Not selected |
| Project FK on all tables | Full isolation                            | Major schema change         | Not selected |

**One project per CMOS database** is the intentional design. This matches the deployment pattern where each project has its own `cmos/db/cmos.sqlite` file.

---

## 2. Schema Changes

### Updated metadata Table

```sql
-- Project-level metadata
-- Standard keys:
--   project_id: UUID or slug uniquely identifying this CMOS project
--   project_name: Human-readable project name
--   tracelab_project_id: UUID of linked TraceLab project
--   created_at: ISO timestamp when project was initialized
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Initialize standard metadata keys (no-op if already exists)
INSERT OR IGNORE INTO metadata (key, value) VALUES ('project_id', '');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('project_name', '');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('tracelab_project_id', '');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', datetime('now'));
```

### New View: project_identity

```sql
-- Project identity view for easy access to project-level metadata
CREATE VIEW IF NOT EXISTS project_identity AS
SELECT
  (SELECT value FROM metadata WHERE key = 'project_id') AS project_id,
  (SELECT value FROM metadata WHERE key = 'project_name') AS project_name,
  (SELECT value FROM metadata WHERE key = 'tracelab_project_id') AS tracelab_project_id,
  (SELECT value FROM metadata WHERE key = 'created_at') AS created_at;
```

---

## 3. Project Identifier Format

### UUID (Recommended)

```
ef13d67b-3f19-4d19-8c69-f689becd29c9
```

- Compatible with TraceLab project IDs
- Globally unique
- No collision risk

### Slug (Alternative)

```
cmos-mcp
my-awesome-project
```

- Human-readable
- URL-safe
- Must be manually coordinated for uniqueness

### Recommendation

Use **UUID** as `project_id` for TraceLab compatibility. Use `project_name` for human-readable identification.

---

## 4. TraceLab Linking Strategy

### Same ID Strategy (Recommended)

Use the same UUID for both CMOS `project_id` and TraceLab `project_id`:

```
CMOS project_id:      ef13d67b-3f19-4d19-8c69-f689becd29c9
TraceLab project_id:  ef13d67b-3f19-4d19-8c69-f689becd29c9
```

**Benefits**:

- Direct cross-reference with no mapping table
- Simple queries: `WHERE project_id = '...'`
- No synchronization needed

**When to use**: New projects where you create TraceLab project first.

### Cross-Reference Strategy

Store separate IDs with explicit linking:

```
CMOS project_id:           cmos-mcp (slug)
CMOS tracelab_project_id:  ef13d67b-3f19-4d19-8c69-f689becd29c9
```

**Benefits**:

- Works with existing projects
- Allows different ID formats
- Explicit relationship

**When to use**: Existing projects linking to existing TraceLab projects.

### Linking Workflow

```
1. Create TraceLab project (if not exists)
   → tracelab_create_project(name="My Project")
   → Returns: project_id = "ef13d67b-..."

2. Set CMOS project identity
   → UPDATE metadata SET value = 'ef13d67b-...' WHERE key = 'project_id';
   → UPDATE metadata SET value = 'My Project' WHERE key = 'project_name';
   → UPDATE metadata SET value = 'ef13d67b-...' WHERE key = 'tracelab_project_id';

3. Cross-reference is now established
   → CMOS can scope TraceLab searches to linked project
   → TraceLab reports can reference CMOS missions
```

---

## 5. Initialization Workflow

### New Project (Recommended)

```python
# On first CMOS database creation
import uuid

project_id = str(uuid.uuid4())
project_name = input("Project name: ")

# If TraceLab integration desired
tracelab_result = tracelab_create_project(name=project_name)
tracelab_project_id = tracelab_result.project_id

# Store in CMOS
db.execute("UPDATE metadata SET value = ? WHERE key = 'project_id'", [project_id])
db.execute("UPDATE metadata SET value = ? WHERE key = 'project_name'", [project_name])
db.execute("UPDATE metadata SET value = ? WHERE key = 'tracelab_project_id'", [tracelab_project_id])
```

### Existing Project

```python
# Linking existing CMOS to existing TraceLab project
tracelab_project_id = "ef13d67b-..."  # Get from TraceLab

# Generate CMOS project_id if not set
project_id = db.fetchone("SELECT value FROM metadata WHERE key = 'project_id'")[0]
if not project_id:
    project_id = str(uuid.uuid4())
    db.execute("UPDATE metadata SET value = ? WHERE key = 'project_id'", [project_id])

# Link TraceLab
db.execute("UPDATE metadata SET value = ? WHERE key = 'tracelab_project_id'", [tracelab_project_id])
```

---

## 6. MCP Tool Integration

### Enhanced cmos_agent_onboard

Include project identity in onboard payload:

```typescript
{
  project: {
    id: "ef13d67b-...",
    name: "CMOS Starter Template",
    tracelab_project_id: "ef13d67b-...",
    created_at: "2025-11-01T00:00:00Z"
  },
  currentSprint: { ... },
  pendingMissions: [...],
  ...
}
```

### New Tool: cmos_project_init

```typescript
{
  name: "cmos_project_init",
  parameters: {
    projectName: string,          // Required: Human-readable name
    projectId?: string,           // Optional: UUID, generated if not provided
    tracelabProjectId?: string,   // Optional: Link to TraceLab project
    createTracelabProject?: boolean  // Optional: Create TraceLab project with same ID
  },
  returns: {
    projectId: string,
    projectName: string,
    tracelabProjectId: string | null,
    createdAt: string
  }
}
```

### Query Project Identity

```typescript
// Simple query via view
const identity = db.getOne('SELECT * FROM project_identity');
// Returns: { project_id, project_name, tracelab_project_id, created_at }
```

---

## 7. Backward Compatibility

### Existing Databases

Existing CMOS databases will have empty `project_id`, `project_name`, and `tracelab_project_id` values after schema migration:

```sql
-- After schema update, metadata will contain:
project_id = ''
project_name = ''
tracelab_project_id = ''
created_at = '2025-12-27T...'  -- Set to migration time
```

### Migration Path

1. Schema update adds INSERT OR IGNORE statements
2. Empty values indicate "not yet initialized"
3. Agent can detect empty values and prompt for initialization
4. No existing data affected

### Detection

```sql
-- Check if project is initialized
SELECT value FROM metadata WHERE key = 'project_id';
-- Empty string = not initialized
-- Non-empty = initialized
```

---

## 8. Usage Examples

### Check Project Identity

```sql
SELECT * FROM project_identity;
-- Returns:
-- project_id | project_name | tracelab_project_id | created_at
-- ef13d67b.. | CMOS MCP     | ef13d67b..         | 2025-12-27...
```

### Set Project Identity

```sql
UPDATE metadata SET value = 'ef13d67b-3f19-4d19-8c69-f689becd29c9'
WHERE key = 'project_id';

UPDATE metadata SET value = 'My Awesome Project'
WHERE key = 'project_name';
```

### Link TraceLab Project

```sql
UPDATE metadata SET value = 'ef13d67b-3f19-4d19-8c69-f689becd29c9'
WHERE key = 'tracelab_project_id';
```

### Scope TraceLab Searches

```python
# Get linked TraceLab project
tracelab_id = db.fetchone(
    "SELECT value FROM metadata WHERE key = 'tracelab_project_id'"
)[0]

# Search only in linked project
results = tracelab_search_knowledge(
    query="integration patterns",
    project_id=tracelab_id
)
```

---

## 9. Future Considerations

### Multi-Project Support

If multi-project support is needed in the future:

1. Add `projects` table with full project metadata
2. Add `project_id` foreign key to `sprints`, `missions`, `sessions`
3. Update all queries to filter by project
4. Maintain backward compatibility via default project

This is NOT implemented now but the metadata approach does not prevent future expansion.

### Project Archiving

Projects can be archived by setting metadata:

```sql
INSERT OR REPLACE INTO metadata (key, value)
VALUES ('project_status', 'archived');
```

### Project Cloning

For project templates, copy database and regenerate `project_id`:

```bash
cp cmos/db/cmos.sqlite new-project/cmos/db/cmos.sqlite
sqlite3 new-project/cmos/db/cmos.sqlite "UPDATE metadata SET value = '$(uuidgen)' WHERE key = 'project_id'"
```

---

## 10. Summary

| Aspect           | Design                                               |
| ---------------- | ---------------------------------------------------- |
| Storage          | `metadata` table with standard keys                  |
| ID Format        | UUID (recommended) or slug                           |
| TraceLab Linking | Same ID or cross-reference via `tracelab_project_id` |
| Initialization   | On first run or explicit init                        |
| Backward Compat  | Empty values for existing projects                   |
| Multi-Project    | One project per database (by design)                 |

The design prioritizes simplicity and backward compatibility while enabling TraceLab integration for research-to-build traceability.
