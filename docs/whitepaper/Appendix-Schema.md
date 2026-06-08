# Appendix: SQLite Schema Summary

This appendix summarizes the CMOS SQLite schema. The canonical schema lives at:

- `cmos-seed/db/schema.sql`

## Core Tables

metadata

- key (primary key)
- value
- Typical keys: project_id, project_name, tracelab_project_id, created_at

sprints

- id, title, focus, status, start_date, end_date
- total_missions, completed_missions (summary fields)

missions

- id, sprint_id, name, status, completed_at, notes
- objective, context
- success_criteria, deliverables, reference_docs (JSON arrays)
- domain_fields (JSON)
- metadata (legacy JSON)

mission_dependencies

- from_id, to_id, type
- models Blocks/Requires/Enables relationships

contexts

- id, source_path, content, updated_at
- stores project_context and master_context JSON

context_snapshots

- id, context_id, session_id, source, content_hash, content, created_at
- append-only historical timeline of master context updates

sessions

- id, type, title, sprint_id, started_at, completed_at, agent, summary
- status, captures (JSON), next_steps (JSON), metadata (JSON)

session_events

- id, ts, agent, mission, action, status, summary, next_hint, raw_event
- append-only log of mission and session events

strategic_decisions

- id, context_id, decision_text, created_at
- sprint_id, snapshot_id, project_domain

telemetry_events

- id, mission, source_path, ts, payload

prompt_mappings

- id, prompt, behavior

## Views

active_missions

- join of missions and sprints where status is Current or In Progress

mission_details

- mission details with sprint metadata for quick inspection

sprint_summary

- aggregate counts for missions and decisions per sprint

## Notes

- SQLite is the source of truth; file exports are views
- JSON fields are serialized as TEXT in SQLite
- Foreign keys are enforced; WAL mode is enabled in the MCP client
