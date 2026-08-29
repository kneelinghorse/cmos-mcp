# SQLite Schema Reference

**Database**: `cmos/db/cmos.sqlite`  
**Schema**: `cmos/db/schema.sql`

Quick reference for querying CMOS history using any SQLite client.

---

## Core Tables

| Table                  | Purpose                                  | Key Columns                                                  |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `metadata`             | Project identity and schema markers      | `key`, `value`                                               |
| `sprints`              | Sprint registry                          | `id`, `title`, `status`, `start_date`, `end_date`            |
| `missions`             | Mission backlog with status              | `id`, `sprint_id`, `name`, `status`, `completed_at`, `notes` |
| `mission_dependencies` | Edges between missions                   | `from_id`, `to_id`, `type`                                   |
| `contexts`             | JSON payloads for project/master context | `id`, `content`, `updated_at`                                |
| `context_snapshots`    | Historical context versions              | `context_id`, `content`, `created_at`, `content_hash`        |
| `sessions`             | Universal session registry               | `id`, `type`, `sprint_id`, `started_at`, `status`            |
| `session_missions`     | Session-to-mission links                 | `session_id`, `mission_id`                                   |
| `session_events`       | Project activity/event log               | `ts`, `agent`, `mission`, `action`, `status`, `summary`      |
| `telemetry_events`     | Runtime metrics and health signals       | `mission`, `source_path`, `ts`, `payload`                    |
| `strategic_decisions`  | Durable decision records                 | `id`, `sprint_id`, `mission_id`, `decision`, `status`        |
| `learnings`            | Durable learning records                 | `id`, `sprint_id`, `mission_id`, `content`, `status`         |
| `next_steps`           | Action items from sessions and missions  | `id`, `sprint_id`, `mission_id`, `content`, `status`         |
| `constraints`          | Project constraints and review state     | `id`, `content`, `status`, `content_hash`                    |
| `sync_event_queue`     | Outbound synchronization queue           | `id`, `event_type`, `envelope`, `status`                     |
| `prompt_mappings`      | Prompt → behavior mapping                | `prompt`, `behavior`                                         |

**Views**:

- `project_identity` - Stable project identity and schema markers
- `active_missions` - Convenience projection for current work
- `mission_details` - Missions joined to sprint titles and extended fields
- `sprint_summary` - Dynamically calculated mission and decision counts

Runtime migrations may add tables such as `agent_feedback` and optional search/vector structures.

---

## Useful Queries

### Mission Counts by Sprint

```sql
SELECT sprint_id, status, COUNT(*) as count
FROM missions
GROUP BY sprint_id, status
ORDER BY sprint_id IS NULL,
         CASE
           WHEN sprint_id GLOB 'sprint-[0-9]*'
            AND substr(sprint_id, 8) NOT GLOB '*[^0-9]*'
           THEN CAST(substr(sprint_id, 8) AS INTEGER)
         END DESC,
         sprint_id COLLATE BINARY DESC,
         status;
```

### Find Open Missions

```sql
SELECT id, name, status, completed_at
FROM missions
WHERE status IN ('Current', 'In Progress', 'Queued')
ORDER BY CASE status
           WHEN 'In Progress' THEN 1
           WHEN 'Current' THEN 2
           WHEN 'Queued' THEN 3
           ELSE 4
         END,
         id;
```

### View Sprint Progress

```sql
SELECT sprint_id AS id, title,
       completed_missions || '/' || total_missions as progress,
       status, blocked_missions, active_missions
FROM sprint_summary
ORDER BY start_date DESC, sprint_id COLLATE BINARY DESC;
```

### Get Recent Activity Events

```sql
SELECT ts, mission, action, status, summary
FROM session_events
ORDER BY ts DESC
LIMIT 10;
```

### Review Planning/Onboarding Sessions

```sql
SELECT id, type, title, started_at, completed_at, status
FROM sessions
WHERE type IN ('planning', 'onboarding')
ORDER BY started_at DESC
LIMIT 10;
```

### List Mission Rows for a Sprint

```sql
SELECT id, name, status, completed_at, notes
FROM missions
WHERE sprint_id = 'sprint-05'
ORDER BY id;
```

### Check Context Updates

```sql
SELECT id, updated_at,
       LENGTH(content) as size_bytes
FROM contexts
ORDER BY updated_at DESC;
```

### View Context History

```sql
SELECT created_at, session_id, source,
       LENGTH(content) as size_bytes
FROM context_snapshots
WHERE context_id = 'master_context'
ORDER BY created_at DESC
LIMIT 5;
```

---

## Accessing the Database

Use any SQLite client:

**Command line**:

```bash
sqlite3 cmos/db/cmos.sqlite

# Run query
sqlite3 cmos/db/cmos.sqlite "SELECT * FROM sprints;"

# Interactive mode
sqlite3 cmos/db/cmos.sqlite
> .tables
> .schema missions
> SELECT * FROM missions LIMIT 5;
```

**GUI tools** (any will work):

- DB Browser for SQLite
- DBeaver
- TablePlus
- DataGrip
- VS Code SQLite extension
- etc.

All standard SQLite tools work for reads without special configuration.

---

## Schema Details

See `cmos/db/schema.sql` for the shipped base schema including:

- Table definitions with foreign keys
- Indexes for query performance
- Views for common queries
- Constraints and defaults

---

## Maintenance Queries

### Compact Database

Back up the database and stop the MCP server (or otherwise ensure there are no active writers)
before running `VACUUM`.

```sql
VACUUM;
```

### Check Database Size

```sql
SELECT page_count * page_size as size_bytes
FROM pragma_page_count(), pragma_page_size();
```

### Verify Foreign Keys

```sql
PRAGMA foreign_key_check;
```

### List All Tables

```sql
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name NOT LIKE 'sqlite_%'
ORDER BY name;
```

---

**Last Updated**: 2026-08-28
**Replaces**: `sqlite-db-browser-guide.md` (tool-agnostic version)
