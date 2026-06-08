# Appendix: Tool Catalog Summary

This appendix summarizes the tools exposed by CMOS-MCP. For full parameter definitions, see:

- `cmos/docs/mcp-reference.md`
- `docs/discovery/cmos-mcp-tool-catalog.md`

## Mission Protocol Tools (Authoring Layer)

Always available

- get_available_domains: list domain packs
- create_mission: generate mission YAML or JSON

Extended (unless MISSION_PROTOCOL_SLIM_MODE=1)

- get_mission_quality_score: assess mission quality
- create_mission_splits: decompose complex missions

## CMOS Tools (Execution Layer)

Database reads

- cmos_mission_list
- cmos_mission_show
- cmos_mission_status
- cmos_session_list

Lifecycle mutations

- cmos_mission_start
- cmos_mission_complete
- cmos_mission_block
- cmos_mission_unblock
- cmos_mission_update

Context operations

- cmos_context_view
- cmos_context_snapshot
- cmos_context_history

Session management

- cmos_session_start
- cmos_session_capture
- cmos_session_complete

Sprint management

- cmos_sprint_list
- cmos_sprint_show
- cmos_sprint_add
- cmos_sprint_update

Mission creation

- cmos_mission_add
- cmos_mission_depends

Agent utilities

- cmos_agent_onboard
- cmos_decisions_list
- cmos_decisions_search

Administrative

- cmos_db_health

## Implemented but Not Registered (Internal/Planned)

These tools exist in code but are not registered in the MCP tool list.
They are candidates for future exposure.

- cmos_backlog_export: export missions to YAML or JSON
- cmos_project_init: MCP-based project seeding
- cmos_context_update: structured context updates with snapshots
- cmos_session_search: session search utility
- cmos_resolve_references: resolve TraceLab references in missions

## Response Pattern

All CMOS tools return a structured result for deterministic agent behavior:

```
{
  "success": true|false,
  "data": { ... },
  "error": {
    "code": "...",
    "message": "...",
    "suggestion": "...",
    "valid_values": [ ... ],
    "current_state": "..."
  },
  "warnings": [ ... ]
}
```
