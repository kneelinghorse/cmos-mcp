# rbook/ — this project's record

This folder holds the project's record, kept by Reasonbook at the **Planner** level: decisions, lessons,
and the tasks and next steps the project is working through.

- `db/rbook.sqlite` is the record, and `db/schema.sql` describes its tables.
- `context/` holds the context the record started from.
- `tiers/managed.md` tells an agent how to work at this level; `tiers/general.md` is the Ledger
  level's guide.
- `templates/` holds the templates the project's `AGENTS.md` and `CLAUDE.md` came from.

Agents keep the record through Reasonbook's tools, so these files need no editing by hand. When the work
needs structured engineering planning, the Builder level adds it, and nothing recorded is lost:
`rbook_project(action="update", projectType="build")`.
